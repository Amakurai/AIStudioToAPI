/**
 * File: src/core/RequestHandler/ChatCompletionsHandler.js
 * Description: OpenAI Chat Completions requests and streaming/non-streaming responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AntiTruncation = require("../AntiTruncation");

const RetryHandler = require("./RetryHandler");
const { isUserAbortedError } = require("../../utils/CustomErrors");

class ChatCompletionsHandler extends RetryHandler {
    // Process OpenAI format requests
    async processOpenAIRequest(req, res) {
        // Tool requests keep the alias here; proxy request initialization routes them to the base model.
        if (
            AntiTruncation.baseModel(req.body?.model) &&
            !AntiTruncation.openAIRequiresOriginalModel(req.body, this.config)
        ) {
            return require("../DuplexOpenAI").handle(this, req, res);
        }
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }))) {
                return;
            }

            const isOpenAIStream = req.body.stream === true;

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] OpenAI generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate OpenAI format to Google format (also handles model name suffix parsing)
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid OpenAI request format.", "invalid_request_error");
            }

            const { proxyRequest, useRealStream } = this._prepareGenerationProxyRequest({
                googleBody,
                isStreaming: isOpenAIStream,
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
                                `[Request] OpenAI real stream received ${initialStatus}, preparing retry...`
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
                        this._logFinalRequestFailure(initialMessage, "OpenAI real stream", requestId, {
                            afterRetries: false,
                        });

                        // Send standard HTTP error response
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message);

                        const accountSwitchTask = this._handleFinalFailureAccountSwitch(initialMessage, {
                            connectionResetContext: "Real Stream",
                            skipAccountSwitch: skipFinalFailureSwitch,
                        });
                        if (accountSwitchTask) await accountSwitchTask;
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI interface request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] OpenAI streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponse(currentQueue, res, model, requestId);
                } else {
                    // OpenAI Fake Stream / Non-Stream mode. Nothing is sent until generation has
                    // finished, so failures and empty replies keep a plain HTTP error status.
                    const streamState = {
                        created: Math.floor(Date.now() / 1000),
                        id: `chatcmpl-${requestId}`,
                    };
                    const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);

                    if (!result.success) {
                        this._logFinalRequestFailure(result.error, "OpenAI fake/non-stream", requestId);
                        this._sendErrorResponse(res, result.error.status || 500, result.error.message);

                        const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error, {
                            connectionResetContext: "OpenAI",
                        });
                        if (accountSwitchTask) await accountSwitchTask;
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(`✅ [Auth] OpenAI interface request successful - failure count reset to 0`);
                        this.authSwitcher.failureCount = 0;
                    }

                    // Use the queue that successfully received the initial message
                    const activeQueue = result.queue;

                    if (isOpenAIStream) {
                        const fullBody = await this._collectBufferedBody(
                            activeQueue,
                            res,
                            "OpenAI fake stream",
                            requestId
                        );
                        if (fullBody === null) return;
                        const translatedChunk = this.formatConverter.translateGoogleToOpenAIStream(
                            fullBody,
                            model,
                            streamState
                        );
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable before final fake OpenAI stream chunks."
                            );
                            return;
                        }
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                            "X-Accel-Buffering": "no",
                        });
                        res.write(`${translatedChunk || ""}data: [DONE]\n\n`);
                        this.logger.info(
                            `✅ [Request] Response completed (OpenAI fake stream), request ID: ${requestId}`
                        );
                    } else {
                        // Non-stream
                        await this._sendOpenAINonStreamResponse(activeQueue, res, model, requestId);
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

    async _streamOpenAIResponse(messageQueue, res, model, requestId) {
        const streamState = {};
        const gate = this._createRealStreamGate();

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (message.type === "STREAM_END") {
                    if (!gate.open) {
                        this._failBeforeOutput(res, gate.failure(), "OpenAI real stream", requestId);
                        break;
                    }
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write("data: [DONE]\n\n");
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write final [DONE] to OpenAI stream (connection likely closed): ${writeError.message}`
                            );
                        }
                    }
                    this.logger.info(`✅ [Request] Response completed (OpenAI real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    const status = this._getUpstreamErrorStatus(message);
                    if (!gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: message.message, status },
                            "OpenAI real stream",
                            requestId
                        );
                        break;
                    }
                    this.logger.error(`❌ [Request] Error received during OpenAI stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, status);
                    // Attempt to send error event to client if headers allowed, then close
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: status, message: message.message, type: "api_error" } })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to OpenAI stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const openAIChunk = gate.push(
                        message.data,
                        this.formatConverter.translateGoogleToOpenAIStream(message.data, model, streamState)
                    );
                    if (openAIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during OpenAI stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(openAIChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write OpenAI chunk to stream: ${writeError.message}`
                            );
                            break;
                        }
                    }
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

    async _sendOpenAINonStreamResponse(messageQueue, res, model, requestId) {
        const fullBody = await this._collectBufferedBody(messageQueue, res, "OpenAI non-stream", requestId);
        if (fullBody === null) return;

        // Parse and convert to OpenAI format
        try {
            const googleResponse = JSON.parse(fullBody);
            const openAIResponse = this.formatConverter.convertGoogleToOpenAINonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(openAIResponse));
            this.logger.info(`✅ [Request] Response completed (OpenAI non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response");
        }
    }
}

module.exports = ChatCompletionsHandler;
