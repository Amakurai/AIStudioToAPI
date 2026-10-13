/**
 * File: src/core/RequestHandler/UploadHandler.js
 * Description: Upload request forwarding and upload metadata handling.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const GeminiHandler = require("./GeminiHandler");

class UploadHandler extends GeminiHandler {
    // Process File Upload requests
    async processUploadRequest(req, res) {
        const requestId = this._generateRequestId();
        this.logger.info(`[Upload] Processing upload request ${req.method} ${req.path}, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "upload",
            isStreaming: false,
            requestCategory: "upload",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "upload");

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { logPrefix: "Upload" }))) {
                return;
            }

            const uploadBodyBuffer = this._patchUploadStartMetadata(req);
            const proxyRequest = {
                body_b64: uploadBodyBuffer ? uploadBodyBuffer.toString("base64") : undefined,
                headers: req.headers,
                is_generative: false, // Uploads are never generative
                method: req.method,
                path: req.path.replace(/^\/proxy/, ""),
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "fake", // Uploads always return a single JSON response
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            this._updateTrackedRequest(requestId, {
                path: proxyRequest.path,
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

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this._cleanupRequestResources(requestId, res);
            }
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    _patchUploadStartMetadata(req) {
        const originalBody = req.rawBody;

        if (!this._isUploadStartRequest(req)) return originalBody;

        const uploadContentType = req.headers["x-goog-upload-header-content-type"];
        if (!uploadContentType || !originalBody?.length) return originalBody;

        let bodyObj;
        try {
            bodyObj = JSON.parse(originalBody.toString());
        } catch (e) {
            this.logger.debug(`[Upload] Start metadata is not valid JSON, skipping mimeType patch: ${e.message}`);
            return originalBody;
        }

        if (!bodyObj || typeof bodyObj !== "object") return originalBody;

        const fileMetadata = bodyObj.file || bodyObj.file_metadata || bodyObj;
        if (!fileMetadata || typeof fileMetadata !== "object") return originalBody;

        if (fileMetadata.mimeType || fileMetadata.mime_type) {
            return originalBody;
        }

        fileMetadata.mimeType = uploadContentType;
        return Buffer.from(JSON.stringify(bodyObj));
    }

    _isUploadStartRequest(req) {
        const command = String(req.headers["x-goog-upload-command"] || "").toLowerCase();
        return req.method === "POST" && req.path.includes("/upload/") && command.includes("start");
    }
}

module.exports = UploadHandler;
