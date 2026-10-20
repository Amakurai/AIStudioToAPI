/**
 * File: src/core/RequestHandler/RetryHandler.js
 * Description: Immediate status retries and queued request retry execution.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AntiTruncation = require("../AntiTruncation");

const ConnectionHandler = require("./ConnectionHandler");
const { isUserAbortedError } = require("../../utils/CustomErrors");
const { QueueTimeoutError } = require("../../utils/MessageQueue");

class RetryHandler extends ConnectionHandler {
    /**
     * Start recursively scheduled SSE keep-alive writes.
     * @param {object} res
     * @param {string} frame
     * @param {() => void} initializeResponse
     * @param {(timer: any) => void} updateTimer
     */
    _startSseKeepAlive(res, frame, initializeResponse, updateTimer) {
        const scheduleNextKeepAlive = () => {
            const randomInterval = 12000 + Math.floor(Math.random() * 6000);
            const timer = setTimeout(() => {
                if (!res.headersSent) initializeResponse();
                if (!res.writableEnded) {
                    res.write(frame);
                    scheduleNextKeepAlive();
                }
            }, randomInterval);
            updateTimer(timer);
        };

        scheduleNextKeepAlive();
    }

    _prepareGenerationProxyRequest({ googleBody, isStreaming, model, modelStreamingMode, requestId, res }) {
        const effectiveStreamMode = modelStreamingMode || this.config.streamingMode;
        const useRealStream =
            isStreaming &&
            effectiveStreamMode === "real" &&
            (!AntiTruncation.baseModel(model) || AntiTruncation.requiresOriginalModel(googleBody));
        const streamMode = useRealStream ? "real" : "fake";
        const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
        const proxyRequest = {
            body: JSON.stringify(googleBody),
            headers: { "Content-Type": "application/json" },
            is_generative: true,
            method: "POST",
            path: `/v1beta/models/${model}:${googleEndpoint}`,
            query_params: useRealStream ? { alt: "sse" } : {},
            request_id: requestId,
            streaming_mode: streamMode,
        };

        this._initializeProxyRequestAttempt(proxyRequest);
        const responseStreamMode = this._prepareAntiTruncationStream(proxyRequest, isStreaming) || streamMode;
        res.__proxyResponseStreamMode = isStreaming ? responseStreamMode : null;
        this._updateTrackedRequest(requestId, {
            isStreaming,
            model,
            path: proxyRequest.path,
            requestCategory: "generation",
            ...(isStreaming ? { streamMode: responseStreamMode } : {}),
        });

        return { proxyRequest, useRealStream };
    }

    /**
     * Streaming alias responses follow ANTI_TRUNCATION_STREAMING_MODE instead of STREAMING_MODE; their
     * upstream rounds are always non-streaming. In real mode the forwarder publishes each accepted
     * segment on the request queue. Returns the client stream mode, or null for other requests.
     */
    _prepareAntiTruncationStream(proxyRequest, isStreaming) {
        if (!isStreaming || !proxyRequest.anti_truncation) return null;
        const mode = this.config.antiTruncationStreamingMode === "fake" ? "fake" : "real";
        proxyRequest.anti_truncation_segments = mode === "real";
        return mode;
    }

    /**
     * Until the first byte is sent the response status is still open, so an empty or failed reply
     * becomes an HTTP error instead of an empty 200 stream. Returns
     * `{ message, status }` for a Gemini body without output, or null when it has output.
     */
    _noOutputError(body) {
        let response = body;
        if (typeof body === "string") {
            try {
                response = JSON.parse(body.startsWith("data: ") ? body.slice(6) : body);
            } catch {
                return { message: "Upstream returned an incomplete or invalid response.", status: 502 };
            }
        }
        if (response?.error) {
            return {
                message: response.error.message || "Upstream generation failed.",
                status: Number(response.error.code) || 502,
            };
        }
        const blockReason = response?.promptFeedback?.blockReason;
        if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED")
            return { message: `Upstream blocked the prompt (${blockReason}).`, status: 400 };
        const candidate = response?.candidates?.[0];
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        // Thinking alone is not a reply; text, tool calls and media are.
        const hasOutput = parts.some(
            part =>
                part &&
                part.thought !== true &&
                (typeof part.text === "string"
                    ? part.text.trim().length > 0
                    : Object.keys(part).some(key => key !== "thought" && key !== "thoughtSignature"))
        );
        if (hasOutput) return null;
        return {
            message: `Upstream returned no output (finishReason=${candidate?.finishReason ?? "none"}).`,
            status: 502,
        };
    }

    /** True when a raw Gemini response or SSE chunk carries any reply text, thought, tool call or media. */
    _hasGoogleOutput(data) {
        return (
            /"text"\s*:\s*"(?!")/.test(data) ||
            /"(?:functionCall|inlineData|fileData|executableCode|codeExecutionResult)"\s*:/.test(data)
        );
    }

    /** Answers a request that failed before any output with a plain HTTP error. */
    _failBeforeOutput(res, failure, label, requestId) {
        this.logger.error(`❌ [Request] ${label} failed: ${failure.message}, request ID: ${requestId}`);
        this._markTrackedResponseError(res, failure.message, failure.status);
        if (this._isResponseWritable(res)) this._sendErrorResponse(res, failure.status, failure.message);
    }

    /**
     * Collects a whole buffered (fake-stream or non-stream) body before anything is sent to the client.
     * An upstream error or a reply without output is answered with a plain HTTP error and null is
     * returned; queue timeouts and closed queues are thrown to the caller, whose error handler also
     * answers with HTTP status.
     */
    async _collectBufferedBody(queue, res, label, requestId) {
        let body = "",
            failure = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const message = await queue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") break;
            if (message.event_type === "error") {
                failure = { message: message.message, status: this._getUpstreamErrorStatus(message) };
                break;
            }
            if (message.event_type === "chunk" && message.data) body += message.data;
        }
        failure ||= this._noOutputError(body);
        if (!failure) return body;
        this._failBeforeOutput(res, failure, label, requestId);
        return null;
    }

    /**
     * Holds the start of a real stream until the first upstream chunk with output, so clients see
     * no empty reply (and relays measure the first token) only once text exists, and a stream that
     * fails or ends without output still gets a plain HTTP error. `push(googleData, translated)`
     * returns what to write now; `failure()` describes a stream that ended without output.
     */
    _createRealStreamGate() {
        let pending = "",
            raw = "",
            open = false;
        return {
            failure: () => {
                // The last complete Gemini event explains the empty reply (block or finish reason).
                const events = raw
                    .split(/\r?\n/)
                    .filter(line => line.startsWith("data: "))
                    .map(line => line.slice(6));
                return (
                    (events.length && this._noOutputError(events.at(-1))) ||
                    this._noOutputError(raw.trim() || "{}") || {
                        message: "Upstream returned no output.",
                        status: 502,
                    }
                );
            },
            get open() {
                return open;
            },
            push: (googleData, translated) => {
                if (open) return translated || "";
                pending += translated || "";
                raw += googleData;
                if (!this._hasGoogleOutput(raw)) return "";
                open = true;
                const held = pending;
                pending = raw = "";
                return held;
            },
        };
    }

    /**
     * Writes a streaming alias response, starting with the first queue message returned by
     * `_executeRequestWithRetries`. Real mode sends each accepted segment as it arrives; fake mode
     * receives the finished answer and sends it at once, reasoning first. `startStream()` sets the
     * SSE headers and is called right before the first write, so a failure or an empty answer before
     * any text still gets a plain HTTP error and clients show no empty reply while the model thinks.
     * `write(googleChunk)` writes one Gemini stream chunk in the client's format; the last one has no
     * text and carries the finish reason and usage. `heartbeat` is written between later segments.
     */
    async _streamAntiTruncationResponse(proxyRequest, firstMessage, queue, res, startStream, write, heartbeat) {
        let keepAlive;
        try {
            await this._writeAntiTruncationStream(proxyRequest, firstMessage, queue, res, chunk => {
                if (!res.headersSent) {
                    startStream();
                    this._startSseKeepAlive(res, heartbeat, startStream, timer => {
                        keepAlive = timer;
                    });
                }
                write(chunk);
            });
        } finally {
            clearTimeout(keepAlive);
        }
    }

    async _writeAntiTruncationStream(proxyRequest, firstMessage, queue, res, send) {
        const requestId = proxyRequest.request_id;
        // A leading thinking block arrives as reasoning pieces and is sent as Gemini thought parts.
        const textChunk = (text, thought) => ({
            candidates: [
                { content: { parts: [thought ? { text, thought: true } : { text }], role: "model" }, index: 0 },
            ],
        });
        const streamed = { answer: "", reasoning: "" };
        let message = firstMessage,
            body = "",
            seq = 0,
            response;
        try {
            while (message.type !== "STREAM_END") {
                if (message.event_type === "error")
                    throw Object.assign(new Error(message.message), { status: message.status });
                if (message.event_type === "tool_output") {
                    if (message.seq !== seq + 1)
                        throw AntiTruncation.protocolError("non-contiguous published sequence.");
                    seq = message.seq;
                    streamed[message.thought ? "reasoning" : "answer"] += message.text;
                    if (!this._isResponseWritable(res)) return;
                    send(textChunk(message.text, message.thought));
                } else if (message.event_type === "chunk") body += message.data || "";
                message = await queue.dequeue(AntiTruncation.maxWaitMs(this.timeouts.FAKE_STREAM));
            }
            response = JSON.parse(body);
        } catch (error) {
            // Until text reaches the client the usual stream error applies. Afterwards the delivered
            // text stands and the answer ends as incomplete instead of being replayed.
            if (!seq || !this._isResponseWritable(res)) {
                this._handleRequestError(error, res, requestId);
                return;
            }
            this.logger.warn(
                `[AntiTruncation] ${requestId}: stream interrupted after ${seq} published piece(s) (${error.message}); ending it as incomplete.`
            );
            const parts = [{ text: streamed.reasoning, thought: true }, { text: streamed.answer }];
            response = { candidates: [{ content: { parts }, finishReason: "MAX_TOKENS" }], usageMetadata: {} };
        }
        const candidate = response.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        if (!seq) {
            const outputError = this._noOutputError(response);
            if (outputError) {
                this.logger.warn(`[AntiTruncation] ${requestId}: ${outputError.message}`);
                this._markTrackedResponseError(res, outputError.message, outputError.status);
                this._sendErrorResponse(res, outputError.status, outputError.message);
                return;
            }
        }
        for (const thought of [true, false]) {
            const sent = streamed[thought ? "reasoning" : "answer"];
            const text = parts
                .filter(part => (part.thought === true) === thought)
                .map(part => part.text || "")
                .join("");
            // Published pieces always start the final text; only text that was never published is sent here.
            if (!text.startsWith(sent)) {
                this.logger.warn(`[AntiTruncation] ${requestId}: final text differs from the streamed segments.`);
                continue;
            }
            const rest = text.slice(sent.length);
            if (!rest) continue;
            if (!this._isResponseWritable(res)) return;
            send(textChunk(rest, thought));
        }
        if (!this._isResponseWritable(res)) return;
        send({
            candidates: [{ content: { parts: [], role: "model" }, finishReason: candidate?.finishReason }],
            usageMetadata: response.usageMetadata,
        });
        this.logger.info(
            `✅ [Request] Anti-truncation stream completed: reason=${candidate?.finishReason}, pieces=${seq}, request ID: ${requestId}`
        );
    }

    _dispatchProxyRequestForFirstMessage(proxyRequest, requestId, res) {
        const messageQueue = this.connectionRegistry.createMessageQueue(
            requestId,
            this._selectDispatchAuthIndex(),
            proxyRequest.request_attempt_id
        );
        const messageQueueAuthIndex =
            this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
        this._setupClientDisconnectHandler(res, requestId);

        this._getUsageStatsService()?.recordAttempt(
            requestId,
            messageQueueAuthIndex,
            this._getAccountNameForIndex(messageQueueAuthIndex)
        );
        this._forwardRequest(proxyRequest, messageQueueAuthIndex);

        return {
            firstMessage: messageQueue.dequeue(),
            messageQueue,
        };
    }

    /**
     * Malformed or oversized requests (e.g. token limit exceeded) fail the same way on every account:
     * retrying them only repeats upstream calls, and counting them would rotate healthy accounts.
     * Invalid API keys are account-specific and keep the normal handling.
     */
    _isDeterministicClientError(errorDetails, path = null) {
        const status = Number(errorDetails?.status);
        if (status === 404) return this._categorizeRequest(path, "request") === "embedding";
        if (status !== 400 && status !== 413) return false;
        return !/API_KEY_INVALID|API key not valid/i.test(String(errorDetails?.message ?? ""));
    }

    /**
     * A 429 with `limit: 0` means this account's tier has no quota for the model at all. It is not a
     * rate limit: cooling, switching or rebalancing the account would take it away from every other
     * model without making this one available. Only another account can serve the request.
     */
    _isZeroQuotaError(errorDetails) {
        return Number(errorDetails?.status) === 429 && /limit:\s*0\b/.test(String(errorDetails?.message ?? ""));
    }

    _createImmediateSwitchTracker(initialAuthIndex = this.currentAuthIndex) {
        const attemptedAuthIndices = new Set();
        if (Number.isInteger(initialAuthIndex) && initialAuthIndex >= 0) {
            attemptedAuthIndices.add(initialAuthIndex);
        }
        return { attemptedAuthIndices };
    }

    _getImmediateStatusRetryCloseReason(status) {
        return `immediate_status_retry_${status}`;
    }

    async _prepareRealStreamImmediateRetry(
        proxyRequest,
        currentQueue,
        errorDetails,
        immediateSwitchTracker,
        currentQueueAuthIndex
    ) {
        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

        const retryPrepared = await this._prepareImmediateStatusRetry(
            errorDetails,
            proxyRequest.request_id,
            immediateSwitchTracker,
            currentQueueAuthIndex
        );
        if (!retryPrepared) return null;

        const errorStatus = Number(errorDetails?.status);
        try {
            currentQueue.close(this._getImmediateStatusRetryCloseReason(errorStatus));
        } catch {
            /* empty */
        }

        this._advanceProxyRequestAttempt(proxyRequest);
        const nextQueueAuthIndex = immediateSwitchTracker.nextAuthIndex;
        const nextQueue = this.connectionRegistry.createMessageQueue(
            proxyRequest.request_id,
            nextQueueAuthIndex,
            proxyRequest.request_attempt_id
        );

        return {
            currentQueue: nextQueue,
            currentQueueAuthIndex: nextQueueAuthIndex,
        };
    }

    async _prepareImmediateStatusRetry(errorDetails, requestId, tracker, sourceAuthIndex) {
        if (errorDetails.retryable === false) return false;
        const originalQueue = this.connectionRegistry.messageQueues.get(requestId)?.queue;
        const requestIsActive = () =>
            originalQueue &&
            !originalQueue.closed &&
            this.connectionRegistry.messageQueues.get(requestId)?.queue === originalQueue;
        tracker.nextAuthIndex = null;
        if (Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0) {
            tracker.attemptedAuthIndices.add(sourceAuthIndex);
        }
        const zeroQuota = this._isZeroQuotaError(errorDetails);
        const isRateLimited = Number(errorDetails.status) === 429 && !zeroQuota;
        if (isRateLimited) {
            this.authSource.markAccountCoolingDown?.(sourceAuthIndex, this.config.rateLimitCooldownMs ?? 60000);
        }
        if (!zeroQuota) this.authSwitcher.failureCount++;
        const exclusions = () => [...tracker.attemptedAuthIndices];
        const select = () => this._selectDispatchAuthIndex(exclusions(), { allowFallback: false });

        try {
            if (!requestIsActive() || !(await this._waitForSystemReady()) || !requestIsActive()) return false;
            let nextAuthIndex = select();
            // Rotate the primary account when it failed, or initialize a standby account
            // when every ready account has already been tried by this request.
            if (!zeroQuota && (sourceAuthIndex === this.currentAuthIndex || nextAuthIndex < 0)) {
                const result = await this.authSwitcher
                    .switchToNextAuth({ excludeIndices: exclusions() })
                    .catch(error => {
                        this.logger.warn(
                            `[Request] Account replacement failed for request #${requestId}: ${error.message}`
                        );
                        return { success: false };
                    });
                if (result.success) {
                    await this._waitForSystemAndConnectionIfBusy(null, {
                        allowAnyReadyAccount: true,
                        sendError: () => {},
                    });
                } else if (this.authSwitcher.isSystemBusy) {
                    await this._waitForSystemReady();
                }
                nextAuthIndex = select();
            }
            if (!requestIsActive()) return false;
            if (!Number.isInteger(nextAuthIndex) || nextAuthIndex < 0) {
                this.logger.warn(`[Request] No untried account is ready for request #${requestId}; stopping retries.`);
                return false;
            }
            // Reserve the selected account before rebalancing can retire an otherwise idle
            // context. Both ordinary retries and anti-truncation keep the same logical queue
            // until their caller has prepared the next attempt.
            if (!this.connectionRegistry.setMessageQueueAuthIndex(requestId, nextAuthIndex, originalQueue))
                return false;
            tracker.nextAuthIndex = nextAuthIndex;
            tracker.attemptedAuthIndices.add(nextAuthIndex);
            this.logger.info(
                `[Request] Retrying request #${requestId} after ${errorDetails.status}: account #${sourceAuthIndex} -> #${nextAuthIndex}.`
            );
            return true;
        } finally {
            // Refill the dispatch pool even when the failed account was not the primary.
            if (isRateLimited && this.browserManager.rebalanceContextPool) {
                this.browserManager.rebalanceContextPool().catch(error => {
                    this.logger.warn(`[Request] Failed to rebalance accounts after rate limit: ${error.message}`);
                });
            }
        }
    }

    _logFinalRequestFailure(errorDetails, contextLabel = "Request", requestId = null, options = {}) {
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";
        const failurePhase = options.afterRetries === false ? "failed" : "failed after retries";
        this.logger.error(
            `❌ [Request] ${contextLabel} ${failurePhase}. Status code: ${errorDetails?.status || 500}, message: ${errorDetails?.message || "Unknown error"}${requestIdSuffix}`
        );
    }

    /**
     * Handle the final account-switch decision after a request failure.
     * @param {object} errorDetails
     * @param {{connectionResetContext?: string | null, skipAccountSwitch?: unknown}} [options]
     * @returns {Promise<unknown> | null}
     */
    _handleFinalFailureAccountSwitch(
        errorDetails,
        { connectionResetContext = null, skipAccountSwitch = errorDetails?.skipAccountSwitch } = {}
    ) {
        if (errorDetails?.retryable === false) return null;
        if (this._isDeterministicClientError(errorDetails)) {
            this.logger.info(
                `[Request] Client error ${errorDetails.status} does not depend on the account; skipping account switch.`
            );
            return null;
        }
        if (this._isZeroQuotaError(errorDetails)) {
            this.logger.info("[Request] Model has no quota (limit: 0) on the tried accounts; skipping account switch.");
            return null;
        }
        if (!skipAccountSwitch && !this._isConnectionResetError(errorDetails)) {
            return this.authSwitcher.handleRequestFailureAndSwitch(errorDetails, null);
        } else if (skipAccountSwitch) {
            this.logger.info("[Request] Immediate-switch retries exhausted, skipping additional account switch.");
        } else if (connectionResetContext) {
            this.logger.info(
                `[Request] Failure due to connection reset (${connectionResetContext}), skipping account switch.`
            );
        }

        return null;
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue, res = null) {
        let lastError = null;
        let currentQueue = messageQueue;
        const requestCancelled = () =>
            (res && !this._isResponseWritable(res)) ||
            currentQueue.closed ||
            this.connectionRegistry.messageQueues.get(proxyRequest.request_id)?.queue !== currentQueue;
        const cancelledResult = () => ({
            error: { message: "Request is no longer active", skipAccountSwitch: true, status: 503 },
            queue: currentQueue,
            success: false,
        });
        const registeredQueueAuthIndex = this.connectionRegistry.getAuthIndexForRequest(proxyRequest.request_id);
        // Track the authIndex registered for the current queue, which may differ from the global current account.
        let currentQueueAuthIndex =
            Number.isInteger(registeredQueueAuthIndex) && registeredQueueAuthIndex >= 0
                ? registeredQueueAuthIndex
                : this.currentAuthIndex;
        let retryAttempt = 1;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);
        // Upstream status of each account's failed attempt (by canonical account).
        const failedStatusByAccount = new Map();

        while (retryAttempt <= this.config.maxRetries) {
            // Backoff/recovery may outlive the client or the queue it owned.
            // Check before usage accounting and, critically, before upstream dispatch.
            if (requestCancelled()) return cancelledResult();
            // Record attempt at the start of each retry, before forwarding.
            // This ensures failed attempts (e.g. 429 before any response) are also counted.
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest, currentQueueAuthIndex);

                const initialMessage = await currentQueue.dequeue(
                    proxyRequest.anti_truncation
                        ? AntiTruncation.maxWaitMs(this.timeouts.FAKE_STREAM)
                        : this.timeouts.FAKE_STREAM
                );

                if (initialMessage.event_type === "timeout") {
                    throw new Error(
                        JSON.stringify({
                            event_type: "error",
                            message: "Request timed out waiting for browser response.",
                            status: 504,
                        })
                    );
                }

                if (initialMessage.event_type === "error") {
                    // Throw a structured error to be caught by the catch block
                    throw new Error(JSON.stringify(initialMessage));
                }

                // Success, return the initial message and the queue that received it
                return { message: initialMessage, queue: currentQueue, success: true };
            } catch (error) {
                // Parse the structured error message
                let errorPayload;
                try {
                    errorPayload = JSON.parse(error.message);
                } catch (e) {
                    // JSON parse failed - check if it's a timeout error
                    if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                        errorPayload = { message: error.message || "Queue timeout", status: 504 };
                    } else {
                        errorPayload = { message: error.message, status: 500 };
                    }
                }

                if (
                    errorPayload.retryable === false ||
                    (proxyRequest.anti_truncation && Number(errorPayload.status) === 400)
                ) {
                    this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                    return { error: { ...errorPayload, skipAccountSwitch: true }, queue: currentQueue, success: false };
                }

                // Stop retrying immediately if the queue is closed
                if (this._isConnectionResetError(error)) {
                    // Check the actual closure reason to provide accurate error messages
                    const reason = error.reason || "unknown";
                    const isClientDisconnect = reason === "client_disconnect";
                    const currentAuthIndex = this.currentAuthIndex;
                    const isClosedAccountRetryable = reason === "context_closed" || reason === "page_closed";
                    const canRetryOnCurrentAccountCandidate =
                        !isClientDisconnect &&
                        isClosedAccountRetryable &&
                        retryAttempt < this.config.maxRetries &&
                        Number.isInteger(currentQueueAuthIndex) &&
                        currentQueueAuthIndex >= 0 &&
                        Number.isInteger(currentAuthIndex) &&
                        currentAuthIndex >= 0 &&
                        currentQueueAuthIndex !== currentAuthIndex;

                    if (canRetryOnCurrentAccountCandidate) {
                        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                            connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                        });
                        if (!ready) {
                            lastError = {
                                message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                                status: 503,
                            };
                            break;
                        }
                    }

                    if (res && !this._isResponseWritable(res)) return cancelledResult();
                    const canRetryOnCurrentAccount =
                        canRetryOnCurrentAccountCandidate &&
                        Boolean(this.connectionRegistry.getConnectionByAuth(currentAuthIndex, false));

                    if (isClientDisconnect) {
                        this.logger.warn(`[Request] Message queue closed due to client disconnect, aborting retries.`);
                        lastError = { message: "Connection lost (client disconnect)", status: 503 };
                    } else if (canRetryOnCurrentAccount) {
                        this.logger.warn(
                            `[Request] Message queue for non-current account #${currentQueueAuthIndex} closed ` +
                                `(reason: ${reason}); retrying request #${proxyRequest.request_id} on current account #${currentAuthIndex}.`
                        );
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                        this._advanceProxyRequestAttempt(proxyRequest);
                        currentQueue = this.connectionRegistry.createMessageQueue(
                            proxyRequest.request_id,
                            currentAuthIndex,
                            proxyRequest.request_attempt_id
                        );
                        currentQueueAuthIndex = currentAuthIndex;
                        if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                            immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                        retryAttempt++;
                        continue;
                    } else {
                        // Queue closed for other reasons (account_switch, system_reset, etc.)
                        this.logger.warn(`[Request] Message queue closed (reason: ${reason}), aborting retries.`);
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                    }
                    break;
                }

                lastError = errorPayload;
                failedStatusByAccount.set(
                    this.authSource?.getCanonicalIndex?.(currentQueueAuthIndex) ?? currentQueueAuthIndex,
                    Number(errorPayload?.status)
                );
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                const errorStatus = Number(errorPayload?.status);
                if (this._isDeterministicClientError(errorPayload, proxyRequest?.path)) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    this.logger.warn(
                        `[Request] Request #${proxyRequest.request_id} failed with non-retryable client status ${errorPayload.status}; skipping retries and account switching.`
                    );
                    break;
                }

                // Check if we should stop retrying immediately based on status code
                if (
                    Number.isFinite(errorStatus) &&
                    this.config?.immediateSwitchStatusCodes?.includes(errorStatus) &&
                    !isUserAbortedError(errorPayload)
                ) {
                    this.logger.warn(`[Request] Received ${errorStatus}, preparing retry...`);
                    try {
                        const retryPrepared = await this._prepareImmediateStatusRetry(
                            errorPayload,
                            proxyRequest.request_id,
                            immediateSwitchTracker,
                            currentQueueAuthIndex
                        );
                        if (!retryPrepared) {
                            lastError = { ...errorPayload, skipAccountSwitch: true };
                            break;
                        }
                    } catch (switchError) {
                        lastError = { ...errorPayload, skipAccountSwitch: true };
                        this.logger.error(
                            `❌ [Request] Account switch failed during immediate-switch retry flow: ${switchError.message}`
                        );
                        break;
                    }

                    try {
                        currentQueue.close("retry_creating_new_queue");
                    } catch (e) {
                        this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                    }

                    // Use exactly the account reserved by the retry tracker.
                    const retryAuthIndex = immediateSwitchTracker.nextAuthIndex;
                    this.logger.debug(
                        `[Request] Creating new message queue after immediate switch for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${retryAuthIndex})`
                    );
                    this._advanceProxyRequestAttempt(proxyRequest);
                    currentQueue = this.connectionRegistry.createMessageQueue(
                        proxyRequest.request_id,
                        retryAuthIndex,
                        proxyRequest.request_attempt_id
                    );
                    currentQueueAuthIndex = retryAuthIndex;
                    continue;
                }

                // Log the warning for the current attempt
                this.logger.warn(
                    `[Request] Attempt #${retryAttempt}/${this.config.maxRetries} for request #${proxyRequest.request_id} failed: ${errorPayload.message}`
                );

                // If it's the last attempt, break the loop to return failure
                if (retryAttempt >= this.config.maxRetries) {
                    this.logger.error(
                        `❌ [Request] All ${this.config.maxRetries} retries failed for request #${proxyRequest.request_id}. Final error: ${errorPayload.message}`
                    );
                    break;
                }

                // Explicitly close the old queue before creating a new one
                // This ensures waitingResolvers are properly rejected even if authIndex changed
                try {
                    currentQueue.close("retry_creating_new_queue");
                } catch (e) {
                    this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                }

                // Create a new message queue for the retry, excluding the just-failed account.
                // Dispatches to the least-loaded ready account (falls back to currentAuthIndex).
                // Note: We keep the same requestId so the browser response routes to the new queue
                // createMessageQueue will automatically close and remove any existing queue with the same ID from the registry
                // Prefer an account this request has not tried yet, then any account but the last one.
                let retryAuthIndex = this._selectDispatchAuthIndex([...immediateSwitchTracker.attemptedAuthIndices], {
                    allowFallback: false,
                });
                if (retryAuthIndex < 0) retryAuthIndex = this._selectDispatchAuthIndex([currentQueueAuthIndex]);
                if (retryAuthIndex < 0 && !this.authSource.isAccountCoolingDown?.(currentQueueAuthIndex)) {
                    retryAuthIndex = currentQueueAuthIndex;
                }
                if (retryAuthIndex < 0) break;
                this.logger.debug(
                    `[Request] Creating new message queue for retry #${retryAttempt + 1} for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${retryAuthIndex})`
                );
                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    retryAuthIndex,
                    proxyRequest.request_attempt_id
                );
                // Update tracked authIndex for the new queue
                currentQueueAuthIndex = retryAuthIndex;
                if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                    immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                }

                // Wait before the next retry
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                if (requestCancelled()) return cancelledResult();
                if (
                    !(await this._waitForSystemAndConnectionIfBusy(null, {
                        allowAnyReadyAccount: true,
                        connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                    }))
                ) {
                    lastError = {
                        message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                        status: 503,
                    };
                    break;
                }
                retryAttempt++;
            }
        }

        // The same failure on several different accounts comes from the model or upstream (e.g. a
        // model the tier cannot access), not from the current account: do not count or switch it.
        const failedStatuses = new Set(failedStatusByAccount.values());
        if (
            lastError &&
            !lastError.skipAccountSwitch &&
            failedStatusByAccount.size >= 2 &&
            failedStatuses.size === 1 &&
            failedStatuses.has(Number(lastError.status))
        ) {
            this.logger.info(
                `[Request] Request #${proxyRequest.request_id} failed with ${lastError.status} on ${failedStatusByAccount.size} different accounts; not treating it as an account failure.`
            );
            lastError = { ...lastError, skipAccountSwitch: true };
        }

        // After all retries, return the final failure result
        return { error: lastError, success: false };
    }
}

module.exports = RetryHandler;
