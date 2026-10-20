const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const BuildChatSession = require("./Session");
const { BuildChatCodec, BuildChatResponse } = require("./Codec");
const { WireStream } = require("../Playground/WireCodec");
const { DEFAULT_TIMEOUTS } = require("../RequestHandler/constants");

/**
 * Temporary applets that could not be deleted yet, per account. Persisted so the account's next
 * request deletes them even after a restart.
 */
class BuildChatLeftovers {
    constructor(file, logger) {
        this.file = file;
        this.logger = logger;
        this.leftovers = {};
        try {
            const saved = JSON.parse(fs.readFileSync(file, "utf8"));
            if (saved.version === 2 && saved.leftovers && typeof saved.leftovers === "object")
                this.leftovers = saved.leftovers;
        } catch (error) {
            if (error.code !== "ENOENT") logger.warn(`[BuildChat] Could not load ${file}: ${error.message}`);
        }
    }
    forAccount(identity) {
        return {
            add: id => this._write(identity, [...new Set([...(this.leftovers[identity] || []), id])]),
            list: () => [...(this.leftovers[identity] || [])],
            remove: id =>
                this._write(
                    identity,
                    (this.leftovers[identity] || []).filter(other => other !== id)
                ),
        };
    }
    _write(identity, ids) {
        if (ids.length) this.leftovers[identity] = ids;
        else delete this.leftovers[identity];
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                `${this.file}.tmp`,
                JSON.stringify({ leftovers: this.leftovers, version: 2 }, null, 2) + "\n"
            );
            fs.renameSync(`${this.file}.tmp`, this.file);
        } catch (error) {
            this.logger.warn(`[BuildChat] Could not save temporary applets: ${error.message}`);
        }
    }
}

/** Build editor chat channel: serves `bdc-` models on each account's existing browser context. */
class BuildChatTransport {
    static MAX_DENIAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
    /** Reads of one generation before giving up on a run that never settles. */
    static MAX_READS = 6;

    constructor(handler) {
        this.handler = handler;
        this.sessions = new WeakMap();
        this.cooldowns = new Map();
        this.leftovers = new BuildChatLeftovers(
            handler.config.buildChatAppletsPath || path.join(process.cwd(), "data", "buildchat-applets.json"),
            handler.logger
        );
    }
    get enabled() {
        return !!this.handler.config.buildChatEnabled;
    }
    models() {
        if (!this.enabled) return [];
        return (this.handler.config.buildChatModelList || []).map(model => ({ ...model }));
    }
    /** Duplicate auth files of one email share cooldowns and leftover applets; other accounts are unaffected. */
    accountIdentity(authIndex) {
        const name = this.handler.authSource?.accountNameMap?.get(authIndex);
        return typeof name === "string" && name.includes("@") ? name.trim().toLowerCase() : `index:${authIndex}`;
    }
    cooldownKey(model, authIndex) {
        return crypto
            .createHash("sha256")
            .update(`${this.accountIdentity(authIndex)}\n${model}`)
            .digest("hex");
    }
    cooldownUntil(model, authIndex) {
        return this.cooldowns.get(this.cooldownKey(model, authIndex))?.until || 0;
    }
    isCoolingDown(model, authIndex) {
        return this.cooldownUntil(model, authIndex) > Date.now();
    }
    fail(model, authIndex, status) {
        if (![401, 403, 429, 502, 503, 504].includes(status)) return;
        const key = this.cooldownKey(model, authIndex);
        const previous = this.cooldowns.get(key);
        // A denial keeps failing; double its cooldown on each consecutive one (5 min up to 6 h).
        const denials = status === 401 || status === 403 ? (previous?.denials || 0) + 1 : previous?.denials || 0;
        const ms =
            status === 401 || status === 403
                ? Math.min(BuildChatTransport.MAX_DENIAL_COOLDOWN_MS, 300000 * 2 ** (denials - 1))
                : 60000;
        this.cooldowns.set(key, { denials, until: Date.now() + ms });
    }
    /** Starts a Build Chat generation for a request whose path names the upstream (unprefixed) model. */
    forward(spec, authIndex) {
        const entry = this.handler.connectionRegistry.messageQueues.get(spec.request_id);
        if (!entry || entry.queue.closed) return;
        const match = spec.path?.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        let model = match?.[1];
        try {
            model = model && decodeURIComponent(model);
        } catch {
            // Keep the raw name; upstream reports an unknown model.
        }
        // Public routes reject these up front; reject here too instead of reaching Build or the page.
        const rejection = !this.enabled
            ? "The Build Chat channel is disabled (BUILD_CHAT_ENABLED=false)."
            : !match
              ? "Build Chat models only support generateContent and streamGenerateContent."
              : BuildChatTransport.unsupportedReason(model);
        if (rejection) {
            entry.queue.enqueue({ event_type: "error", message: rejection, retryable: false, status: 400 });
            return;
        }
        const controller = new AbortController();
        entry.buildChatAbort = controller;
        void this._run(spec, authIndex, entry, model, controller);
    }
    /** @returns {string|null} Why Build Chat cannot serve this upstream model, or null. */
    static unsupportedReason(model) {
        if (/-抗截断$/.test(String(model || "")))
            return "Build Chat has no anti-truncation aliases; use build- or pg- anti-truncation models.";
        return null;
    }
    cancel(requestId, attemptId) {
        const entry = this.handler.connectionRegistry.messageQueues.get(requestId);
        if (!entry?.buildChatAbort || (attemptId && entry.requestAttemptId !== attemptId)) return false;
        entry.buildChatAbort.abort();
        return true;
    }
    async _run(spec, authIndex, entry, model, controller) {
        const { queue } = entry;
        const requestStartedAt = Date.now();
        let stage = "start";
        const reportStage = value => {
            stage = value;
            this.handler.logger.info(
                `[BuildChat] ${spec.request_id} account=#${authIndex} stage=${stage} elapsedMs=${Date.now() - requestStartedAt}`
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
        const headers = () => {
            if (started || !active()) return;
            started = true;
            queue.enqueue({
                event_type: "response_headers",
                headers: {
                    "content-type": realStream ? "text/event-stream" : "application/json",
                    "x-aistudio-channel": "buildchat",
                },
                status: 200,
            });
        };
        try {
            if (this.cooldownUntil(model, authIndex) > Date.now())
                throw Object.assign(new Error("Build Chat channel is cooling down for this account and model"), {
                    coolingDown: true,
                    status: 503,
                });
            const context = this.handler.browserManager.contexts.get(authIndex)?.context;
            if (!context) throw Object.assign(new Error("Build Chat account context is unavailable"), { status: 503 });
            let session = this.sessions.get(context);
            if (!session) {
                session = new BuildChatSession(context);
                this.sessions.set(context, session);
            }
            const encoded = BuildChatCodec.encode(JSON.parse(spec.body));
            const response = new BuildChatResponse(model, { includeThoughts: encoded.includeThoughts });
            const emit = chunk => {
                if (!chunk || !realStream || !active()) return;
                headers();
                queue.enqueue({ data: `data: ${JSON.stringify(chunk)}\n\n`, event_type: "chunk" });
            };
            let head;
            let parser;
            let passes = 0;
            let stepsSeen = -1;
            const startPass = () => {
                head = "";
                parser = new WireStream(raw => emit(response.update(raw)));
            };
            startPass();
            // The first read waits for the run and returns its steps. A run is over when a further
            // read of the same generation adds no step, so finished runs cost one quick extra read.
            const onPassEnd = () => {
                passes++;
                let empty = false;
                try {
                    parser.finish();
                } catch {
                    const rpc = BuildChatCodec.rpcError(head);
                    if (rpc)
                        throw Object.assign(new Error(`Build Chat error: ${rpc.message}`), {
                            retryable: false,
                            status: rpc.status,
                        });
                    empty = true;
                }
                const settled = !empty && response.complete && response.steps.size === stepsSeen;
                stepsSeen = response.steps.size;
                if (settled) return false;
                if (passes >= BuildChatTransport.MAX_READS) {
                    this.handler.logger.warn(`[BuildChat] ${spec.request_id} unfinished run: ${response.summary()}`);
                    this.handler.logger.debug(`[BuildChat] ${spec.request_id} last read: ${head.slice(0, 2000)}`);
                    if (response.complete) return false;
                    throw Object.assign(new Error("Build Chat run ended without a finished answer"), {
                        retryable: false,
                        status: 502,
                    });
                }
                startPass();
                return true;
            };
            this.handler.logger.info(`[BuildChat] ${model} (account #${authIndex}).`);
            await session.request(model, encoded, {
                leftovers: this.leftovers.forAccount(this.accountIdentity(authIndex)),
                onData: value => {
                    if (!active() || typeof value !== "string") return;
                    if (head.length < 2000) head += value.slice(0, 2000 - head.length);
                    parser.feed(value);
                    if (started) arm(idleTimeoutMs);
                },
                onPassEnd: () => active() && onPassEnd(),
                onStage: reportStage,
                signal: controller.signal,
                timeoutMs,
            });
            if (!active()) return;
            this.handler.logger.debug(`[BuildChat] ${spec.request_id} reads=${passes} ${response.summary()}`);
            if (realStream) emit(response.finish());
            this.cooldowns.delete(this.cooldownKey(model, authIndex));
            if (!realStream) {
                headers();
                queue.enqueue({ data: JSON.stringify(response.final()), event_type: "chunk" });
            }
            queue.enqueue({ type: "STREAM_END" });
        } catch (error) {
            // A page automation failure while signing (no upstream status) says nothing about the
            // account's quota: retry elsewhere without a cooldown.
            const pageFailure = !error.status && !timedOut && ["prepare_page", "submit_prompt"].includes(stage);
            const upstreamStatus = Number(error.status) || (pageFailure ? 503 : 502);
            // Waiting behind this account's active Build Chat request says nothing about the account.
            const queuedTimeout = timedOut && stage === "queued";
            this.handler.logger.warn(
                `[BuildChat] ${spec.request_id} account=#${authIndex} failedStage=${stage} status=${timedOut ? 504 : upstreamStatus} elapsedMs=${Date.now() - requestStartedAt}`
            );
            const unavailableAccount =
                !started &&
                (upstreamStatus === 401 ||
                    (upstreamStatus === 403 && /permission|PERMISSION_DENIED/i.test(error.message)));
            if (!error.coolingDown && !pageFailure && !queuedTimeout && (!controller.signal.aborted || timedOut))
                this.fail(model, authIndex, timedOut ? 504 : upstreamStatus);
            if (
                !queue.closed &&
                registry.messageQueues.get(spec.request_id) === entry &&
                entry.requestAttemptId === spec.request_attempt_id
            ) {
                queue.enqueue({
                    event_type: "error",
                    message: queuedTimeout
                        ? "Build Chat account is busy; request timed out while queued"
                        : timedOut
                          ? "Build Chat request timed out"
                          : error.message,
                    retryable: started ? false : queuedTimeout ? undefined : error.retryable,
                    status: queuedTimeout ? 503 : timedOut ? 504 : unavailableAccount ? 503 : upstreamStatus,
                });
            }
        } finally {
            clearTimeout(timer);
            queue.removeListener("close", abort);
            if (entry.buildChatAbort === controller) delete entry.buildChatAbort;
        }
    }
}

module.exports = BuildChatTransport;
