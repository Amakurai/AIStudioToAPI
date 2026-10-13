const fs = require("fs");
const path = require("path");
const AntiTruncation = require("./AntiTruncation");
const PlaygroundSession = require("./Playground/Session");
const { WireCodec, WireStream } = require("./Playground/WireCodec");

class ModelRouter {
    constructor(handler) {
        this.handler = handler;
        this.sessions = new WeakMap();
        this.routes = new Map([["gemini-4-argon", "playground"]]);
        this.routeFile = handler.config.modelRoutesPath || path.join(process.cwd(), "data", "model-routes.json");
        if (handler.config.playgroundEnabled) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.routeFile, "utf8"));
                for (const [model, channel] of Object.entries(saved)) {
                    if (/^[a-z0-9._-]+$/.test(model) && channel === "playground") this.routes.set(model, channel);
                }
            } catch (error) {
                if (error.code !== "ENOENT")
                    handler.logger.warn(`[Routing] Could not load saved model routes: ${error.message}`);
            }
        }
    }
    channel(model) {
        const normalized = String(model || "").replace(/^models\//, "");
        return (
            (this.handler.config.playgroundEnabled &&
                this.routes.get(AntiTruncation.baseModel(normalized) || normalized)) ||
            "build"
        );
    }
    groups() {
        const groups = { build: [], playground: [] };
        for (const model of this.handler.config.modelList || []) {
            groups[this.channel(model.name)].push(model.name.replace(/^models\//, ""));
        }
        return groups;
    }
    remember(model) {
        if (this.routes.get(model) === "playground") return;
        this.routes.set(model, "playground");
        try {
            fs.mkdirSync(path.dirname(this.routeFile), { recursive: true });
            fs.writeFileSync(`${this.routeFile}.tmp`, JSON.stringify(Object.fromEntries(this.routes), null, 2) + "\n");
            fs.renameSync(`${this.routeFile}.tmp`, this.routeFile);
        } catch (error) {
            this.handler.logger.warn(`[Routing] Could not save model routes: ${error.message}`);
        }
    }
    discover(raw) {
        const models = this.handler.config.modelList;
        if (!Array.isArray(models)) return;
        for (const m of raw?.[0] || []) {
            if (!Array.isArray(m) || typeof m[0] !== "string" || !m[0].startsWith("models/")) continue;
            if (!m[7]?.includes("generateContent")) continue;
            const existing = models.find(x => x.name === m[0]);
            if (existing) {
                if (this.channel(m[0]) === "playground") {
                    if (Number.isFinite(m[5])) existing.inputTokenLimit = m[5];
                    if (Number.isFinite(m[6])) existing.outputTokenLimit = m[6];
                }
                continue;
            }
            models.push({
                description: m[4] || "",
                displayName: m[3] || m[0],
                inputTokenLimit: m[5],
                name: m[0],
                outputTokenLimit: m[6],
                supportedGenerationMethods: ["generateContent"],
            });
            this.remember(m[0].slice(7));
        }
    }
    static canFallback(message) {
        if (message.event_type !== "error") return false;
        const status = Number(message.status);
        const detail = message.message || "";
        return (
            (status === 403 && /PERMISSION_DENIED|caller does not have permission/i.test(detail)) ||
            (status === 404 && /model|not found/i.test(detail)) ||
            (status === 429 && /limit:\s*0\b/.test(detail))
        );
    }
    forward(spec, authIndex) {
        if (!this.handler.config.playgroundEnabled) return false;
        const match = spec.path?.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        if (!match) return false;
        const model = decodeURIComponent(match[1]);
        const entry = this.handler.connectionRegistry.messageQueues.get(spec.request_id);
        if (!entry || entry.queue.closed) return false;
        if (this.channel(model) === "playground") {
            this._start(spec, authIndex, entry, model);
            return true;
        }
        // Only the current queue and attempt can invoke this callback (registry validates both).
        let committed = false;
        let switched = false;
        entry.onUpstreamMessage = message => {
            if (switched) return true;
            if (!committed && ModelRouter.canFallback(message)) {
                switched = true;
                this.handler.logger.info(
                    `[Routing] ${model}: Build ${message.status}; trying Playground on account #${authIndex}.`
                );
                this._start(spec, authIndex, entry, model);
                return true;
            }
            if (message.event_type === "chunk" || (message.event_type === "response_headers" && message.status < 400))
                committed = true;
            return false;
        };
        return false;
    }
    cancel(requestId, attemptId) {
        const entry = this.handler.connectionRegistry.messageQueues.get(requestId);
        if (!entry?.playgroundAbort || (attemptId && entry.requestAttemptId !== attemptId)) return false;
        entry.playgroundAbort.abort();
        return true;
    }
    _start(spec, authIndex, entry, model) {
        const controller = new AbortController();
        entry.playgroundAbort = controller;
        void this._run(spec, authIndex, entry, model, controller);
    }
    async _run(spec, authIndex, entry, model, controller) {
        const { queue } = entry;
        const registry = this.handler.connectionRegistry;
        const active = () =>
            !queue.closed &&
            !controller.signal.aborted &&
            registry.messageQueues.get(spec.request_id) === entry &&
            entry.requestAttemptId === spec.request_attempt_id;
        const abort = () => controller.abort();
        queue.once("close", abort);
        const timeoutMs = this.handler.timeouts.FAKE_STREAM;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        let started = false;
        const realStream = spec.streaming_mode === "real" && spec.path.endsWith(":streamGenerateContent");
        const merged = {};
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
            const context = this.handler.browserManager.contexts.get(authIndex)?.context;
            if (!context) throw Object.assign(new Error("Playground account context is unavailable"), { status: 503 });
            let session = this.sessions.get(context);
            if (!session) {
                session = new PlaygroundSession(context, raw => this.discover(raw));
                this.sessions.set(context, session);
            }
            const parser = new WireStream(raw => {
                const chunk = WireCodec.decode(raw, model);
                WireCodec.merge(merged, chunk);
                if (realStream && active()) {
                    headers();
                    queue.enqueue({ data: `data: ${JSON.stringify(chunk)}\n\n`, event_type: "chunk" });
                }
            });
            this.handler.logger.info(`[Routing] ${model} -> Playground (account #${authIndex}).`);
            await session.request(model, JSON.parse(spec.body), {
                onData: value => {
                    if (active() && typeof value === "string") parser.feed(value);
                },
                signal: controller.signal,
                timeoutMs,
            });
            if (!active()) return;
            parser.finish();
            if (!merged.candidates?.some(c => c.finishReason) && !merged.promptFeedback?.blockReason) {
                throw Object.assign(new Error("Playground response ended without a finish reason"), {
                    retryable: false,
                    status: 502,
                });
            }
            this.remember(model);
            if (!realStream) {
                headers();
                queue.enqueue({ data: JSON.stringify(merged), event_type: "chunk" });
            }
            queue.enqueue({ type: "STREAM_END" });
        } catch (error) {
            if (
                !queue.closed &&
                registry.messageQueues.get(spec.request_id) === entry &&
                entry.requestAttemptId === spec.request_attempt_id
            ) {
                queue.enqueue({
                    event_type: "error",
                    message: timedOut ? "Playground request timed out" : error.message,
                    retryable: started ? false : error.retryable,
                    status: timedOut ? 504 : Number(error.status) || 502,
                });
            }
        } finally {
            clearTimeout(timer);
            queue.removeListener("close", abort);
            if (entry.playgroundAbort === controller) delete entry.playgroundAbort;
        }
    }
}
module.exports = ModelRouter;
