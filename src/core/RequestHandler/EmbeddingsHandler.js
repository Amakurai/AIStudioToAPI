/**
 * File: src/core/RequestHandler/EmbeddingsHandler.js
 * Description: Native Gemini embedding compatibility and OpenAI embeddings requests.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const GeminiHandler = require("./GeminiHandler");

class EmbeddingsHandler extends GeminiHandler {
    // Process OpenAI embeddings requests
    async processOpenAIEmbeddingsRequest(req, res) {
        const requestId = this._generateRequestId();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: false,
            requestCategory: "embedding",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }))) {
                return;
            }

            const { cleanModelName, googleRequest, path } = this.formatConverter.translateOpenAIEmbeddingsToGoogle(
                req.body
            );
            const proxyRequest = {
                body: JSON.stringify(googleRequest),
                headers: req.headers,
                is_generative: false,
                method: "POST",
                path,
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "fake",
                tracking_model: cleanModelName,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                isStreaming: false,
                model: proxyRequest.tracking_model,
                path: proxyRequest.path,
                requestCategory: "embedding",
                streamMode: null,
            });

            try {
                // Dispatch to the least-loaded ready account (falls back to currentAuthIndex)
                const dispatchAuthIndex = this._selectDispatchAuthIndex();
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    dispatchAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleQueueTimeout(error, requestId);
                this._handleRequestError(error, res, requestId);
            } finally {
                this._cleanupRequestResources(requestId, res);
            }
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }
}

module.exports = EmbeddingsHandler;
