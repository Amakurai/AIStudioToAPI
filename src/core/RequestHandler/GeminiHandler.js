/**
 * File: src/core/RequestHandler/GeminiHandler.js
 * Description: Native Gemini request preparation and streaming/non-streaming responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AntiTruncation = require("../AntiTruncation");

const RetryHandler = require("./RetryHandler");
const FormatConverter = require("../FormatConverter");
const { isUserAbortedError } = require("../../utils/CustomErrors");
const { QueueTimeoutError } = require("../../utils/MessageQueue");

class GeminiHandler extends RetryHandler {
    // Process standard Google API requests
    async processRequest(req, res) {
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "gemini",
            requestCategory: this._categorizeRequest(req.path, "request"),
        });
        this._setResponseApiFormat(res, "gemini");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res))) {
                return;
            }

            // Handle usage-based account switching
            const isGenerativeRequest =
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent"));

            let proxyRequest;
            try {
                proxyRequest = this._buildProxyRequest(req, requestId);
                proxyRequest.is_generative = isGenerativeRequest;
                this._initializeProxyRequestAttempt(proxyRequest);
            } catch (error) {
                this.logger.warn(`[Request] Invalid Gemini request: ${error.message}`);
                this._sendErrorResponse(res, error.status || 500, error.message);
                return;
            }

            if (isGenerativeRequest) {
                const usageCount = this.authSwitcher.incrementUsageCount();
                if (usageCount > 0) {
                    const rotationCountText =
                        this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                    this.logger.info(
                        `[Request] Google generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                    );
                    if (this.authSwitcher.shouldSwitchByUsage()) {
                        this.needsSwitchingAfterRequest = true;
                    }
                }
            }

            const wantsStream = req.path.includes(":streamGenerateContent");
            const streamMode = wantsStream
                ? this._prepareAntiTruncationStream(proxyRequest, true) || proxyRequest.streaming_mode
                : null;
            res.__proxyResponseStreamMode = streamMode;

            this._updateTrackedRequest(requestId, {
                isStreaming: wantsStream,
                // Track the public name (with its build-/pg- prefix), as the other API formats do.
                model: this._trackedModelName(req.path) ?? this._extractModelFromPath(proxyRequest.path),
                path: proxyRequest.path,
                requestCategory: this._categorizeRequest(
                    proxyRequest.path,
                    isGenerativeRequest ? "generation" : "request"
                ),
                streamMode,
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

                if (wantsStream) {
                    if (proxyRequest.streaming_mode === "fake") {
                        await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);
                    } else {
                        await this._handleRealStreamResponse(proxyRequest, messageQueue, req, res);
                    }
                } else {
                    proxyRequest.streaming_mode = "fake";
                    await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
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

    async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
        // Per user request, convert the backend call to non-streaming.
        proxyRequest.path = proxyRequest.path.replace(":streamGenerateContent", ":generateContent");
        if (proxyRequest.query_params && proxyRequest.query_params.alt) {
            delete proxyRequest.query_params.alt;
        }

        // Nothing is sent before the first text (fake streams: before generation has finished), so failures
        // and empty replies keep a plain HTTP error status. Real-mode anti-truncation streams ping between segments.
        const startStream = () => {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
        };

        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);

            if (!result.success) {
                if (isUserAbortedError(result.error)) {
                    this.logger.debug(
                        `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                    );
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini fake stream", proxyRequest.request_id);
                    this._sendErrorResponse(res, result.error.status || 500, result.error.message);

                    const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error, {
                        connectionResetContext: "Gemini Non-Stream",
                    });
                    if (accountSwitchTask) await accountSwitchTask;
                }
                return;
            }

            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            if (proxyRequest.anti_truncation) {
                await this._streamAntiTruncationResponse(
                    proxyRequest,
                    result.message,
                    activeQueue,
                    res,
                    startStream,
                    chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
                    ": keep-alive\n\n"
                );
                return;
            }

            const fullData = await this._collectBufferedBody(
                activeQueue,
                res,
                "Gemini fake stream",
                proxyRequest.request_id
            );
            if (fullData === null) return;
            if (!this._isResponseWritable(res)) return;
            startStream();
            this.logger.info(`[Request] Gemini streaming response (Fake Mode) started...`);

            try {
                const googleResponse = JSON.parse(fullData);
                this._logGeminiNativeResponseDebug(googleResponse, "pseudo-stream");
                const candidate = googleResponse.candidates?.[0];

                if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
                    this.logger.debug(
                        "[Request] Splitting full Gemini response into 'thought' and 'content' chunks for pseudo-stream."
                    );

                    const thinkingParts = candidate.content.parts.filter(p => p.thought === true);
                    const contentParts = candidate.content.parts.filter(p => p.thought !== true);
                    const role = candidate.content.role || "model";

                    // Send thinking part first
                    if (thinkingParts.length > 0) {
                        const thinkingResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: thinkingParts,
                                        role,
                                    },
                                    // We don't include finishReason here
                                },
                            ],
                            // We don't include usageMetadata here
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (thinking parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(thinkingResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini thinking chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${thinkingParts.length} thinking part(s).`);
                    }

                    // Then send content part
                    if (contentParts.length > 0) {
                        const contentResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: contentParts,
                                        role,
                                    },
                                    finishReason: candidate.finishReason,
                                    // Other candidate fields can be preserved if needed
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (content parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(contentResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini content chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${contentParts.length} content part(s).`);
                    } else if (candidate.finishReason) {
                        // If there's no content but a finish reason, send an empty content message with it
                        const finalResponse = {
                            candidates: [
                                {
                                    content: { parts: [], role },
                                    finishReason: candidate.finishReason,
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (final response); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini final chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                    }
                } else if (fullData) {
                    // Fallback for responses without candidates or parts, or if parsing fails
                    this.logger.warn(
                        "[Request] Response structure not recognized for splitting, sending as a single chunk."
                    );
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            } catch (e) {
                this.logger.error(
                    `❌ [Request] Failed to parse and split Gemini response: ${e.message}. Sending raw data.`
                );
                if (fullData) {
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (error fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini error fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            }

            this.logger.info(
                `✅ [Request] Response completed (Gemini fake stream), request ID: ${proxyRequest.request_id}`
            );
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        } finally {
            if (!res.writableEnded) {
                res.end();
            }
            this.logger.debug(
                `[Request] Pseudo-stream response processing ended, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleRealStreamResponse(proxyRequest, messageQueue, req, res) {
        let currentQueue = messageQueue;
        const registeredQueueAuthIndex = this.connectionRegistry.getAuthIndexForRequest(proxyRequest.request_id);
        // The queue may be dispatched to a non-current account (multi-account dispatch)
        let currentQueueAuthIndex =
            Number.isInteger(registeredQueueAuthIndex) && registeredQueueAuthIndex >= 0
                ? registeredQueueAuthIndex
                : this.currentAuthIndex;
        let headerMessage;
        let skipFinalFailureSwitch = false;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Record attempt before forwarding, so failed attempts are also counted
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            this._forwardRequest(proxyRequest, currentQueueAuthIndex);
            headerMessage = await currentQueue.dequeue();

            const headerStatus = Number(headerMessage?.status);
            if (
                headerMessage.event_type === "error" &&
                proxyRequest.is_generative &&
                !isUserAbortedError(headerMessage) &&
                Number.isFinite(headerStatus) &&
                this.config?.immediateSwitchStatusCodes?.includes(headerStatus)
            ) {
                this.logger.warn(`[Request] Gemini real stream received ${headerStatus}, preparing retry...`);
                const retryState = await this._prepareRealStreamImmediateRetry(
                    proxyRequest,
                    currentQueue,
                    headerMessage,
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

        if (headerMessage.event_type === "error") {
            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
            if (isUserAbortedError(headerMessage)) {
                this.logger.debug(
                    `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                );
            } else {
                this._logFinalRequestFailure(headerMessage, "Gemini real stream", proxyRequest.request_id, {
                    afterRetries: false,
                });
                const accountSwitchTask = this._handleFinalFailureAccountSwitch(headerMessage, {
                    connectionResetContext: "Gemini Real Stream",
                    skipAccountSwitch: skipFinalFailureSwitch,
                });
                if (accountSwitchTask) await accountSwitchTask;
                return this._sendErrorResponse(res, headerMessage.status, headerMessage.message);
            }
            if (!res.writableEnded) res.end();
            return;
        }

        if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
            this.logger.debug(
                `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
            );
            this.authSwitcher.failureCount = 0;
        }

        this._setResponseHeaders(res, headerMessage, req);
        // Fallback: Ensure Content-Type is set for streaming response
        if (!res.get("Content-Type")) {
            res.type("text/event-stream");
        }
        this.logger.info(`[Request] Gemini streaming response (Real Mode) started...`);
        const gate = this._createRealStreamGate();
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const dataMessage = await currentQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (dataMessage.type === "STREAM_END") {
                    if (!gate.open) {
                        this._failBeforeOutput(res, gate.failure(), "Gemini real stream", proxyRequest.request_id);
                        break;
                    }
                    this.logger.info(
                        `✅ [Request] Response completed (Gemini real stream), request ID: ${proxyRequest.request_id}`
                    );
                    break;
                }

                if (dataMessage.event_type === "error") {
                    const status = this._getUpstreamErrorStatus(dataMessage);
                    if (!gate.open) {
                        this._failBeforeOutput(
                            res,
                            { message: dataMessage.message, status },
                            "Gemini real stream",
                            proxyRequest.request_id
                        );
                        break;
                    }
                    this.logger.error(`❌ [Request] Error received during Gemini real stream: ${dataMessage.message}`);
                    this._markTrackedResponseError(res, dataMessage.message, status);
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: status, message: dataMessage.message, status: "INTERNAL" } })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Gemini real stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (dataMessage.data) {
                    this._logGeminiNativeChunkDebug(dataMessage.data, "stream");
                    const chunk = gate.push(dataMessage.data, dataMessage.data);
                    if (!chunk) continue;
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini real stream; stopping stream."
                        );
                        break;
                    }
                    try {
                        res.write(chunk);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini data chunk to stream: ${writeError.message}`
                        );
                        break;
                    }
                }
            }
        } catch (error) {
            // Handle queue closed errors (account switch, context closed, etc.)
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
            } else if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                // Keep behavior consistent with other interfaces: treat missing stream chunks as a timeout error.
                this._handleRequestError(error, res, proxyRequest.request_id);
            } else {
                // Unexpected error - rethrow to outer handler
                throw error;
            }
        } finally {
            if (!res.writableEnded) res.end();
            this.logger.debug(
                `[Request] Real stream response connection closed, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleNonStreamResponse(proxyRequest, messageQueue, req, res) {
        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue, res);

            if (!result.success) {
                // If retries failed, handle the failure (e.g., switch account)
                if (isUserAbortedError(result.error)) {
                    this.logger.info(`[Request] Request #${proxyRequest.request_id} was properly cancelled by user.`);
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini non-stream", proxyRequest.request_id);
                    const accountSwitchTask = this._handleFinalFailureAccountSwitch(result.error, {
                        connectionResetContext: "Gemini Non-Stream",
                    });
                    if (accountSwitchTask) await accountSwitchTask;
                }
                return this._sendErrorResponse(res, result.error.status || 500, result.error.message);
            }

            // On success, reset failure count if needed
            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Non-stream generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            const headerMessage = result.message;
            const chunks = [];
            let receiving = true;
            while (receiving) {
                const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                if (message.type === "STREAM_END") {
                    this.logger.debug("[Request] Gemini non-stream end signal received.");
                    receiving = false;
                    break;
                }

                if (message.event_type === "error") {
                    const status = this._getUpstreamErrorStatus(message);
                    this.logger.error(`❌ [Request] Error received during Gemini non-stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, status);
                    this._sendErrorResponse(res, status, message.message);
                    return;
                }

                if (message.event_type === "chunk" && message.data) {
                    chunks.push(Buffer.from(message.data));
                }
            }

            let responseBodyBuffer = Buffer.concat(chunks);

            // A generation without any output is an error, not an empty 200 reply.
            if (proxyRequest.is_generative && proxyRequest.path.includes(":generateContent")) {
                const failure = this._noOutputError(responseBodyBuffer.toString());
                if (failure) {
                    this._failBeforeOutput(res, failure, "Gemini non-stream", proxyRequest.request_id);
                    return;
                }
            }

            try {
                const fullResponse = JSON.parse(responseBodyBuffer.toString());
                this._logGeminiNativeResponseDebug(fullResponse, "non-stream");
            } catch (e) {
                // Ignore JSON parsing errors for finish reason
            }

            if (proxyRequest.response_transform === "batchEmbedToEmbedContent") {
                try {
                    responseBodyBuffer = this._convertBatchEmbedResponseToEmbedContent(responseBodyBuffer);
                } catch (error) {
                    this.logger.error(`❌ [Proxy] Failed to convert embedding response: ${error.message}`);
                    this._sendErrorResponse(res, 500, "Failed to convert backend embedding response");
                    return;
                }
            }

            this._setResponseHeaders(res, headerMessage, req);

            // Ensure Content-Type is set (Express defaults Buffer to application/octet-stream)
            if (!res.get("Content-Type")) {
                res.type("application/json");
            }

            res.send(responseBodyBuffer);
            this.logger.info(
                `✅ [Request] Response completed (Gemini non-stream), request ID: ${proxyRequest.request_id}`
            );
            this.logger.debug(`[Request] Complete non-stream response sent to client.`);
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        }
    }

    // === Helper Methods ===

    _processImageInResponse(fullBody) {
        try {
            const parsedBody = JSON.parse(fullBody);
            let needsReserialization = false;

            const candidate = parsedBody.candidates?.[0];
            if (candidate?.content?.parts) {
                const imagePartIndex = candidate.content.parts.findIndex(p => p.inlineData);

                if (imagePartIndex > -1) {
                    this.logger.info(
                        "[Proxy] Detected image data in Google format response, converting to Markdown..."
                    );
                    const imagePart = candidate.content.parts[imagePartIndex];
                    const image = imagePart.inlineData;

                    candidate.content.parts[imagePartIndex] = {
                        text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
                    };
                    needsReserialization = true;
                }
            }

            if (needsReserialization) {
                return JSON.stringify(parsedBody);
            }
        } catch (e) {
            this.logger.warn(
                `[Proxy] Response body is not valid JSON, or error occurred while processing image: ${e.message}`
            );
        }
        return fullBody;
    }

    _buildProxyRequest(req, requestId) {
        const fullPath = req.path;
        let cleanPath = fullPath.replace(/^\/proxy/, "");
        let bodyObj = req.body;
        let requestBodyObj = bodyObj;
        let responseTransform = null;

        this.logger.debug(`[Proxy] Debug: incoming Gemini Body (Google Native) = ${JSON.stringify(bodyObj, null, 2)}`);

        // Parse model suffixes from model name in native Gemini generation requests
        // Only handle generation requests: /v1beta/models/{modelName}:generateContent or :streamGenerateContent
        const modelPathMatch = cleanPath.match(
            /^(\/v1beta\/models\/)([^:]+)(:(generateContent|streamGenerateContent).*)$/
        );
        let modelThinkingLevel = null;
        let modelStreamingMode = null;
        let modelForceCodeExecution = false;
        let modelForceWebSearch = false;

        if (modelPathMatch) {
            const pathPrefix = modelPathMatch[1];
            const rawModelName = modelPathMatch[2];
            const pathSuffix = modelPathMatch[3];

            const {
                cleanModelName,
                forceCodeExecution: parsedForceCodeExecution,
                forceWebSearch: parsedForceWebSearch,
                streamingMode: parsedStreamingMode,
                thinkingLevel: parsedThinkingLevel,
            } = this.formatConverter.parseModelSuffixes(rawModelName, {
                logPrefix: "[Proxy]",
                modelSource: "model path",
            });
            modelForceCodeExecution = parsedForceCodeExecution;
            modelForceWebSearch = parsedForceWebSearch;
            modelStreamingMode = parsedStreamingMode;
            modelThinkingLevel = parsedThinkingLevel;

            if (req.method === "POST" && AntiTruncation.baseModel(cleanModelName)) {
                // Normalize before global settings add camelCase fields to the native body.
                bodyObj = AntiTruncation.normalizeRequest(bodyObj);
                // Tool and cachedContent requests fall back to the base model in _initializeProxyRequestAttempt.
                if (!AntiTruncation.requiresOriginalModel(bodyObj)) AntiTruncation.validateRequest(bodyObj);
                requestBodyObj = bodyObj;
            }

            // Always strip recognized directives from path model name
            if (cleanModelName !== rawModelName) {
                cleanPath = `${pathPrefix}${cleanModelName}${pathSuffix}`;
            }
        }

        // Force thinking for native Google requests (processed first)
        if (this.config.forceThinking && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (
                !bodyObj.generationConfig.thinkingConfig ||
                bodyObj.generationConfig.thinkingConfig.includeThoughts === undefined
            ) {
                this.logger.info(`[Proxy] ⚠️ Force thinking enabled, setting includeThoughts=true. (Google Native)`);
                bodyObj.generationConfig.thinkingConfig = {
                    ...(bodyObj.generationConfig.thinkingConfig || {}),
                    includeThoughts: true,
                };
            }
        }

        // If thinkingLevel is parsed from model name suffix, inject into thinkingConfig (after force thinking, higher priority, direct override)
        if (modelThinkingLevel && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (!bodyObj.generationConfig.thinkingConfig) {
                bodyObj.generationConfig.thinkingConfig = {};
            }
            // Model name suffix thinkingLevel has highest priority, direct override
            bodyObj.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
        }

        // Pre-process native Google requests
        // 1. Ensure thoughtSignature for functionCall (not functionResponse)
        // 2. Normalize type values in legacy tool parameter/response schemas to uppercase Gemini Type enums
        // 3. Normalize responseSchema type values to Google Type enums
        if (req.method === "POST" && bodyObj) {
            if (bodyObj.contents) {
                this.formatConverter.ensureThoughtSignature(bodyObj);
            }
            if (bodyObj.tools) {
                this.formatConverter.sanitizeGeminiTools(bodyObj);
            }
            if (bodyObj.generationConfig?.responseSchema) {
                this.formatConverter.normalizeGeminiResponseSchema(bodyObj);
            }
        }

        const embedContentMatch = cleanPath.match(/^\/v1beta\/models\/([^:]+):embedContent$/);
        if (req.method === "POST" && embedContentMatch) {
            const modelName = embedContentMatch[1];
            cleanPath = `/v1beta/models/${modelName}:batchEmbedContents`;
            requestBodyObj = this._convertEmbedContentBodyToBatch(bodyObj, modelName);
            responseTransform = "batchEmbedToEmbedContent";
            this.logger.info(`[Proxy] Rewriting embedContent to batchEmbedContents for model "${modelName}".`);
        }

        // Force built-in tools for native Google requests
        if (
            (this.config.forceWebSearch ||
                modelForceWebSearch ||
                this.config.forceUrlContext ||
                this.config.forceCodeExecution ||
                modelForceCodeExecution) &&
            req.method === "POST" &&
            bodyObj &&
            bodyObj.contents
        ) {
            if (!bodyObj.tools) {
                bodyObj.tools = [];
            }

            const toolsToAdd = [];

            // Handle Google Search
            if (this.config.forceWebSearch || modelForceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(bodyObj.tools);
                if (!hasSearch) {
                    bodyObj.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided web search detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle URL Context
            if (this.config.forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(bodyObj.tools);
                if (!hasUrlContext) {
                    bodyObj.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided URL context detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle Code Execution
            if (this.config.forceCodeExecution || modelForceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(bodyObj.tools);
                if (!hasCodeExecution) {
                    bodyObj.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided code execution detected, skipping force injection. (Google Native)`
                    );
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(
                    `[Proxy] ⚠️ Forcing tools enabled, injecting: [${toolsToAdd.join(", ")}] (Google Native)`
                );
            }
        }

        this.formatConverter.ensureServerSideToolInvocations(bodyObj, "[Proxy]");

        // Apply safety settings for native Google requests (only if not already provided)
        if (req.method === "POST" && bodyObj && bodyObj.contents && !bodyObj.safetySettings) {
            bodyObj.safetySettings = this.formatConverter.getDefaultSafetySettings();
        }

        this.logger.debug(
            `[Proxy] Debug: Final Gemini Request (Google Native) = ${JSON.stringify(requestBodyObj, null, 2)}`
        );

        return {
            body: req.method !== "GET" ? JSON.stringify(requestBodyObj) : undefined,
            headers: req.headers,
            is_generative:
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent")),
            method: req.method,
            path: cleanPath,
            query_params: req.query || {},
            request_id: requestId,
            response_transform: responseTransform,
            streaming_mode: modelStreamingMode || this.config.streamingMode,
        };
    }

    _trackedModelName(pathValue) {
        const raw = this._extractModelFromPath(pathValue);
        if (!raw) return null;
        let name = raw;
        try {
            name = decodeURIComponent(raw);
        } catch {
            // Keep the raw name.
        }
        return this.formatConverter.constructor.stripModelSuffixes(name);
    }

    _extractModelFromPath(pathValue) {
        if (typeof pathValue !== "string") return null;

        const match = pathValue.match(/\/models\/([^:/?]+)(?::|$)/);
        return match?.[1] || null;
    }

    _convertEmbedContentBodyToBatch(bodyObj, modelName) {
        return {
            requests: [
                {
                    ...bodyObj,
                    model: `models/${modelName}`,
                },
            ],
        };
    }

    _convertBatchEmbedResponseToEmbedContent(fullBodyBuffer) {
        const batchResponse = JSON.parse(fullBodyBuffer.toString());
        const embedding = Array.isArray(batchResponse.embeddings) ? batchResponse.embeddings[0] : null;

        if (!embedding) {
            throw new Error("Backend batchEmbedContents response did not contain embeddings[0].");
        }

        return Buffer.from(
            JSON.stringify({
                embedding,
                ...(batchResponse.usageMetadata ? { usageMetadata: batchResponse.usageMetadata } : {}),
            })
        );
    }

    _logGeminiNativeChunkDebug(googleChunk, mode = "stream") {
        this.logger.debug(`[Proxy] Debug: Received Google chunk for Gemini native ${mode}: ${googleChunk}`);
    }

    _logGeminiNativeResponseDebug(googleResponse, mode = "non-stream") {
        try {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode}: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode} (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }
    }
}

module.exports = GeminiHandler;
