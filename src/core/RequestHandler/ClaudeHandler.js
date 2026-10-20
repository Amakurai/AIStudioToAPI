/**
 * File: src/core/RequestHandler/ClaudeHandler.js
 * Description: Claude requests, token counting, and streaming/non-streaming responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const RetryHandler = require("./RetryHandler");
const { isUserAbortedError } = require("../../utils/CustomErrors");

class ClaudeHandler extends RetryHandler {
    // Process Claude API format requests
    async processClaudeRequest(req, res) {
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "claude");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "overloaded_error" }))) {
                return;
            }

            const isClaudeStream = req.body.stream === true;

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] Claude generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate Claude format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            const { proxyRequest, useRealStream } = this._prepareGenerationProxyRequest({
                googleBody,
                isStreaming: isClaudeStream,
                model,
                modelStreamingMode,
                requestId,
                res,
            });

            try {
                // Dispatch to the least-loaded ready account (falls back to currentAuthIndex)
                // Create message queue inside try-catch to handle invalid authIndex
                const dispatchAuthIndex = this._selectDispatchAuthIndex();
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    dispatchAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = dispatchAuthIndex;
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        this._forwardRequest(proxyRequest, currentQueueAuthIndex);
                        initialMessage = await currentQueue.dequeue();

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this.config?.immediateSwitchStatusCodes?.includes(initialStatus)
                        ) {
                            this.logger.warn(
                                `[Request] Claude real stream received ${initialStatus}, preparing retry...`
                            );
                            const retryState = await this._prepareRealStreamImmediateRetry(
                                proxyRequest,
                                currentQueue,
                                initialMessage,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryState) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            ({ currentQueue, currentQueueAuthIndex } = retryState);
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "Claude real stream", requestId, {
                            afterRetries: false,
                        });
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message, "api_error");
                        const accountSwitchTask = this._handleFinalFailureAccountSwitch(initialMessage, {
                            skipAccountSwitch: skipFinalFailureSwitch,
                        });
                        if (accountSwitchTask) await accountSwitchTask;
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] Claude streaming response (Real Mode) started...`);
                    await this._streamClaudeResponse(currentQueue, res, model, requestId);
                } else {
                    // Claude Fake Stream / Non-Stream mode. Nothing is sent before the first text (fake
                    // streams: before generation has finished), so failures and empty replies keep a
                    // plain HTTP error status. Real-mode anti-truncation streams ping between segments.
                    const startStream = () =>
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                        });

                    const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);

                    if (!result.success) {
                        this._logFinalRequestFailure(result.error, "Claude fake/non-stream", requestId);
                        this._sendErrorResponse(res, result.error.status || 500, result.error.message, "api_error");
                        const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error);
                        if (accountSwitchTask) await accountSwitchTask;
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                        this.authSwitcher.failureCount = 0;
                    }

                    // Use the queue that successfully received the initial message
                    const activeQueue = result.queue;

                    if (isClaudeStream) {
                        if (proxyRequest.anti_truncation) {
                            const streamState = {};
                            await this._streamAntiTruncationResponse(
                                proxyRequest,
                                result.message,
                                activeQueue,
                                res,
                                startStream,
                                chunk => {
                                    const events = this.formatConverter.translateGoogleToClaudeStream(
                                        JSON.stringify(chunk),
                                        model,
                                        streamState
                                    );
                                    if (events) res.write(events);
                                },
                                "event: ping\ndata: {}\n\n"
                            );
                            return;
                        }

                        const fullBody = await this._collectBufferedBody(
                            activeQueue,
                            res,
                            "Claude fake stream",
                            requestId
                        );
                        if (fullBody === null) return;
                        const streamState = {};
                        const translatedChunk = this.formatConverter.translateGoogleToClaudeStream(
                            fullBody,
                            model,
                            streamState
                        );
                        if (streamState.error) this._markTrackedResponseError(res, streamState.error.message, 400);
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable before final fake Claude stream chunk."
                            );
                            return;
                        }
                        startStream();
                        if (translatedChunk) res.write(translatedChunk);
                        this.logger.info(
                            `✅ [Request] Response completed (Claude fake stream), request ID: ${requestId}`
                        );
                    } else {
                        // Non-stream
                        await this._sendClaudeNonStreamResponse(activeQueue, res, model, requestId);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this._cleanupRequestResources(requestId, res, { switchAccountIfNeeded: true });
            }
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process Claude count tokens request
    async processClaudeCountTokens(req, res) {
        const requestId = this._generateRequestId();
        this.logger.info(`[Request] Claude count tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "claude");

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "overloaded_error" }))) {
                return;
            }

            // Translate Claude format to Google format
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            // Build countTokens request
            // Per Gemini API docs, countTokens accepts:
            // - contents[] (simple mode)
            // - generateContentRequest (full request with model, contents, tools, systemInstruction, etc.)
            const countTokensBody = {
                generateContentRequest: {
                    model: `models/${model}`,
                    ...googleBody,
                },
            };

            const proxyRequest = {
                body: JSON.stringify(countTokensBody),
                headers: { "Content-Type": "application/json" },
                is_generative: false,
                method: "POST",
                path: `/v1beta/models/${model}:countTokens`,
                query_params: {},
                request_id: requestId,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                model,
                path: proxyRequest.path,
                requestCategory: "count_tokens",
            });

            try {
                const { firstMessage, messageQueue } = this._dispatchProxyRequestForFirstMessage(
                    proxyRequest,
                    requestId,
                    res
                );
                const response = await firstMessage;

                if (response.event_type === "error") {
                    this.logger.error(
                        `❌ [Request] Received error from browser, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );
                    this._sendErrorResponse(res, response.status || 500, response.message, "api_error");
                    const accountSwitchTask = this._handleFinalFailureAccountSwitch(response);
                    if (accountSwitchTask) await accountSwitchTask;
                    return;
                }

                // For non-streaming requests, consume all chunks until STREAM_END
                let fullBody = "";
                if (response.type !== "STREAM_END") {
                    if (response.data) fullBody += response.data;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const message = await messageQueue.dequeue();
                        if (message.type === "STREAM_END") {
                            break;
                        }
                        if (message.event_type === "error") {
                            this.logger.error(`❌ [Request] Error received during count tokens: ${message.message}`);
                            this._markTrackedResponseError(res, message.message, 500);
                            return this._sendErrorResponse(res, 500, message.message, "api_error");
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                const geminiResponse = JSON.parse(fullBody || response.body);
                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] Count tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                // Return Claude-compatible response
                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (Claude count_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
                );
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this._cleanupRequestResources(requestId, res);
            }
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // === Response Handlers ===

    async _streamClaudeResponse(messageQueue, res, model, requestId) {
        const streamState = {};
        const gate = this._createRealStreamGate();

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);

                if (message.type === "STREAM_END") {
                    if (!gate.open) {
                        this._failBeforeOutput(res, gate.failure(), "Claude real stream", requestId);
                        break;
                    }
                    this.logger.info(`✅ [Request] Response completed (Claude real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    const status = this._getUpstreamErrorStatus(message);
                    if (!gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: message.message, status },
                            "Claude real stream",
                            requestId
                        );
                        break;
                    }
                    this.logger.error(`❌ [Request] Error received during Claude stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, status);
                    // Attempt to send error event to client if headers allowed, then close
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    error: {
                                        message: message.message,
                                        type: "api_error",
                                    },
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Claude stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const claudeChunk = gate.push(
                        message.data,
                        this.formatConverter.translateGoogleToClaudeStream(message.data, model, streamState)
                    );
                    if (streamState.error && !gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: streamState.error.message, status: 400 },
                            "Claude real stream",
                            requestId
                        );
                        break;
                    }
                    if (streamState.error) this._markTrackedResponseError(res, streamState.error.message, 400);
                    if (claudeChunk) {
                        // Before writing, ensure the response is still writable to avoid
                        // throwing if the client disconnected mid-stream.
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Claude stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(claudeChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Claude chunk to stream: ${writeError.message}`
                            );
                            // Stop streaming on write failure to avoid misclassifying as a timeout.
                            break;
                        }
                    }
                    if (streamState.error) break;
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect)
            // Let other errors (timeout, parsing, logic errors) propagate to outer catch
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            // Re-throw all other errors to be handled by outer catch block
            throw error;
        }
    }

    async _sendClaudeNonStreamResponse(messageQueue, res, model, requestId) {
        const fullBody = await this._collectBufferedBody(messageQueue, res, "Claude non-stream", requestId);
        if (fullBody === null) return;

        try {
            const googleResponse = JSON.parse(fullBody);
            const claudeResponse = this.formatConverter.convertGoogleToClaudeNonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(claudeResponse));
            this.logger.info(`✅ [Request] Response completed (Claude non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for Claude: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response", "api_error");
        }
    }
}

module.exports = ClaudeHandler;
