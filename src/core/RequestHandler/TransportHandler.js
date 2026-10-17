/**
 * File: src/core/RequestHandler/TransportHandler.js
 * Description: Response headers, client disconnects, request cancellation, forwarding, and browser log level control.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AntiTruncation = require("../AntiTruncation");
const ModelChannel = require("../ModelChannel");

const RequestHandler = require("./CommonHandler");

class TransportHandler extends RequestHandler {
    _setResponseHeaders(res, headerMessage, req) {
        res.status(headerMessage.status || 200);
        const headers = headerMessage.headers || {};

        // Filter headers that might cause CORS conflicts
        const forbiddenHeaders = [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
        ];

        Object.entries(headers).forEach(([name, value]) => {
            const lowerName = name.toLowerCase();
            if (forbiddenHeaders.includes(lowerName)) return;
            if (lowerName === "content-length") return;

            // Special handling for upload URL and redirects: point them back to this proxy
            if (lowerName === "x-goog-upload-url" && value.includes("googleapis.com")) {
                try {
                    const urlObj = new URL(value);
                    // Rewrite upload/redirect URLs to point to this proxy server
                    // build.js already rewrote the URL to localhost with __proxy_host__ param
                    // Here we just ensure it matches the client's request host (for Docker/remote access)
                    let newAuthority;
                    if (req && req.headers && req.headers.host) {
                        newAuthority = req.headers.host;
                    } else {
                        const host = this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host;
                        newAuthority = `${host}:${this.config.httpPort}`;
                    }

                    const protocol =
                        req.secure || (req.get && req.get("X-Forwarded-Proto") === "https") ? "https" : "http";
                    const newUrl = `${protocol}://${newAuthority}${urlObj.pathname}${urlObj.search}`;

                    this.logger.debug(`[Response] Debug: Rewriting header ${name}: ${value} -> ${newUrl}`);
                    res.set(name, newUrl);
                } catch (e) {
                    res.set(name, value);
                }
            } else {
                res.set(name, value);
            }
        });
    }

    _setupClientDisconnectHandler(res, requestId) {
        res.on("close", () => {
            if (!res.writableEnded) {
                this._markTrackedClientAbort(res);
                this.logger.warn(`[Request] Client closed request #${requestId} connection prematurely.`);

                // Dynamically look up the current authIndex from the connection registry
                // This ensures we cancel on the correct account even after retries switch accounts
                const targetAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
                const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);

                this._cancelBrowserRequest(requestId, targetAuthIndex, requestAttemptId);
                // Close and remove the message queue to unblock any waiting dequeue() calls
                this.connectionRegistry.removeMessageQueue(requestId, "client_disconnect");
            }
        });
    }

    _cancelBrowserRequest(requestId, authIndex, requestAttemptId = null) {
        if (this.playground?.cancel(requestId, requestAttemptId)) return;
        const targetAuthIndex = authIndex !== undefined ? authIndex : this.currentAuthIndex;
        const connection = this.connectionRegistry.getConnectionByAuth(targetAuthIndex);
        if (connection) {
            this.logger.info(
                `[Request] Cancelling request #${requestId} on account #${targetAuthIndex}` +
                    (requestAttemptId ? ` (attempt ${requestAttemptId})` : "")
            );
            try {
                connection.send(
                    JSON.stringify({
                        event_type: "cancel_request",
                        request_attempt_id: requestAttemptId,
                        request_id: requestId,
                    })
                );
            } catch (error) {
                // A closed socket must not prevent the caller from releasing local queues.
                this.logger.warn(`[Request] Failed to send cancellation for ${requestId}: ${error.message}`);
            }
        } else {
            this.logger.warn(
                `[Request] Unable to send cancel instruction: No available WebSocket connection for account #${targetAuthIndex}.`
            );
        }
    }

    _cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex) {
        if (!Number.isInteger(currentQueueAuthIndex) || currentQueueAuthIndex < 0) {
            this.logger.debug(
                `[Request] Skipping retry cancellation for request #${proxyRequest.request_id}: invalid auth index ${currentQueueAuthIndex}.`
            );
            return;
        }
        this._cancelBrowserRequest(proxyRequest.request_id, currentQueueAuthIndex, proxyRequest.request_attempt_id);
    }

    /**
     * Pick the upstream channel from the model prefix once per request and remove the prefix
     * from the path and body, so each transport only sees upstream model names.
     */
    _resolveProxyRequestChannel(proxyRequest) {
        if (proxyRequest.channel) return;
        const match = proxyRequest.path?.match(/^(.*\/models\/)([^/:?]+)(.*)$/);
        let body;
        if (typeof proxyRequest.body === "string" && /"(?:models\/)?(?:build|pg)-/.test(proxyRequest.body)) {
            try {
                body = JSON.parse(proxyRequest.body);
            } catch {
                // Not JSON (e.g. uploads); only the path can carry a model.
            }
        }
        const named = match ? match[2] : body?.model;
        const { channel, model, prefixed } = ModelChannel.parse(named);
        proxyRequest.channel = channel;
        if (channel === "playground" && !this.playground?.enabled) {
            throw Object.assign(new Error("The Playground channel is disabled (PLAYGROUND_ENABLED=false)."), {
                status: 400,
            });
        }
        if (channel === "playground" && AntiTruncation.baseModel(model)) {
            throw Object.assign(new Error("Playground models do not support anti-truncation."), { status: 400 });
        }
        if (!prefixed) return;
        if (match) proxyRequest.path = `${match[1]}${model}${match[3]}`;
        if (!body) return;
        const strip = value => (typeof value === "string" ? `models/${ModelChannel.parse(value).model}` : value);
        if (!match && typeof body.model === "string") body.model = ModelChannel.parse(body.model).model;
        if (body.generateContentRequest?.model)
            body.generateContentRequest.model = strip(body.generateContentRequest.model);
        if (Array.isArray(body.requests))
            for (const request of body.requests) if (request?.model) request.model = strip(request.model);
        proxyRequest.body = JSON.stringify(body);
    }

    _initializeProxyRequestAttempt(proxyRequest) {
        this._resolveProxyRequestChannel(proxyRequest);
        const match = proxyRequest.path?.match(/^(.*\/models\/)([^/:]+)(:[^?]+.*)$/);
        const baseModel = proxyRequest.channel === "build" && match && AntiTruncation.baseModel(match[2]);
        if (baseModel) {
            proxyRequest.path = `${match[1]}${baseModel}${match[3]}`;
            if (proxyRequest.body && match[3] === ":countTokens") {
                const body = JSON.parse(proxyRequest.body);
                if (body.generateContentRequest?.model) body.generateContentRequest.model = `models/${baseModel}`;
                proxyRequest.body = JSON.stringify(body);
            }
            if (
                proxyRequest.is_generative &&
                /:(?:streamGenerateContent|generateContent)$/.test(proxyRequest.path) &&
                (proxyRequest.anti_truncation_mode === "duplex" || !this._antiTruncationFallback(proxyRequest))
            ) {
                proxyRequest.anti_truncation = true;
                proxyRequest.anti_truncation_mode = "duplex";
                proxyRequest.streaming_mode = "fake";
            }
        }
        if (!proxyRequest.request_attempt_number) {
            proxyRequest.request_attempt_number = 1;
        }
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _antiTruncationFallback(proxyRequest) {
        let body;
        try {
            body = typeof proxyRequest.body === "string" ? JSON.parse(proxyRequest.body) : proxyRequest.body;
        } catch {
            return false;
        }
        if (!AntiTruncation.requiresOriginalModel(body)) return false;
        this.logger.info(
            `[AntiTruncation] Request #${proxyRequest.request_id} carries tools or cachedContent; ` +
                "forwarding to the base model without anti-truncation."
        );
        return true;
    }

    _advanceProxyRequestAttempt(proxyRequest) {
        proxyRequest.request_attempt_number = (proxyRequest.request_attempt_number || 1) + 1;
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _forwardRequest(proxyRequest, authIndex = this.currentAuthIndex) {
        if (proxyRequest.anti_truncation) {
            void AntiTruncation.forward(this, proxyRequest, authIndex);
            return;
        }
        if (proxyRequest.channel === "playground") {
            this.playground.forward(proxyRequest, authIndex);
            return;
        }
        const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
        if (connection) {
            this.logger.debug(
                `[Request] Forwarding request #${proxyRequest.request_id} via connection for authIndex=${authIndex}` +
                    ` (attempt=${proxyRequest.request_attempt_id})`
            );
            connection.send(
                JSON.stringify({
                    event_type: "proxy_request",
                    ...proxyRequest,
                })
            );
        } else {
            throw new Error(`Unable to forward request: No WebSocket connection found for authIndex=${authIndex}`);
        }
    }

    /**
     * Set browser (build.js) log level at runtime for all active contexts
     * @param {string} level - 'DEBUG', 'INFO', 'WARN', or 'ERROR'
     * @returns {number} Number of browser contexts updated (0 if none)
     */
    setBrowserLogLevel(level) {
        const validLevels = ["DEBUG", "INFO", "WARN", "ERROR"];
        const upperLevel = level?.toUpperCase();

        if (!validLevels.includes(upperLevel)) {
            return 0;
        }

        // Broadcast to all active browser contexts
        const sentCount = this.connectionRegistry.broadcastMessage(
            JSON.stringify({
                event_type: "set_log_level",
                level: upperLevel,
            })
        );

        if (sentCount > 0) {
            this.logger.info(`[Config] Browser log level set to: ${upperLevel} (${sentCount} context(s) updated)`);

            // Also update server-side LoggingService level to keep in sync
            const LoggingService = require("../../utils/LoggingService");
            LoggingService.setLevel(upperLevel);
            this.logger.info(`[Config] Server log level synchronized to: ${upperLevel}`);

            return sentCount;
        } else {
            this.logger.warn(`[Config] Unable to set browser log level: No active WebSocket connections.`);
            return 0;
        }
    }

    _generateRequestAttemptId(requestId, attemptNumber) {
        return `${requestId}_attempt_${attemptNumber}_${Math.random().toString(36).substring(2, 8)}`;
    }
}

module.exports = TransportHandler;
