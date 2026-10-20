/**
 * File: src/core/RequestHandler/ResponsesHandler.js
 * Description: OpenAI Responses requests, input token counting, and responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const RetryHandler = require("./RetryHandler");
const { isUserAbortedError } = require("../../utils/CustomErrors");

class ResponsesHandler extends RetryHandler {
    // Process OpenAI Response API format requests
    async processOpenAIResponseRequest(req, res) {
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "response_api");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }))) {
                return;
            }

            const isOpenAIStream = req.body.stream === true;
            const normalizeInstructions = value => {
                if (typeof value === "string") return value;
                if (!Array.isArray(value)) return null;
                const chunks = [];
                for (const item of value) {
                    if (!item || typeof item !== "object") continue;
                    const content = item.content;
                    if (typeof content === "string") {
                        chunks.push(content);
                        continue;
                    }
                    if (!Array.isArray(content)) continue;
                    for (const part of content) {
                        if (!part || typeof part !== "object") continue;
                        if (part.type === "text" || part.type === "input_text") {
                            if (typeof part.text === "string" && part.text) chunks.push(part.text);
                        }
                    }
                }
                return chunks.length > 0 ? chunks.join("\n") : null;
            };
            const responseDefaultsRaw = {
                include: Array.isArray(req.body?.include) ? req.body.include : undefined,
                instructions: normalizeInstructions(req.body?.instructions),
                max_output_tokens: req.body?.max_output_tokens ?? null,
                metadata:
                    req.body?.metadata && typeof req.body.metadata === "object" && !Array.isArray(req.body.metadata)
                        ? req.body.metadata
                        : {},
                parallel_tool_calls:
                    typeof req.body?.parallel_tool_calls === "boolean" ? req.body.parallel_tool_calls : true,
                reasoning:
                    req.body?.reasoning && typeof req.body.reasoning === "object" && !Array.isArray(req.body.reasoning)
                        ? req.body.reasoning
                        : undefined,
                temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
                text:
                    req.body?.text && typeof req.body.text === "object" && !Array.isArray(req.body.text)
                        ? req.body.text
                        : undefined,
                tool_choice: req.body?.tool_choice ?? undefined,
                tools: Array.isArray(req.body?.tools) ? req.body.tools : undefined,
                top_p: typeof req.body?.top_p === "number" ? req.body.top_p : undefined,
                truncation: typeof req.body?.truncation === "string" ? req.body.truncation : undefined,
                user: typeof req.body?.user === "string" ? req.body.user : undefined,
            };

            const responseDefaults = Object.fromEntries(
                Object.entries(responseDefaultsRaw).filter(([, v]) => v !== undefined)
            );

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] OpenAI Response generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate OpenAI Response format to Google format
            let googleBody, model, modelStreamingMode, responseFunctionNameMap;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
                responseFunctionNameMap = result.responseFunctionNameMap || {};
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
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
                                `[Request] OpenAI Response API real stream received ${initialStatus}, preparing retry...`
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
                        this._logFinalRequestFailure(initialMessage, "OpenAI Response API real stream", requestId, {
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
                            `✅ [Auth] OpenAI Response API request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                    });
                    this.logger.info(`[Request] OpenAI Response API streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponseAPIResponse(currentQueue, res, model, {
                        requestId,
                        responseDefaults,
                        responseFunctionNameMap,
                    });
                } else {
                    // OpenAI Response API Fake Stream / Non-Stream mode. Nothing is sent before the first
                    // text (fake streams: before generation has finished), so failures and empty replies
                    // keep a plain HTTP error status. Real-mode anti-truncation streams ping between segments.
                    const startStream = () =>
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                        });

                    const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);

                    if (!result.success) {
                        this._logFinalRequestFailure(result.error, "OpenAI Response API fake/non-stream", requestId);
                        // Send standard HTTP error response for both streaming and non-streaming
                        this._sendErrorResponse(res, result.error.status || 500, result.error.message);

                        const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error, {
                            connectionResetContext: "Response API",
                        });
                        if (accountSwitchTask) await accountSwitchTask;
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI Response API request successful - failure count reset to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    // Use the queue that successfully received the initial message
                    const activeQueue = result.queue;

                    if (isOpenAIStream) {
                        if (proxyRequest.anti_truncation) {
                            const streamState = {
                                responseDefaults,
                                responseFunctionNameMap,
                                sequenceNumber: res.__responseApiSeq,
                            };
                            await this._streamAntiTruncationResponse(
                                proxyRequest,
                                result.message,
                                activeQueue,
                                res,
                                startStream,
                                chunk => {
                                    const events = this.formatConverter.translateGoogleToResponseAPIStream(
                                        JSON.stringify(chunk),
                                        model,
                                        streamState
                                    );
                                    // Later error events continue the same sequence numbers.
                                    res.__responseApiSeq = streamState.sequenceNumber;
                                    if (events) res.write(events);
                                },
                                ": keep-alive\n\n"
                            );
                            return;
                        }

                        const fullBody = await this._collectBufferedBody(
                            activeQueue,
                            res,
                            "OpenAI Response API fake stream",
                            requestId
                        );
                        if (fullBody === null) return;
                        const streamState = { responseDefaults, responseFunctionNameMap };
                        const translatedChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                            fullBody,
                            model,
                            streamState
                        );
                        if (streamState.error) this._markTrackedResponseError(res, streamState.error.message, 400);
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable before final fake OpenAI Response API stream chunks."
                            );
                            return;
                        }
                        startStream();
                        if (translatedChunk) res.write(translatedChunk);
                        this.logger.info(
                            `✅ [Request] Response completed (OpenAI Response API fake stream), request ID: ${requestId}`
                        );
                    } else {
                        // Non-stream
                        await this._sendOpenAIResponseAPINonStreamResponse(
                            activeQueue,
                            res,
                            model,
                            requestId,
                            responseDefaults,
                            responseFunctionNameMap
                        );
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

    // OpenAI Response API count input tokens endpoint
    // Mirrors OpenAI's /v1/responses/input_tokens by returning only the request-side token count.
    async processOpenAIResponseInputTokens(req, res) {
        const requestId = this._generateRequestId();
        this.logger.info(`[Request] OpenAI Response input_tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "response_api");

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }))) {
                return;
            }

            // Translate OpenAI Response format to Google format (so we can use Gemini countTokens)
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response input_tokens translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
            }

            // Gemini countTokens accepts either:
            // - contents[]
            // - generateContentRequest (full request; required here because tools/systemInstruction/etc may be present)
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
                        `❌ [Request] Received error from browser for input_tokens, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );

                    this._sendErrorResponse(res, response.status || 500, response.message);
                    const accountSwitchTask = this._handleFinalFailureAccountSwitch(response, {
                        connectionResetContext: "input_tokens",
                    });
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
                            this.logger.error(
                                `❌ [Request] Error received during input_tokens count: ${message.message}`
                            );
                            this._markTrackedResponseError(res, message.message, 500);
                            this._sendErrorResponse(res, 500, message.message);
                            return;
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                let geminiResponse;
                try {
                    geminiResponse = JSON.parse(fullBody || response.body);
                } catch (parseError) {
                    this.logger.error(`❌ [Request] Failed to parse countTokens response: ${parseError.message}`);
                    this._sendErrorResponse(res, 500, "Failed to parse backend response");
                    return;
                }

                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] input_tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (OpenAI Response input_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
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

    async _streamOpenAIResponseAPIResponse(messageQueue, res, model, streamOptions = {}) {
        const streamState = {
            responseDefaults: streamOptions.responseDefaults || {},
            responseFunctionNameMap: streamOptions.responseFunctionNameMap || {},
        };
        const requestId = streamOptions.requestId;
        // Keep Response API sequence numbers consistent across helpers that might write to the same SSE response.
        if (res.__responseApiSeq == null) res.__responseApiSeq = -1;
        streamState.sequenceNumber = res.__responseApiSeq;
        const gate = this._createRealStreamGate();

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (message.type === "STREAM_END") {
                    if (!gate.open) {
                        this._failBeforeOutput(res, gate.failure(), "OpenAI Response API real stream", requestId);
                        break;
                    }
                    this.logger.info(
                        `✅ [Request] Response completed (OpenAI Response API real stream), request ID: ${requestId}`
                    );
                    break;
                }

                if (message.event_type === "error") {
                    const status = this._getUpstreamErrorStatus(message);
                    if (!gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: message.message, status },
                            "OpenAI Response API real stream",
                            requestId
                        );
                        break;
                    }
                    this.logger.error(`❌ [Request] Error received during Response API stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, status);
                    if (this._isResponseWritable(res)) {
                        try {
                            if (!Number.isInteger(streamState.sequenceNumber)) streamState.sequenceNumber = -1;
                            streamState.sequenceNumber++;
                            res.__responseApiSeq = streamState.sequenceNumber;
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    code: "api_error",
                                    message: message.message,
                                    param: null,
                                    sequence_number: streamState.sequenceNumber,
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Response API stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const responseAPIChunk = gate.push(
                        message.data,
                        this.formatConverter.translateGoogleToResponseAPIStream(message.data, model, streamState)
                    );
                    if (streamState.error && !gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: streamState.error.message, status: 400 },
                            "OpenAI Response API real stream",
                            requestId
                        );
                        break;
                    }
                    if (streamState.error) this._markTrackedResponseError(res, streamState.error.message, 400);
                    if (typeof streamState.sequenceNumber === "number") {
                        res.__responseApiSeq = streamState.sequenceNumber;
                    }
                    if (responseAPIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Response API stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(responseAPIChunk);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Response API chunk (connection likely closed): ${writeError.message}`
                            );
                            break;
                        }
                    }
                    if (streamState.error) break;
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect / queue closed).
            // Let other errors (timeout, parsing, logic errors) propagate to the outer catch.
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            throw error;
        }
    }

    async _sendOpenAIResponseAPINonStreamResponse(
        messageQueue,
        res,
        model,
        requestId,
        responseDefaults = {},
        responseFunctionNameMap = {}
    ) {
        const fullBody = await this._collectBufferedBody(
            messageQueue,
            res,
            "OpenAI Response API non-stream",
            requestId
        );
        if (fullBody === null) return;

        // Parse and convert to OpenAI Response API format
        try {
            const googleResponse = JSON.parse(fullBody);
            const responseAPIResponse = this.formatConverter.convertGoogleToResponseAPINonStream(
                googleResponse,
                model,
                responseDefaults,
                responseFunctionNameMap
            );
            res.type("application/json").send(JSON.stringify(responseAPIResponse));
            this.logger.info(
                `✅ [Request] Response completed (OpenAI Response API non-stream), request ID: ${requestId}`
            );
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI Response API: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response");
        }
    }
}

module.exports = ResponsesHandler;
