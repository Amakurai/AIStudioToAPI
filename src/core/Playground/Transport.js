const crypto = require("crypto");
const AntiTruncation = require("../AntiTruncation");
const PlaygroundCatalog = require("./Catalog");
const PlaygroundSession = require("./Session");
const { WireCodec, WireStream } = require("./WireCodec");
const { DEFAULT_TIMEOUTS } = require("../RequestHandler/constants");

/** Playground generation channel: serves `pg-` models on each account's existing browser context. */
class PlaygroundTransport {
    constructor(handler) {
        this.handler = handler;
        this.sessions = new WeakMap();
        this.cooldowns = new Map();
        this.catalog = new PlaygroundCatalog(handler.config, handler.logger);
    }
    get enabled() {
        return !!this.handler.config.playgroundEnabled;
    }
    models() {
        return this.enabled ? this.catalog.models() : [];
    }
    cooldownKey(model, authIndex) {
        const name = this.handler.authSource?.accountNameMap?.get(authIndex);
        // Duplicate auth files of one email share a cooldown; other accounts are unaffected.
        const identity =
            typeof name === "string" && name.includes("@") ? name.trim().toLowerCase() : `index:${authIndex}`;
        return crypto.createHash("sha256").update(`${identity}\n${model}`).digest("hex");
    }
    cooldownUntil(model, authIndex) {
        return this.cooldowns.get(this.cooldownKey(model, authIndex)) || 0;
    }
    fail(model, authIndex, status) {
        if (![401, 403, 429, 502, 503, 504].includes(status)) return;
        const ms = status === 401 || status === 403 ? 300000 : 60000;
        this.cooldowns.set(this.cooldownKey(model, authIndex), Date.now() + ms);
    }
    /** Starts a Playground generation for a request whose path names the upstream (unprefixed) model. */
    forward(spec, authIndex) {
        const entry = this.handler.connectionRegistry.messageQueues.get(spec.request_id);
        if (!entry || entry.queue.closed) return;
        const match = spec.path?.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        // Public routes reject these up front; reject here too instead of reaching Build or the page.
        const rejection = !this.enabled
            ? "The Playground channel is disabled (PLAYGROUND_ENABLED=false)."
            : !match
              ? "Playground models only support generateContent and streamGenerateContent."
              : AntiTruncation.baseModel(match[1])
                ? "Playground models do not support anti-truncation."
                : null;
        if (rejection) {
            entry.queue.enqueue({ event_type: "error", message: rejection, retryable: false, status: 400 });
            return;
        }
        let model = match[1];
        try {
            model = decodeURIComponent(model);
        } catch {
            // Keep the raw name; upstream reports an unknown model.
        }
        const controller = new AbortController();
        entry.playgroundAbort = controller;
        void this._run(spec, authIndex, entry, model, controller);
    }
    cancel(requestId, attemptId) {
        const entry = this.handler.connectionRegistry.messageQueues.get(requestId);
        if (!entry?.playgroundAbort || (attemptId && entry.requestAttemptId !== attemptId)) return false;
        entry.playgroundAbort.abort();
        return true;
    }
    async _run(spec, authIndex, entry, model, controller) {
        const { queue } = entry;
        const requestStartedAt = Date.now();
        let stage = "start";
        const reportStage = value => {
            stage = value;
            this.handler.logger.info(
                `[Playground] ${spec.request_id} account=#${authIndex} stage=${stage} elapsedMs=${Date.now() - requestStartedAt}`
            );
        };
        const registry = this.handler.connectionRegistry;
        const active = () =>
            !queue.closed &&
            !controller.signal.aborted &&
            registry.messageQueues.get(spec.request_id) === entry &&
            entry.requestAttemptId === spec.request_attempt_id;
        const abort = () => controller.abort();
        queue.once("close", abort);
        const timeoutMs = this.handler.timeouts.FAKE_STREAM;
        // Like Build real streaming, a visible stream is bounded by inactivity, not total duration.
        const idleTimeoutMs = this.handler.timeouts.STREAM_CHUNK || DEFAULT_TIMEOUTS.STREAM_CHUNK;
        let timedOut = false;
        let timer;
        const arm = ms => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, ms);
        };
        arm(timeoutMs);
        let started = false;
        const realStream = spec.streaming_mode === "real" && spec.path.endsWith(":streamGenerateContent");
        const merged = {};
        let completed = false;
        const headers = () => {
            if (started || !active()) return;
            started = true;
            queue.enqueue({
                event_type: "response_headers",
                headers: {
                    "content-type": realStream ? "text/event-stream" : "application/json",
                    "x-aistudio-channel": "playground",
                },
                status: 200,
            });
        };
        try {
            if (this.cooldownUntil(model, authIndex) > Date.now())
                throw Object.assign(new Error("Playground channel is cooling down for this account and model"), {
                    coolingDown: true,
                    status: 503,
                });
            const context = this.handler.browserManager.contexts.get(authIndex)?.context;
            if (!context) throw Object.assign(new Error("Playground account context is unavailable"), { status: 503 });
            let session = this.sessions.get(context);
            if (!session) {
                session = new PlaygroundSession(context, raw => this.catalog.discover(raw));
                this.sessions.set(context, session);
            }
            const parser = new WireStream(raw => {
                const chunk = WireCodec.decode(raw, model);
                completed ||= !!chunk.candidates?.some(c => c.finishReason) || !!chunk.promptFeedback?.blockReason;
                if (!realStream) WireCodec.merge(merged, chunk);
                if (realStream && active()) {
                    headers();
                    queue.enqueue({ data: `data: ${JSON.stringify(chunk)}\n\n`, event_type: "chunk" });
                }
            });
            this.handler.logger.info(`[Playground] ${model} (account #${authIndex}).`);
            await session.request(model, JSON.parse(spec.body), {
                onData: value => {
                    if (!active() || typeof value !== "string") return;
                    parser.feed(value);
                    if (started) arm(idleTimeoutMs);
                },
                onStage: reportStage,
                signal: controller.signal,
                timeoutMs,
            });
            if (!active()) return;
            parser.finish();
            if (!completed) {
                throw Object.assign(new Error("Playground response ended without a finish reason"), {
                    retryable: false,
                    status: 502,
                });
            }
            this.cooldowns.delete(this.cooldownKey(model, authIndex));
            if (!realStream) {
                headers();
                queue.enqueue({ data: JSON.stringify(merged), event_type: "chunk" });
            }
            queue.enqueue({ type: "STREAM_END" });
        } catch (error) {
            const upstreamStatus = Number(error.status) || 502;
            // Waiting behind this account's active Playground request says nothing about the
            // account's health and nothing was dispatched: retry elsewhere without a cooldown.
            const queuedTimeout = timedOut && stage === "queued";
            this.handler.logger.warn(
                `[Playground] ${spec.request_id} account=#${authIndex} failedStage=${stage} status=${timedOut ? 504 : upstreamStatus} elapsedMs=${Date.now() - requestStartedAt}`
            );
            const unavailableAccount =
                !started &&
                (upstreamStatus === 401 ||
                    (upstreamStatus === 403 && /permission|PERMISSION_DENIED/i.test(error.message)));
            if (!error.coolingDown && !queuedTimeout && (!controller.signal.aborted || timedOut))
                this.fail(model, authIndex, timedOut ? 504 : upstreamStatus);
            if (
                !queue.closed &&
                registry.messageQueues.get(spec.request_id) === entry &&
                entry.requestAttemptId === spec.request_attempt_id
            ) {
                queue.enqueue({
                    event_type: "error",
                    message: queuedTimeout
                        ? "Playground account is busy; request timed out while queued"
                        : timedOut
                          ? "Playground request timed out"
                          : error.message,
                    retryable: started ? false : queuedTimeout ? undefined : error.retryable,
                    // Let the existing bounded account-switch mechanism handle an unavailable
                    // (or busy) Playground account on its first failure, not only during its cooldown.
                    status: queuedTimeout ? 503 : timedOut ? 504 : unavailableAccount ? 503 : upstreamStatus,
                });
            }
        } finally {
            clearTimeout(timer);
            queue.removeListener("close", abort);
            if (entry.playgroundAbort === controller) delete entry.playgroundAbort;
        }
    }
}

module.exports = PlaygroundTransport;
