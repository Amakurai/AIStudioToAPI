/**
 * File: src/core/RequestHandler/ErrorHandler.js
 * Description: Queue failures and protocol-specific error responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const TransportHandler = require("./TransportHandler");
const { QueueClosedError, QueueTimeoutError } = require("../../utils/MessageQueue");

class ErrorHandler extends TransportHandler {
    _getUpstreamErrorStatus(error) {
        const status = Number(error?.status);
        return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    }

    _isConnectionResetError(error) {
        if (!error) return false;
        // Check for QueueClosedError type
        if (error instanceof QueueClosedError) return true;
        // Check for error code
        if (error.code === "QUEUE_CLOSED") return true;
        // Fallback to message check for backward compatibility
        if (error.message) {
            return (
                error.message.includes("Queue closed") ||
                error.message.includes("Queue is closed") ||
                error.message.includes("Connection lost")
            );
        }
        return false;
    }

    /**
     * Handle queue closed error in real streaming mode with proper SSE error response
     * @param {Error} error - The error object (QueueClosedError)
     * @param {Object} res - Express response object
     * @returns {boolean} true if error was handled, false otherwise
     */
    _handleRealStreamQueueClosedError(error, res) {
        const format = this._resolveErrorFormat(res);
        const isClientDisconnect = error.reason === "client_disconnect" || !this._isResponseWritable(res);

        if (isClientDisconnect) {
            // Client disconnected or queue closed due to client disconnect - no error needed
            this._markTrackedClientAbort(res, error.message || "Client disconnected");
            this.logger.debug(
                `[Request] ${format} stream interrupted by client disconnect (reason: ${error.reason || "connection_lost"})`
            );
            return true;
        }

        // Queue was closed for other reasons (account switch, page_closed, etc.)
        // but client is still connected - send proper error SSE
        this.logger.warn(
            `[Request] ${format} stream interrupted: Queue closed (reason: ${error.reason || "unknown"}), sending error SSE`
        );

        if (!this._isResponseWritable(res)) {
            return true;
        }

        try {
            const errorMessage = `Stream interrupted: ${error.reason === "page_closed" ? "Account context closed" : error.reason || "Connection lost"}`;
            this._markTrackedResponseError(res, errorMessage, 503);

            if (format === "claude") {
                // Claude format: event: error\ndata: {...}
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        error: {
                            message: errorMessage,
                            type: "api_error",
                        },
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "openai") {
                // OpenAI format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            type: "api_error",
                        },
                    })}\n\n`
                );
            } else if (format === "response_api") {
                // OpenAI Response API format: event: error\ndata: {...}
                if (res.__responseApiSeq == null) res.__responseApiSeq = -1;
                res.__responseApiSeq += 1;
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        code: "service_unavailable",
                        message: `Service unavailable: ${errorMessage}`,
                        param: null,
                        sequence_number: res.__responseApiSeq,
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "gemini") {
                // Gemini format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            status: "UNAVAILABLE",
                        },
                    })}\n\n`
                );
            }
        } catch (writeError) {
            this.logger.debug(`[Request] Failed to write error to ${format} stream: ${writeError.message}`);
        }

        return true;
    }

    _handleRequestError(error, res, requestId = null) {
        const format = this._resolveErrorFormat(res);
        // Normalize error message to handle non-Error objects and missing/non-string messages
        const errorMsg = String(error?.message ?? error);
        const upstreamStatus = Number(error?.status);
        const defaultStatus =
            Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 500;
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";

        // Check if this is a client disconnect - if so, just log and return
        if (this._isConnectionResetError(error)) {
            const isClientDisconnect = error.reason === "client_disconnect" || !this._isResponseWritable(res);
            if (isClientDisconnect) {
                this._markTrackedClientAbort(res, errorMsg);
                this.logger.info(
                    `[Request] Request terminated: Queue closed (${error.reason || "connection_lost"})${requestIdSuffix}`
                );
                if (!res.writableEnded) {
                    try {
                        res.end();
                    } catch (e) {
                        // Ignore end errors for disconnected clients
                    }
                }
                return;
            }
        }

        if (res.headersSent) {
            this.logger.error(
                `❌ [Request] Request processing error (headers already sent): ${errorMsg}${requestIdSuffix}`
            );

            // Try to send error in the stream format
            if (this._isResponseWritable(res)) {
                const contentType = res.getHeader("content-type");

                if (contentType && contentType.includes("text/event-stream")) {
                    // SSE format - send error event
                    try {
                        // Determine error code and type based on error classification
                        let errorCode = defaultStatus;
                        let errorType = this._getDefaultErrorType(format, defaultStatus);
                        let errorMessage = `Processing failed: ${errorMsg}`;

                        // Use precise error type checking instead of string matching
                        if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                            errorCode = 504;
                            errorType = "timeout_error";
                            errorMessage = `Stream timeout: ${errorMsg}`;
                        } else if (this._isConnectionResetError(error)) {
                            errorCode = 503;
                            errorType = format === "claude" ? "overloaded_error" : "service_unavailable";
                            errorMessage = `Service unavailable: ${errorMsg}`;
                        }

                        this._markTrackedResponseError(res, errorMessage, errorCode);

                        if (format === "response_api") {
                            if (res.__responseApiSeq == null) res.__responseApiSeq = -1;
                            res.__responseApiSeq += 1;
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    code: errorType,
                                    message: errorMessage,
                                    param: null,
                                    sequence_number: res.__responseApiSeq,
                                    type: "error",
                                })}\n\n`
                            );
                        } else if (format === "claude") {
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    error: {
                                        message: errorMessage,
                                        type: errorType,
                                    },
                                    type: "error",
                                })}\n\n`
                            );
                        } else if (format === "gemini") {
                            let statusText = "INTERNAL";
                            if (errorCode === 429) statusText = "RESOURCE_EXHAUSTED";
                            else if (errorCode === 504) statusText = "DEADLINE_EXCEEDED";
                            else if (errorCode === 503) statusText = "UNAVAILABLE";
                            res.write(
                                `data: ${JSON.stringify({
                                    error: {
                                        code: errorCode,
                                        message: errorMessage,
                                        status: statusText,
                                    },
                                })}\n\n`
                            );
                        } else {
                            res.write(
                                `data: ${JSON.stringify({
                                    error: {
                                        code: errorCode,
                                        message: errorMessage,
                                        type: errorType,
                                    },
                                })}\n\n`
                            );
                        }
                        this.logger.info("[Request] Error event sent to SSE stream");
                    } catch (writeError) {
                        const writeErrorMsg = String(writeError?.message ?? writeError);
                        this.logger.error(
                            `❌ [Request] Failed to write error to stream: ${writeErrorMsg}${requestIdSuffix}`
                        );
                    }
                } else if (res.__proxyResponseStreamMode === "fake") {
                    // Request-scoped fake stream mode - try to send an SSE-style error chunk
                    try {
                        let status = defaultStatus;
                        let errorType = this._getDefaultErrorType(format, defaultStatus);
                        if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                            status = 504;
                            errorType = "timeout_error";
                        } else if (this._isConnectionResetError(error)) {
                            status = 503;
                            errorType = this._getDefaultErrorType(format, status);
                        }
                        this._sendErrorChunkToClient(res, `Processing failed: ${errorMsg}`, status, errorType);
                    } catch (writeError) {
                        const writeErrorMsg = String(writeError?.message ?? writeError);
                        this.logger.error(
                            `❌ [Request] Failed to write error chunk: ${writeErrorMsg}${requestIdSuffix}`
                        );
                    }
                }

                try {
                    res.end();
                } catch (endError) {
                    this.logger.debug(`[Request] Failed to end response: ${endError.message}`);
                }
            }
        } else {
            this.logger.error(`❌ [Request] Request processing error: ${errorMsg}${requestIdSuffix}`);
            let status = defaultStatus;
            let errorType = this._getDefaultErrorType(format, defaultStatus);
            // Use precise error type checking instead of string matching
            if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                status = 504;
                errorType = "timeout_error";
            } else if (this._isConnectionResetError(error)) {
                status = 503;
                errorType = format === "claude" ? "overloaded_error" : "service_unavailable";
                this.logger.info(`[Request] Queue closed, returning 503 Service Unavailable.`);
            }
            this._sendErrorResponse(res, status, `Proxy error: ${errorMsg}`, errorType);
        }
    }

    _sendErrorResponse(res, status, message, errorType = null) {
        if (!res.headersSent) {
            const statusCode = Number(status) || 500;
            const resolvedFormat = this._resolveErrorFormat(res);
            const resolvedErrorType = errorType || this._getDefaultErrorType(resolvedFormat, statusCode);
            let errorPayload;

            if (resolvedFormat === "claude") {
                errorPayload = {
                    error: {
                        message,
                        type: resolvedErrorType,
                    },
                    type: "error",
                };
            } else if (resolvedFormat === "openai") {
                errorPayload = {
                    error: {
                        code: statusCode,
                        message,
                        type: resolvedErrorType,
                    },
                };
            } else if (resolvedFormat === "response_api") {
                errorPayload = {
                    error: {
                        code: resolvedErrorType,
                        message,
                        param: null,
                        type: resolvedErrorType,
                    },
                };
            } else {
                let statusText = "INTERNAL";
                if (statusCode === 400) statusText = "INVALID_ARGUMENT";
                else if (statusCode === 429) statusText = "RESOURCE_EXHAUSTED";
                else if (statusCode === 504) statusText = "DEADLINE_EXCEEDED";
                else if (statusCode === 503) statusText = "UNAVAILABLE";
                errorPayload = {
                    error: {
                        code: statusCode,
                        message,
                        status: statusText,
                    },
                };
            }

            this._markTrackedResponseError(res, message, statusCode);
            res.status(statusCode).type("application/json").send(JSON.stringify(errorPayload));
        }
    }

    _sendErrorChunkToClient(res, message, statusCode = 500, errorType = null) {
        const format = this._resolveErrorFormat(res);
        const resolvedErrorType = errorType || this._getDefaultErrorType(format, statusCode);
        if (!res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
        }
        this._markTrackedResponseError(res, message, statusCode);
        // Check if response is still writable before attempting to write
        if (this._isResponseWritable(res)) {
            try {
                if (format === "response_api") {
                    if (res.__responseApiSeq == null) res.__responseApiSeq = -1;
                    res.__responseApiSeq += 1;
                    res.write(
                        `event: error\ndata: ${JSON.stringify({
                            code: resolvedErrorType,
                            message,
                            param: null,
                            sequence_number: res.__responseApiSeq,
                            type: "error",
                        })}\n\n`
                    );
                } else if (format === "claude") {
                    res.write(
                        `event: error\ndata: ${JSON.stringify({
                            error: {
                                message,
                                type: resolvedErrorType,
                            },
                            type: "error",
                        })}\n\n`
                    );
                } else if (format === "openai") {
                    res.write(
                        `data: ${JSON.stringify({
                            error: {
                                code: statusCode,
                                message,
                                type: resolvedErrorType,
                            },
                        })}\n\n`
                    );
                } else {
                    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
                }
            } catch (writeError) {
                this.logger.debug(`[Request] Failed to write error chunk to client: ${writeError.message}`);
            }
        }
    }

    /**
     * Handle queue timeout by notifying browser to cancel the request
     * @param {Error} error - The timeout error
     * @param {string} requestId - The request ID
     */
    _handleQueueTimeout(error, requestId) {
        if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
            // Get the authIndex for this request from the registry
            const authIndex = this.connectionRegistry.getAuthIndexForRequest(requestId);
            const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);
            if (authIndex !== null) {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, notifying browser on account #${authIndex} to cancel`
                );
                this._cancelBrowserRequest(requestId, authIndex, requestAttemptId);
            } else {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, but queue already removed (authIndex not found)`
                );
            }
        }
    }

    _resolveErrorFormat(res) {
        const trackedFormat = res?.__proxyApiFormat;
        if (trackedFormat && trackedFormat !== "upload") return trackedFormat;
        return "gemini";
    }

    _getDefaultErrorType(format, statusCode) {
        if (statusCode === 429) return "rate_limit_error";
        if (statusCode === 504) return "timeout_error";
        if (statusCode === 503) {
            return format === "claude" ? "overloaded_error" : "service_unavailable";
        }
        return "api_error";
    }
}

module.exports = ErrorHandler;
