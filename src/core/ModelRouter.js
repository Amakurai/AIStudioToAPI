const fs = require("fs");
const path = require("path");
const AntiTruncation = require("./AntiTruncation");
const PlaygroundSession = require("./Playground/Session");
const { WireCodec, WireStream } = require("./Playground/WireCodec");
const { DEFAULT_TIMEOUTS } = require("./RequestHandler/constants");

class ModelRouter {
    constructor(handler) {
        this.handler = handler;
        this.sessions = new WeakMap();
        this.routes = new Map([["gemini-4-argon", "playground"]]);
        this.routeFile = handler.config.modelRoutesPath || path.join(process.cwd(), "data", "model-routes.json");
        this.accounts = {};
        this.catalog = [];
        if (handler.config.playgroundEnabled) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.routeFile, "utf8"));
                // Legacy global learned routes cannot establish another account's entitlement.
                if (saved.version === 2) {
                    this.accounts = saved.accounts || {};
                    this.restoreCatalog(saved.models || []);
                }
            } catch (error) {
                if (error.code !== "ENOENT")
                    handler.logger.warn(`[Routing] Could not load saved model routes: ${error.message}`);
            }
        }
    }
    accountKey(authIndex) {
        const name = this.handler.authSource?.accountNameMap?.get(authIndex);
        const identity =
            typeof name === "string" && name.includes("@") ? name.trim().toLowerCase() : `index:${authIndex}`;
        return require("crypto").createHash("sha256").update(identity).digest("hex");
    }
    record(model, authIndex) {
        return this.accounts[this.accountKey(authIndex)]?.[model];
    }
    channel(model, authIndex) {
        if (!this.handler.config.playgroundEnabled) return "build";
        const normalized = String(model || "").replace(/^models\//, "");
        const base = AntiTruncation.baseModel(normalized) || normalized;
        const learned = authIndex === undefined ? null : this.record(base, authIndex);
        if (learned?.channel === "playground" && Date.now() - learned.successAt < 86400000) return "playground";
        return this.routes.get(base) || "build";
    }
    save() {
        try {
            fs.mkdirSync(path.dirname(this.routeFile), { recursive: true });
            fs.writeFileSync(
                `${this.routeFile}.tmp`,
                JSON.stringify({ accounts: this.accounts, models: this.catalog, version: 2 }, null, 2) + "\n"
            );
            fs.renameSync(`${this.routeFile}.tmp`, this.routeFile);
        } catch (error) {
            this.handler.logger.warn(`[Routing] Could not save model routes: ${error.message}`);
        }
    }
    restoreCatalog(models) {
        for (const model of models) {
            if (!model || !/^models\/[a-z0-9._-]+$/.test(model.name)) continue;
            const existing = this.handler.config.modelList?.find(m => m.name === model.name);
            if (!existing) {
                this.handler.config.modelList?.push(model);
                this.routes.set(model.name.slice(7), "playground");
            } else if (this.routes.has(model.name.slice(7))) {
                for (const key of ["inputTokenLimit", "outputTokenLimit"])
                    if (Number.isFinite(model[key])) existing[key] = model[key];
            }
            this.catalog.push(model);
        }
    }
    groups() {
        const groups = { build: [], playground: [] };
        for (const model of this.handler.config.modelList || []) {
            groups[this.channel(model.name)].push(model.name.replace(/^models\//, ""));
        }
        return groups;
    }
    remember(model, authIndex) {
        const key = this.accountKey(authIndex);
        this.accounts[key] ||= {};
        this.accounts[key][model] = { channel: "playground", failedUntil: 0, successAt: Date.now() };
        this.save();
    }
    fail(model, authIndex, status) {
        if (![401, 403, 429, 502, 503, 504].includes(status)) return;
        const key = this.accountKey(authIndex);
        this.accounts[key] ||= {};
        this.accounts[key][model] = {
            ...this.accounts[key][model],
            failedUntil: Date.now() + (status === 401 || status === 403 ? 300000 : 60000),
            lastFailureAt: Date.now(),
        };
        this.save();
    }
    discover(raw) {
        const models = this.handler.config.modelList;
        if (!Array.isArray(models)) return;
        const catalog = new Map(this.catalog.map(m => [m.name, m]));
        for (const m of raw?.[0] || []) {
            if (
                !Array.isArray(m) ||
                !/^models\/[a-z0-9._-]+$/.test(m[0]) ||
                !Array.isArray(m[7]) ||
                !m[7].includes("generateContent")
            )
                continue;
            const metadata = {
                description: m[4] || "",
                displayName: m[3] || m[0],
                inputTokenLimit: m[5],
                name: m[0],
                outputTokenLimit: m[6],
                supportedGenerationMethods: ["generateContent"],
            };
            catalog.set(m[0], metadata);
            const existing = models.find(x => x.name === m[0]);
            if (!existing) {
                models.push(metadata);
                this.routes.set(m[0].slice(7), "playground");
            } else if (this.channel(m[0]) === "playground") {
                for (const key of ["inputTokenLimit", "outputTokenLimit"])
                    if (Number.isFinite(metadata[key])) existing[key] = metadata[key];
            }
        }
        this.catalog = [...catalog.values()];
        this.save();
    }
    static canFallback(message) {
        if (message.event_type !== "error") return false;
        const status = Number(message.status);
        const detail = message.message || "";
        return (
            (status === 403 && /PERMISSION_DENIED|caller does not have permission/i.test(detail)) ||
            (status === 404 && /model|not found/i.test(detail)) ||
            (status === 429 && /limit:\s*0\b/.test(detail)) ||
            (status === 400 && ModelRouter.isBuildProxyRejection(detail))
        );
    }
    // The Build proxy (ProxyUnaryCall/ProxyStreamedCall) rejects generation with this bare message,
    // without field details, regardless of model or body; real API validation errors carry specifics.
    static isBuildProxyRejection(detail) {
        return /"message":\s*"Request contains an invalid argument\."/.test(detail) && !/"details"/.test(detail);
    }
    playgroundOffers(model) {
        const base = AntiTruncation.baseModel(model) || model;
        return this.catalog.length === 0 || this.catalog.some(m => m.name === `models/${base}`);
    }
    forward(spec, authIndex) {
        if (!this.handler.config.playgroundEnabled) return false;
        const match = spec.path?.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        if (!match) return false;
        const model = decodeURIComponent(match[1]);
        const entry = this.handler.connectionRegistry.messageQueues.get(spec.request_id);
        if (!entry || entry.queue.closed) return false;
        if (this.channel(model, authIndex) === "playground") {
            this._start(spec, authIndex, entry, model);
            return true;
        }
        // Only the current queue and attempt can invoke this callback (registry validates both).
        let committed = false;
        let switched = false;
        entry.onUpstreamMessage = message => {
            if (switched) return true;
            if (
                !committed &&
                ModelRouter.canFallback(message) &&
                (Number(message.status) !== 400 || this.playgroundOffers(model))
            ) {
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
            if (this.record(model, authIndex)?.failedUntil > Date.now())
                throw Object.assign(new Error("Playground channel is cooling down for this account and model"), {
                    coolingDown: true,
                    status: 503,
                });
            const context = this.handler.browserManager.contexts.get(authIndex)?.context;
            if (!context) throw Object.assign(new Error("Playground account context is unavailable"), { status: 503 });
            let session = this.sessions.get(context);
            if (!session) {
                session = new PlaygroundSession(context, raw => this.discover(raw));
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
            this.handler.logger.info(`[Routing] ${model} -> Playground (account #${authIndex}).`);
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
            this.remember(model, authIndex);
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
module.exports = ModelRouter;
