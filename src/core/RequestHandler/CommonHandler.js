/**
 * File: src/core/RequestHandler/CommonHandler.js
 * Description: Shared request handler context, auth accessors, usage tracking, and response writability.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AuthSwitcher = require("../../auth/AuthSwitcher");
const FormatConverter = require("../FormatConverter");
const ModelChannel = require("../ModelChannel");
const PlaygroundTransport = require("../Playground/Transport");
const { DEFAULT_TIMEOUTS } = require("./constants");

class RequestHandler {
    constructor(serverSystem, connectionRegistry, logger, browserManager, config, authSource) {
        this.serverSystem = serverSystem;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.config = config;
        this.authSource = authSource;

        // Initialize sub-modules
        this.authSwitcher = new AuthSwitcher(logger, config, authSource, browserManager);
        // index.js mounts the API modules onto this instance's prototype at runtime.
        this.formatConverter =
            /** @type {FormatConverter &
             * import("../FormatConverter/ChatCompletionsConverter") &
             * import("../FormatConverter/EmbeddingsConverter") &
             * import("../FormatConverter/ClaudeRequestConverter") &
             * import("../FormatConverter/ClaudeResponseConverter") &
             * import("../FormatConverter/ResponsesRequestConverter") &
             * import("../FormatConverter/ResponsesStreamResponseConverter") &
             * import("../FormatConverter/ResponsesNonStreamResponseConverter")}
             */ (new FormatConverter(logger, serverSystem));

        this.playground = new PlaygroundTransport(this);
        this.needsSwitchingAfterRequest = false;

        // Round-robin cursor for multi-account dispatch: rotates among equally
        // least-loaded ready accounts so a single account is not always preferred
        this._dispatchCursor = 0;

        // Timeout settings
        this.timeouts = {
            FAKE_STREAM: this.config.fakeStreamTimeoutMs || DEFAULT_TIMEOUTS.FAKE_STREAM,
            STREAM_CHUNK: this.config.streamTimeoutMs || DEFAULT_TIMEOUTS.STREAM_CHUNK,
        };
    }

    // Delegate properties to AuthSwitcher
    get currentAuthIndex() {
        return this.authSwitcher.currentAuthIndex;
    }

    get failureCount() {
        return this.authSwitcher.failureCount;
    }

    get usageCount() {
        return this.authSwitcher.usageCount;
    }

    get isSystemBusy() {
        return this.authSwitcher.isSystemBusy;
    }

    set isSystemBusy(value) {
        this.authSwitcher.isSystemBusy = value === true;
    }

    /** Public model metadata per channel; names carry the channel prefix (`models/build-…`, `models/pg-…`). */
    channelModels() {
        const publish = (channel, models) =>
            models.map(model => ({ ...model, name: `models/${ModelChannel.publicName(channel, model.name)}` }));
        return {
            build: publish("build", this.config.modelList || []),
            playground: publish("playground", this.playground.models()),
        };
    }

    /**
     * Requests for a `pg-` model are rejected up front unless they generate content: Playground has
     * no anti-truncation, token counting, embeddings, uploads or model lookup.
     * @returns {string|null} Reason for rejecting the request, or null when it may proceed.
     */
    _unsupportedPlaygroundRequest(req) {
        const pathMatch = req.path.match(/\/models\/([^/:]+)(?::([A-Za-z]+))?/);
        let named = pathMatch ? pathMatch[1] : req.body?.model;
        try {
            named = decodeURIComponent(named);
        } catch {
            // Keep the raw name.
        }
        const { channel, model } = ModelChannel.parse(typeof named === "string" ? named : "");
        if (channel !== "playground") return null;
        if (!this.playground.enabled) return "The Playground channel is disabled (PLAYGROUND_ENABLED=false).";
        if (model.includes("抗截断")) return "Playground models do not support anti-truncation.";
        const generates = pathMatch
            ? req.method === "POST" && ["generateContent", "streamGenerateContent"].includes(pathMatch[2])
            : ["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(req.path);
        return generates ? null : "Playground models only support content generation.";
    }

    _getUsageStatsService() {
        return this.serverSystem.usageStatsService || null;
    }

    _getAccountNameForIndex(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return null;
        }

        return this.authSource?.accountNameMap?.get(authIndex) || null;
    }

    _getClientIp(req) {
        return this.serverSystem.webRoutes.authRoutes.getClientIP(req);
    }

    _categorizeRequest(pathValue, fallback = "request") {
        if (typeof pathValue !== "string") return fallback;
        if (
            pathValue.includes("embedContent") ||
            pathValue.includes("batchEmbedContents") ||
            pathValue.includes("embeddings")
        )
            return "embedding";
        if (pathValue.includes("countTokens") || pathValue.includes("input_tokens")) return "count_tokens";
        if (pathValue.includes("generateContent") || pathValue.includes("streamGenerateContent")) return "generation";
        if (pathValue.includes("/upload/")) return "upload";
        return fallback;
    }

    _setResponseApiFormat(res, apiFormat) {
        if (!res || !apiFormat) return;
        res.__proxyApiFormat = apiFormat;
    }

    _startTrackedRequest(requestId, req, meta = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        usageStatsService.startRequest(requestId, {
            clientIp: this._getClientIp(req),
            initialAccountName: this._getAccountNameForIndex(this.currentAuthIndex),
            initialAuthIndex: this.currentAuthIndex,
            method: req.method,
            path: req.path,
            ...meta,
        });
    }

    _updateTrackedRequest(requestId, patch = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;
        usageStatsService.updateRequest(requestId, patch);
    }

    _finalizeTrackedRequest(requestId, res, overrides = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        let outcome = overrides.outcome;
        if (!outcome) {
            if (res.__usageTrackingClientAborted) {
                outcome = "aborted";
            } else if (res.__usageTrackingOutcome) {
                outcome = res.__usageTrackingOutcome;
            } else {
                const statusCode = Number.isFinite(res.statusCode) ? Number(res.statusCode) : null;
                outcome = statusCode !== null && statusCode >= 400 ? "error" : "success";
            }
        }

        const statusCode =
            overrides.statusCode ??
            res.__usageTrackingErrorStatus ??
            (Number.isFinite(res.statusCode) && res.statusCode > 0 ? Number(res.statusCode) : null);

        const errorMessage =
            overrides.errorMessage ??
            res.__usageTrackingErrorMessage ??
            (outcome === "error" ? "Request failed" : null);

        usageStatsService.finishRequest(requestId, {
            errorMessage,
            finalAccountName: overrides.finalAccountName,
            finalAuthIndex: overrides.finalAuthIndex,
            outcome,
            statusCode,
        });
    }

    _markTrackedResponseError(res, message, statusCode = null, outcome = "error") {
        if (!res) return;
        res.__usageTrackingOutcome = outcome;
        res.__usageTrackingErrorMessage = message || null;
        if (Number.isFinite(statusCode)) {
            res.__usageTrackingErrorStatus = Number(statusCode);
        }
    }

    _markTrackedClientAbort(res, message = "Client disconnected") {
        if (!res) return;
        res.__usageTrackingClientAborted = true;
        res.__usageTrackingOutcome = "aborted";
        res.__usageTrackingErrorMessage = message;
    }

    _generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    _isResponseWritable(res) {
        // Comprehensive check to ensure response is writable
        // Explicitly return boolean to avoid returning null/undefined from res.socket check
        return Boolean(
            !res.writableEnded && !res.destroyed && res.socket && !res.socket.destroyed && res.socket.writable !== false
        );
    }
}

module.exports = RequestHandler;
