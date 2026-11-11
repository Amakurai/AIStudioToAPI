const crypto = require("crypto");
const AntiTruncation = require("../AntiTruncation");
const ModelChannel = require("../ModelChannel");
const PlaygroundCatalog = require("./Catalog");
const PlaygroundSession = require("./Session");
const PlaygroundSettings = require("./Settings");
const PlaygroundDiagnostics = require("./Diagnostics");
const { WireCodec, WireStream } = require("./WireCodec");
const { DEFAULT_TIMEOUTS } = require("../RequestHandler/constants");

const pick = (obj, camel) => obj?.[camel] ?? obj?.[camel.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];

const decodeURIComponentSafe = value => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

/** Playground generation channel: serves `pg-` models on each account's existing browser context. */
class PlaygroundTransport {
    constructor(handler) {
        this.handler = handler;
        this.sessions = new WeakMap();
        this.cooldowns = new Map();
        this.catalog = new PlaygroundCatalog(handler.config, handler.logger);
        this.settings = new PlaygroundSettings(handler.config, handler.logger);
    }
    get enabled() {
        return !!this.handler.config.playgroundEnabled;
    }
    /** Upstream models plus preset and anti-truncation aliases. */
    models() {
        if (!this.enabled) return [];
        const models = this.catalog.models();
        const aliases = models
            .filter(model => AntiTruncation.baseModel(`${model.name.replace(/^models\//, "")}-抗截断`))
            .map(model => ({
                ...model,
                description:
                    "Segmented tool text transport with bounded continuation and repair on Playground. Ordinary text output by default; text-only, no client tools.",
                displayName: `${model.displayName || model.name.replace(/^models\//, "")} 抗截断`,
                name: `${model.name}-抗截断`,
            }));
        const presets = models
            .filter(model => !PlaygroundCatalog.isSpeech(model.name))
            .map(model => ({
                ...model,
                description:
                    "Uses true streaming for text requests. Requests with client tools return after generation completes, preserving tool definitions and results.",
                displayName: `${model.displayName || model.name.replace(/^models\//, "")} 预设`,
                name: `${model.name}${ModelChannel.PRESET_SUFFIX}`,
            }));
        return [...models, ...aliases, ...presets];
    }
    cooldownKey(model, authIndex) {
        const name = this.handler.authSource?.accountNameMap?.get(authIndex);
        // Duplicate auth files of one email share a cooldown; other accounts are unaffected.
        const identity =
            typeof name === "string" && name.includes("@") ? name.trim().toLowerCase() : `index:${authIndex}`;
        return crypto.createHash("sha256").update(`${identity}\n${model}`).digest("hex");
    }
    cooldownUntil(model, authIndex) {
        return this.cooldowns.get(this.cooldownKey(model, authIndex))?.until || 0;
    }
    isCoolingDown(model, authIndex) {
        return this.cooldownUntil(model, authIndex) > Date.now();
    }
    coolingDownError(model, authIndex) {
        const cooldown = this.cooldowns.get(this.cooldownKey(model, authIndex));
        if (!(cooldown?.until > Date.now())) return null;
        const retryAfterMs = cooldown.until - Date.now();
        return Object.assign(
            new Error(
                `Playground ${model}: account #${authIndex} is cooling down after upstream HTTP ${cooldown.status}; retry in ${Math.ceil(retryAfterMs / 1000)}s.`
            ),
            {
                authIndex,
                coolingDown: true,
                retryAfterMs,
                status: cooldown.status,
                upstreamStatus: cooldown.status,
            }
        );
    }
    fail(model, authIndex, status) {
        if (![401, 403, 429, 502, 503, 504].includes(status)) return;
        const key = this.cooldownKey(model, authIndex);
        const previous = this.cooldowns.get(key);
        // A generic 403 is not proof of a missing membership. Treat it as a transient failure,
        // with the same bounded cooldown as rate limits, and never mark the auth as expired.
        const ms = this.handler.config.rateLimitCooldownMs || 60000;
        const until = Math.max(previous?.until || 0, Date.now() + ms);
        this.cooldowns.set(key, { status, until });
        this.handler.authSource?.markAccountCoolingDown?.(authIndex, ms, status, { channel: "playground", model });
    }

    /** Enforce only the caller's explicit forced function selection; AUTO remains model-directed. */
    _validateRequiredToolCalls(request, response) {
        for (const candidate of response.candidates || []) {
            if (
                !["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"].includes(
                    candidate.finishReason
                )
            )
                continue;
            throw Object.assign(new Error(`Playground tool generation failed (${candidate.finishReason}).`), {
                invalidToolResponse: true,
                retryable: false,
                status: 502,
            });
        }
        const config = pick(pick(request, "toolConfig"), "functionCallingConfig");
        if (config?.mode !== "ANY" || response.promptFeedback?.blockReason) return;
        const declarations = (request.tools || []).flatMap(tool => pick(tool, "functionDeclarations") || []);
        if (!declarations.length) return;
        const allowed = pick(config, "allowedFunctionNames");
        const names = new Set(
            declarations.map(declaration => declaration.name).filter(name => !allowed?.length || allowed.includes(name))
        );
        for (const candidate of response.candidates || []) {
            // Preserve blocked/truncated upstream results instead of relabelling them as normal completions.
            if (candidate.finishReason !== "STOP") continue;
            const calls = (candidate.content?.parts || []).flatMap(part =>
                part.functionCall ? [part.functionCall] : []
            );
            if (calls.length && calls.every(call => names.has(call.name))) continue;
            throw Object.assign(new Error("Playground did not return the function call required by tool_choice."), {
                invalidToolResponse: true,
                retryable: false,
                status: 502,
            });
        }
    }
    /** Starts a Playground generation for a request whose path names the upstream (unprefixed) model. */
    forward(spec, authIndex) {
        const entry = this.handler.connectionRegistry.messageQueues.get(spec.request_id);
        if (!entry || entry.queue.closed) return;
        const match = spec.path?.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        // Public routes reject these up front; reject here too instead of reaching Build or the page.
        // Anti-truncation aliases never get here: AntiTruncation.forward sends base-model rounds.
        const rejection = !this.enabled
            ? "The Playground channel is disabled (PLAYGROUND_ENABLED=false)."
            : !match
              ? "Playground models only support generateContent and streamGenerateContent."
              : AntiTruncation.baseModel(match[1])
                ? "Anti-truncation aliases must be sent through the anti-truncation transport."
                : PlaygroundCatalog.unsupportedReason(decodeURIComponentSafe(match[1]));
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
        let outputStarted = false;
        let failureRecorded = false;
        let diagnostics;
        let diagnosticsRecorded = false;
        const recordDiagnostics = () => {
            if (!diagnostics || diagnosticsRecorded) return;
            diagnosticsRecorded = true;
            const generation = diagnostics.snapshot();
            this.handler._updateTrackedRequest?.(spec.request_id, { generation });
            this.handler.logger.info(
                `[Playground] ${spec.request_id} account=#${authIndex} generation=${JSON.stringify(generation)}`
            );
        };
        const cooldownKey = this.cooldownKey(model, authIndex);
        let cooldownAtStart = this.cooldowns.get(cooldownKey);
        const recordFailure = error => {
            const queuedTimeout = timedOut && stage === "queued";
            if (
                failureRecorded ||
                error.coolingDown ||
                error.invalidToolResponse ||
                queuedTimeout ||
                (controller.signal.aborted && !timedOut)
            )
                return;
            failureRecorded = true;
            const status = timedOut ? 504 : Number(error.status) || 502;
            this.handler._getUsageStatsService?.()?.recordAttemptFailure?.(spec.request_id, authIndex, {
                message: error.message,
                status,
            });
            const currentCooldown = this.cooldowns.get(cooldownKey);
            if (
                currentCooldown !== cooldownAtStart &&
                currentCooldown?.until > Date.now() &&
                ((currentCooldown.status === 429 && status !== 429) ||
                    ([401, 403].includes(currentCooldown.status) && ![401, 403].includes(status)))
            )
                return;
            this.fail(model, authIndex, status);
        };
        const realStream = spec.streaming_mode === "real" && spec.path.endsWith(":streamGenerateContent");
        // Speech streams dozens of short PCM parts that clients cannot play one by one (each becomes
        // a separate data URI in OpenAI/Claude output); send it as one joined clip instead.
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
            const coolingDown = this.coolingDownError(model, authIndex);
            if (coolingDown) throw coolingDown;
            const context = this.handler.browserManager.contexts.get(authIndex)?.context;
            if (!context) throw Object.assign(new Error("Playground account context is unavailable"), { status: 503 });
            let session = this.sessions.get(context);
            if (!session) {
                session = new PlaygroundSession(context, raw => this.catalog.discover(raw));
                this.sessions.set(context, session);
            }
            const request = this.settings.apply(JSON.parse(spec.body), model, {
                antiTruncation: spec.anti_truncation_mode === "tool",
            });
            diagnostics = new PlaygroundDiagnostics(request);
            this.handler._updateTrackedRequest?.(spec.request_id, { generation: diagnostics.snapshot() });
            // A text/thought chunk can precede a function call. Hold the entire turn until the
            // generation completes, so clients receive complete calls rather than an early text reply.
            const hasClientTools = (request.tools || []).some(tool => pick(tool, "functionDeclarations")?.length);
            const progressive = realStream && !PlaygroundCatalog.isSpeech(model) && !hasClientTools;
            const includeThoughts = WireCodec.includesThoughts(request);
            const parser = new WireStream(raw => {
                const decoded = WireCodec.decode(raw, model);
                diagnostics.observe(decoded);
                const chunk = includeThoughts ? decoded : WireCodec.withoutThoughts(decoded);
                completed ||= !!chunk.candidates?.some(c => c.finishReason) || !!chunk.promptFeedback?.blockReason;
                if (!progressive) WireCodec.merge(merged, chunk);
                if (progressive && active()) {
                    outputStarted ||= !!chunk.candidates?.some(candidate =>
                        candidate.content?.parts?.some(
                            part =>
                                (typeof part.text === "string" && part.text.length > 0) ||
                                part.functionCall ||
                                part.inlineData ||
                                part.fileData ||
                                part.executableCode ||
                                part.codeExecutionResult
                        )
                    );
                    headers();
                    queue.enqueue({ data: `data: ${JSON.stringify(chunk)}\n\n`, event_type: "chunk" });
                }
            });
            this.handler.logger.info(`[Playground] ${model} (account #${authIndex}).`);
            await session.request(model, request, {
                beforeStart: () => {
                    const accountCooldown = this.handler._accountCooldownError?.(authIndex);
                    if (accountCooldown) throw accountCooldown;
                    const coolingDown = this.coolingDownError(model, authIndex);
                    if (coolingDown) throw coolingDown;
                    cooldownAtStart = this.cooldowns.get(cooldownKey);
                },
                onData: value => {
                    if (!active() || typeof value !== "string") return;
                    parser.feed(value);
                    if (started) arm(idleTimeoutMs);
                },
                onFailure: recordFailure,
                onStage: reportStage,
                signal: controller.signal,
                timeoutMs,
            });
            if (!active()) return;
            parser.finish();
            recordDiagnostics();
            if (!completed) {
                throw Object.assign(new Error("Playground response ended without a finish reason"), {
                    retryable: false,
                    status: 502,
                });
            }
            if (hasClientTools) this._validateRequiredToolCalls(request, merged);
            if (this.cooldowns.get(cooldownKey) === cooldownAtStart) this.cooldowns.delete(cooldownKey);
            if (!progressive) {
                headers();
                const body = JSON.stringify(WireCodec.joinAudio(merged));
                queue.enqueue({ data: realStream ? `data: ${body}\n\n` : body, event_type: "chunk" });
            }
            queue.enqueue({ type: "STREAM_END" });
        } catch (error) {
            recordDiagnostics();
            const upstreamStatus = Number(error.status) || 502;
            // Waiting behind this account's active Playground request says nothing about the
            // account's health and nothing was dispatched: retry elsewhere without a cooldown.
            const queuedTimeout = timedOut && stage === "queued";
            this.handler.logger.warn(
                `[Playground] ${spec.request_id} account=#${authIndex} accountName=${JSON.stringify(this.handler._getAccountNameForIndex?.(authIndex) || null)} model=${model} failedStage=${stage} status=${timedOut ? 504 : upstreamStatus} elapsedMs=${Date.now() - requestStartedAt}`
            );
            recordFailure(error);
            if (
                !queue.closed &&
                registry.messageQueues.get(spec.request_id) === entry &&
                entry.requestAttemptId === spec.request_attempt_id
            ) {
                queue.enqueue({
                    accountBusy: queuedTimeout,
                    coolingDown: error.coolingDown === true,
                    event_type: "error",
                    message: queuedTimeout
                        ? "Playground account is busy; request timed out while queued"
                        : timedOut
                          ? "Playground request timed out"
                          : error.message,
                    retryable: outputStarted ? false : queuedTimeout ? undefined : error.retryable,
                    status: queuedTimeout ? 503 : timedOut ? 504 : upstreamStatus,
                    upstreamStatus: timedOut ? 504 : error.upstreamStatus || upstreamStatus,
                });
            }
        } finally {
            clearTimeout(timer);
            queue.removeListener("close", abort);
            if (entry.playgroundAbort === controller) delete entry.playgroundAbort;
            if (outputStarted && this.handler.authSource?.isAccountCoolingDown?.(authIndex)) {
                // Delivered content cannot be replayed, but future requests still need a healthy account.
                if (authIndex === this.handler.currentAuthIndex && !this.handler.authSwitcher.isSystemBusy) {
                    this.handler.authSwitcher
                        .switchToNextAuth({ excludeIndices: [authIndex], resetCounters: false })
                        .catch(error => this.handler.logger.warn(error.message));
                } else {
                    this.handler.browserManager
                        .rebalanceContextPool?.()
                        .catch(error => this.handler.logger.warn(error.message));
                }
            }
        }
    }
}

module.exports = PlaygroundTransport;
