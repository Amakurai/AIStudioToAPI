const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ModelChannel = require("../src/core/ModelChannel");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const reply = { candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }] };

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.headersSent = false;
        this.statusCode = 200;
        this.writableEnded = false;
        this.socket = { destroyed: false, writable: true };
        this.output = "";
    }
    setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
    }
    set(name, value) {
        if (typeof name === "object") for (const [key, entry] of Object.entries(name)) this.setHeader(key, entry);
        else this.setHeader(name, value);
        return this;
    }
    get(name) {
        return this.headers[name.toLowerCase()];
    }
    type(value) {
        return this.set("Content-Type", value);
    }
    status(value) {
        this.statusCode = value;
        return this;
    }
    writeHead(status, headers) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers || {})) this.set(name, value);
        this.headersSent = true;
    }
    write(value) {
        this.headersSent = true;
        this.output += String(value);
        return true;
    }
    end(value) {
        if (value !== undefined) this.write(value);
        this.writableEnded = true;
    }
    send(value) {
        this.end(value);
        return this;
    }
    json(value) {
        return this.send(JSON.stringify(value));
    }
}

function answer(queue) {
    queue.enqueue({ event_type: "response_headers", status: 200 });
    queue.enqueue({ data: JSON.stringify(reply), event_type: "chunk" });
    queue.enqueue({ type: "STREAM_END" });
}

function harness(t, extraConfig = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-channel-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const registry = new ConnectionRegistry(logger);
    const config = {
        fakeStreamTimeoutMs: 1000,
        immediateSwitchStatusCodes: [429],
        maxRetries: 1,
        modelList: [{ name: "models/gemini-3.8-flash" }, { name: "models/gemini-4-argon" }],
        playgroundCatalogPath: path.join(dir, "playground-models.json"),
        playgroundEnabled: true,
        playgroundModelList: [{ name: "models/gemini-4-argon" }],
        playgroundSettingsPath: path.join(dir, "settings.json"),
        retryDelay: 1,
        streamingMode: "fake",
        switchOnUses: 0,
        ...extraConfig,
    };
    const handler = new RequestHandler({ config }, registry, logger, { currentAuthIndex: 0 }, config, {});
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._selectDispatchAuthIndex = () => 0;
    const build = [];
    const playground = [];
    registry.connectionsByAuth.set(0, {
        send(data) {
            const spec = JSON.parse(data);
            if (spec.event_type === "cancel_request") return;
            build.push(spec);
            answer(registry.messageQueues.get(spec.request_id).queue);
        },
    });
    handler.playground.forward = spec => {
        playground.push({ ...spec });
        answer(registry.messageQueues.get(spec.request_id).queue);
    };
    return { build, handler, playground };
}

function apiRequest(api, model) {
    const common = { headers: {}, method: "POST", query: {} };
    if (api === "gemini")
        return {
            ...common,
            body: { contents: [{ parts: [{ text: "Hi" }], role: "user" }] },
            path: `/v1beta/models/${model}:generateContent`,
        };
    if (api === "responses") return { ...common, body: { input: "Hi", model }, path: "/v1/responses" };
    return {
        ...common,
        body: { max_tokens: 100, messages: [{ content: "Hi", role: "user" }], model },
        path: api === "claude" ? "/v1/messages" : "/v1/chat/completions",
    };
}

const processors = {
    claude: "processClaudeRequest",
    gemini: "processRequest",
    openai: "processOpenAIRequest",
    responses: "processOpenAIResponseRequest",
};

test("model prefixes name the channel and unprefixed names stay on Build", () => {
    assert.deepEqual(ModelChannel.parse("build-gemini-4-argon"), {
        channel: "build",
        model: "gemini-4-argon",
        prefixed: true,
    });
    assert.deepEqual(ModelChannel.parse("models/pg-gemini-4-argon"), {
        channel: "playground",
        model: "gemini-4-argon",
        prefixed: true,
    });
    assert.deepEqual(ModelChannel.parse("gemini-4-argon"), {
        channel: "build",
        model: "gemini-4-argon",
        prefixed: false,
    });
    assert.equal(ModelChannel.parse("pg-").channel, "build");
    assert.equal(ModelChannel.publicName("playground", "models/gemini-4-argon"), "pg-gemini-4-argon");
});

test("every public API sends build-* to Build and pg-* to Playground with the prefix removed", async t => {
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            for (const [model, channel] of [
                ["build-gemini-4-argon", "build"],
                ["gemini-4-argon", "build"],
                ["pg-gemini-4-argon", "playground"],
            ]) {
                const h = harness(t);
                const res = new FakeResponse();
                await h.handler[method](apiRequest(api, model), res);
                assert.equal(res.statusCode, 200, `${model}: ${res.output}`);
                const used = channel === "build" ? h.build : h.playground;
                const other = channel === "build" ? h.playground : h.build;
                assert.equal(used.length, 1, model);
                assert.equal(other.length, 0, model);
                assert.equal(used[0].path, "/v1beta/models/gemini-4-argon:generateContent");
                assert.equal(used[0].channel, channel);
            }
        });
    }
});

test("a Build error is returned as is and never retried on Playground", async t => {
    const h = harness(t);
    const registry = h.handler.connectionRegistry;
    registry.connectionsByAuth.set(0, {
        send(data) {
            const spec = JSON.parse(data);
            if (spec.event_type === "cancel_request") return;
            h.build.push(spec);
            registry.messageQueues.get(spec.request_id).queue.enqueue({
                event_type: "error",
                message: "PERMISSION_DENIED",
                status: 403,
            });
        },
    });
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-4-argon"), res);
    assert.equal(res.statusCode, 403);
    assert.equal(h.playground.length, 0);
});

test("anti-truncation aliases activate on both channels and keep their channel", () => {
    const handler = Object.create(RequestHandler.prototype);
    const spec = {
        is_generative: true,
        path: `/v1beta/models/build-gemini-4-argon${encodeURIComponent("-抗截断")}:streamGenerateContent`,
        request_id: "r",
        streaming_mode: "real",
    };
    handler._initializeProxyRequestAttempt(spec);
    assert.equal(spec.path, "/v1beta/models/gemini-4-argon:streamGenerateContent");
    assert.equal(spec.channel, "build");
    assert.equal(spec.anti_truncation, true);
    const pg = {
        is_generative: true,
        path: "/v1beta/models/pg-gemini-4-argon-抗截断:generateContent",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(pg);
    assert.equal(pg.path, "/v1beta/models/gemini-4-argon:generateContent");
    assert.equal(pg.channel, "playground");
    assert.equal(pg.anti_truncation, true);
    assert.equal(pg.streaming_mode, "fake");
});

test("the Playground transport itself rejects alias paths and a disabled channel", async t => {
    const PlaygroundTransport = require("../src/core/Playground/Transport");
    for (const [enabled, model, pattern] of [
        // Aliases are sent as base-model rounds; a raw alias path must never reach the page.
        [true, "gemini-4-argon-抗截断", /anti-truncation transport/],
        [false, "gemini-4-argon", /disabled/],
    ]) {
        const registry = new ConnectionRegistry(logger);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-channel-reject-"));
        t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
        const transport = new PlaygroundTransport({
            browserManager: { contexts: new Map() },
            config: { playgroundCatalogPath: path.join(dir, "c.json"), playgroundEnabled: enabled },
            connectionRegistry: registry,
            logger,
            timeouts: { FAKE_STREAM: 1000 },
        });
        const queue = registry.createMessageQueue("req", 0, "a1");
        transport.forward(
            {
                body: "{}",
                path: `/v1beta/models/${model}:generateContent`,
                request_attempt_id: "a1",
                request_id: "req",
            },
            0
        );
        const error = await queue.dequeue();
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.match(error.message, pattern);
    }
});

test("prefixes are removed from model fields in embedding and token-count bodies", () => {
    const handler = Object.create(RequestHandler.prototype);
    const openai = {
        body: JSON.stringify({ input: "x", model: "build-gemini-embedding-001" }),
        path: "/v1beta/openai/embeddings",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(openai);
    assert.equal(JSON.parse(openai.body).model, "gemini-embedding-001");
    const batch = {
        body: JSON.stringify({ requests: [{ content: {}, model: "models/build-gemini-embedding-001" }] }),
        path: "/v1beta/models/build-gemini-embedding-001:batchEmbedContents",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(batch);
    assert.equal(batch.path, "/v1beta/models/gemini-embedding-001:batchEmbedContents");
    assert.equal(JSON.parse(batch.body).requests[0].model, "models/gemini-embedding-001");
    const count = {
        body: JSON.stringify({ generateContentRequest: { contents: [], model: "models/build-gemini-3.8-flash" } }),
        path: "/v1beta/models/build-gemini-3.8-flash:countTokens",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(count);
    assert.equal(JSON.parse(count.body).generateContentRequest.model, "models/gemini-3.8-flash");
});

test("pg-* requests other than content generation are rejected up front", t => {
    const h = harness(t);
    const reason = (method, reqPath, body = {}) =>
        h.handler._unsupportedPlaygroundRequest({ body, method, path: reqPath });
    assert.equal(reason("POST", "/v1/chat/completions", { model: "pg-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1/messages", { model: "pg-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1/responses", { model: "pg-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1beta/models/pg-gemini-4-argon:streamGenerateContent"), null);
    assert.equal(reason("POST", "/v1/chat/completions", { model: "build-gemini-4-argon-抗截断" }), null);
    assert.equal(reason("POST", "/v1/chat/completions", { model: "pg-gemini-4-argon-抗截断" }), null);
    assert.equal(
        reason("POST", `/v1beta/models/pg-gemini-4-argon${encodeURIComponent("-抗截断")}:generateContent`),
        null
    );
    assert.match(
        reason("POST", `/v1beta/models/pg-gemini-4-argon${encodeURIComponent("-抗截断")}:countTokens`),
        /only support content generation/
    );
    assert.match(reason("POST", "/v1beta/models/pg-gemini-4-argon:countTokens"), /only support content generation/);
    assert.match(reason("POST", "/v1/messages/count_tokens", { model: "pg-gemini-4-argon" }), /only support/);
    assert.match(reason("POST", "/v1/embeddings", { model: "pg-gemini-4-argon" }), /only support/);
    assert.match(reason("GET", "/v1beta/models/pg-gemini-4-argon"), /only support/);
    h.handler.config.playgroundEnabled = false;
    assert.match(reason("POST", "/v1/chat/completions", { model: "pg-gemini-4-argon" }), /disabled/);
});

test("only Playground models are published while configured Build models stay hidden", t => {
    const h = harness(t);
    const names = channel => h.handler.channelModels()[channel].map(model => model.name);
    assert.deepEqual(names("build"), []);
    assert.deepEqual(names("playground"), [
        "models/pg-gemini-4-argon",
        "models/pg-gemini-4-argon-抗截断",
        "models/pg-gemini-4-argon-预设",
    ]);
    h.handler.playground.catalog.discover([[["models/gemini-new", null, "", "New", "", 1, 1, ["generateContent"]]]]);
    assert.deepEqual(names("playground"), [
        "models/pg-gemini-4-argon",
        "models/pg-gemini-new",
        "models/pg-gemini-4-argon-抗截断",
        "models/pg-gemini-4-argon-预设",
        "models/pg-gemini-new-预设",
    ]);
    assert.deepEqual(names("build"), []);
    assert.equal(h.handler.config.modelList.length, 2);
    h.handler.config.playgroundEnabled = false;
    assert.deepEqual(names("playground"), []);
});

function poolHarness(t) {
    const h = harness(t, { maxRetries: 2, switchOnUses: 1 });
    const handler = h.handler;
    const cooled = [];
    const switches = [];
    const AuthSource = require("../src/auth/AuthSource");
    class MemorySource extends AuthSource {
        _discoverAvailableIndices() {
            this.initialIndices = [0, 1];
        }
        _getAuthContent(index) {
            return JSON.stringify({ accountName: `a${index}@example.com` });
        }
    }
    handler.authSource = new MemorySource(logger);
    const mark = handler.authSource.markAccountCoolingDown.bind(handler.authSource);
    handler.authSource.markAccountCoolingDown = (...args) => {
        cooled.push(args[0]);
        return mark(...args);
    };
    handler.authSwitcher.authSource = handler.authSource;
    handler.authSwitcher.switchToNextAuth = async () => {
        switches.push("switch");
        return { success: false };
    };
    handler.browserManager.rebalanceContextPool = async () => switches.push("rebalance");
    handler._getReadyAuthIndices = () => [0, 1];
    handler._selectDispatchAuthIndex = RequestHandler.prototype._selectDispatchAuthIndex;
    for (const authIndex of [0, 1])
        handler.connectionRegistry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return h.build.push(spec);
                h.build.push(spec);
                answer(handler.connectionRegistry.messageQueues.get(spec.request_id).queue);
            },
        });
    return { ...h, cooled, switches };
}

function coldPoolHarness(t, available = [0, 1, 2]) {
    const h = poolHarness(t);
    const ready = new Set([0]);
    const initialized = [];
    const source = h.handler.authSource;
    source.availableIndices = available;
    source.getRotationIndices = () => available;
    source.getAvailableRotationIndices = () => available;
    source.getCanonicalIndex = index => index;
    h.handler._getReadyAuthIndices = () => [...ready];
    h.handler.config.maxRetries = 1;
    h.handler.config.switchOnUses = 0;
    h.handler.browserManager.preCleanupForSwitch = async () => {};
    h.handler.browserManager.switchAccount = async index => {
        initialized.push(index);
        ready.add(index);
        h.handler.browserManager.currentAuthIndex = index;
    };
    const AuthSwitcher = require("../src/auth/AuthSwitcher");
    h.handler.authSwitcher.switchToNextAuth = AuthSwitcher.prototype.switchToNextAuth;
    return { ...h, initialized, ready };
}

test("Playground starts cold spare accounts after 429 or permission denial across public APIs", async t => {
    for (const api of Object.keys(processors)) {
        for (const mode of ["nonstream", "fake", "real"]) {
            for (const status of [429, 403]) {
                await t.test(`${api} ${mode} ${status}`, async t => {
                    const h = coldPoolHarness(t);
                    h.handler.config.streamingMode = mode === "nonstream" ? "fake" : mode;
                    h.handler.config.immediateSwitchStatusCodes = [429, 503];
                    h.handler.authSwitcher.usageCount = 9;
                    h.handler.authSwitcher.failureCount = 2;
                    const tried = [];
                    h.handler.playground.forward = (spec, index) => {
                        tried.push(index);
                        const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                        if (index < 2) {
                            h.handler.playground.fail("gemini-4-argon", index, status);
                            queue.enqueue({
                                event_type: "error",
                                message: "upstream rejected account",
                                status,
                                upstreamStatus: status,
                            });
                        } else {
                            queue.enqueue({ event_type: "response_headers", status: 200 });
                            queue.enqueue({
                                data: mode === "real" ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply),
                                event_type: "chunk",
                            });
                            queue.enqueue({ type: "STREAM_END" });
                        }
                    };
                    const req = apiRequest(api, "pg-gemini-4-argon");
                    if (mode !== "nonstream") {
                        req.body.stream = true;
                        if (api === "gemini") req.path = req.path.replace(":generateContent", ":streamGenerateContent");
                    }
                    const res = new FakeResponse();
                    await h.handler.forRequest(req)[processors[api]](req, res);
                    assert.equal(res.statusCode, 200, res.output);
                    assert.match(res.output, /ok/);
                    assert.deepEqual(tried, [0, 1, 2]);
                    assert.deepEqual(h.initialized, [1, 2]);
                    assert.deepEqual(h.cooled, [0, 1], "cooling accounts are excluded from every channel");
                    assert.equal(h.handler.authSwitcher.usageCount, 9);
                    assert.equal(h.handler.authSwitcher.failureCount, 2);
                });
            }
        }
    }
});

test("a fresh Playground request starts a spare when resident accounts are cooling", async t => {
    const h = coldPoolHarness(t);
    h.handler.playground.fail("gemini-4-argon", 0, 429);
    const tried = [];
    h.handler.playground.forward = (spec, index) => {
        tried.push(index);
        answer(h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue);
    };
    const req = apiRequest("openai", "pg-gemini-4-argon");
    const res = new FakeResponse();
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.deepEqual(tried, [1]);
    assert.deepEqual(h.initialized, [1]);
});

test("Playground skips denied cold spares and tries every eligible account only once", async t => {
    const h = coldPoolHarness(t);
    h.handler.playground.fail("gemini-4-argon", 1, 403);
    const tried = [];
    h.handler.playground.forward = (spec, index) => {
        tried.push(index);
        h.handler.playground.fail("gemini-4-argon", index, 429);
        h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue.enqueue({
            event_type: "error",
            message: "quota exhausted",
            status: 429,
        });
    };
    const req = apiRequest("openai", "pg-gemini-4-argon");
    const res = new FakeResponse();
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 429, res.output);
    assert.deepEqual(tried, [0, 2]);
    assert.deepEqual(h.initialized, [2]);
});

test("a Playground retry cannot take over a queue replaced during cold startup", async t => {
    const h = coldPoolHarness(t);
    const scope = h.handler.forRequest(apiRequest("openai", "pg-gemini-4-argon"));
    const original = scope.connectionRegistry.createMessageQueue("cold-cancel", 0, "old");
    h.handler.browserManager.switchAccount = async () => {
        h.ready.add(1);
        scope.connectionRegistry.createMessageQueue("cold-cancel", 2, "replacement");
    };
    const tracker = scope._createImmediateSwitchTracker(0);
    const prepared = await scope._prepareImmediateStatusRetry({ status: 429 }, "cold-cancel", tracker, 0);
    assert.equal(prepared, false);
    assert.equal(original.closed, true);
    assert.equal(h.handler.connectionRegistry.getAuthIndexForRequest("cold-cancel"), 2);
    assert.equal(tracker.nextAuthIndex, null);
    h.handler.connectionRegistry.removeMessageQueue("cold-cancel");
});

test("concurrent Playground retries share a cold startup and reserve the resulting account", async t => {
    const h = coldPoolHarness(t, [0, 1]);
    h.handler.playground.fail("gemini-4-argon", 0, 429);
    let release;
    let started;
    const startup = new Promise(resolve => {
        release = resolve;
    });
    const starting = new Promise(resolve => {
        started = resolve;
    });
    const switchAccount = h.handler.browserManager.switchAccount;
    h.handler.browserManager.switchAccount = async index => {
        started();
        await startup;
        await switchAccount(index);
    };
    h.handler._waitForSystemReady = async () => {
        await startup;
        return true;
    };
    const scope = h.handler.forRequest(apiRequest("openai", "pg-gemini-4-argon"));
    for (const id of ["cold-a", "cold-b"]) scope.connectionRegistry.createMessageQueue(id, 0);
    const first = scope._prepareImmediateStatusRetry(
        { status: 429 },
        "cold-a",
        scope._createImmediateSwitchTracker(0),
        0
    );
    await starting;
    const second = scope._prepareImmediateStatusRetry(
        { status: 429 },
        "cold-b",
        scope._createImmediateSwitchTracker(0),
        0
    );
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(h.initialized, [1]);
    for (const id of ["cold-a", "cold-b"]) {
        assert.equal(h.handler.connectionRegistry.getAuthIndexForRequest(id), 1);
        h.handler.connectionRegistry.removeMessageQueue(id);
    }
});

test("Playground cooldown errors identify the account, model and original denial", t => {
    const h = poolHarness(t);
    h.handler.playground.fail("gemini-4-argon", 0, 403);
    const error = h.handler.playground.coolingDownError("gemini-4-argon", 0);
    assert.equal(error.authIndex, 0);
    assert.equal(error.status, 403);
    assert.equal(error.upstreamStatus, 403);
    assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 60000);
    assert.match(error.message, /gemini-4-argon.*account #0.*403.*retry in/);
});

test("Build zero-quota 429 can reach a cold spare without cooling its other models", async t => {
    const h = coldPoolHarness(t, [0, 1]);
    for (const index of [0, 1]) {
        h.handler.connectionRegistry.connectionsByAuth.set(index, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return;
                const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                if (index === 1) return answer(queue);
                queue.enqueue({ event_type: "error", message: "Quota exceeded, limit: 0", status: 429 });
            },
        });
    }
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-4-argon"), res);
    assert.equal(res.statusCode, 200, res.output);
    assert.deepEqual(h.initialized, [1]);
    assert.deepEqual(h.cooled, []);
});

test("upstream failures persist on the correct attempted account when retry succeeds", async t => {
    const UsageStatsService = require("../src/core/UsageStatsService");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-attempt-failure-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const stats = new UsageStatsService({}, logger, dir);
    stats.startRequest("req", { model: "pg-gemini-4-argon" });
    stats.recordAttempt("req", 0, "denied@example.com");
    stats.recordAttemptFailure("req", 0, { message: "No permission", status: 403 });
    stats.recordAttemptFailure("req", 0, { message: "Service unavailable", status: 503 });
    stats.recordAttempt("req", 1, "healthy@example.com");
    stats.recordAttemptFailure("req", 0, { message: "late error", status: 429 });
    const record = stats.finishRequest("req", { outcome: "success", statusCode: 200 });
    await stats.appendPromise;
    assert.equal(record.finalAuthIndex, 1);
    assert.deepEqual(record.attempts, [
        { accountKey: "0:denied@example.com", errorMessage: "No permission", upstreamStatus: 403 },
        { accountKey: "1:healthy@example.com" },
    ]);
    assert.deepEqual(new UsageStatsService({}, logger, dir).records[0].attempts, record.attempts);
});

test("all public Playground APIs preserve 403 when every account temporarily fails", async t => {
    for (const api of Object.keys(processors)) {
        for (const mode of ["fake", "real"]) {
            await t.test(`${api} ${mode}`, async t => {
                const h = poolHarness(t);
                h.handler.config.streamingMode = mode;
                const tried = [];
                h.handler.playground.forward = (spec, index) => {
                    tried.push(index);
                    h.handler.playground.fail("gemini-4-argon", index, 403);
                    h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue.enqueue({
                        event_type: "error",
                        message: "Playground HTTP 403: The caller does not have permission",
                        status: 403,
                    });
                };
                const req = apiRequest(api, "pg-gemini-4-argon");
                if (mode === "real") {
                    req.body.stream = true;
                    if (api === "gemini") req.path = req.path.replace(":generateContent", ":streamGenerateContent");
                }
                const res = new FakeResponse();
                await h.handler.forRequest(req)[processors[api]](req, res);
                assert.equal(res.statusCode, 403, res.output);
                assert.deepEqual(tried, [0, 1]);
                assert.deepEqual(h.handler.authSource.expiredIndices, []);
                assert.ok(h.handler.authSource.getAccountCooldown(0).remainingMs <= 60000);
            });
        }
    }
});

test("a Playground 429 shares account cooldown while preserving Build counters", async t => {
    const h = poolHarness(t);
    const accounts = [];
    h.handler.playground.forward = (spec, authIndex) => {
        accounts.push(authIndex);
        const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
        if (accounts.length === 1) queue.enqueue({ event_type: "error", message: "Resource exhausted", status: 429 });
        else answer(queue);
    };
    const req = apiRequest("openai", "pg-gemini-4-argon");
    const res = new FakeResponse();
    h.handler.authSwitcher.failureCount = 2;
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[0], accounts[1]);
    assert.deepEqual(h.cooled, [0]);
    assert.ok(h.switches.includes("rebalance"));
    assert.equal(h.handler.authSwitcher.usageCount, 0);
    assert.equal(h.handler.authSwitcher.failureCount, 2);
    assert.equal(h.handler.needsSwitchingAfterRequest, false);
    assert.equal(h.build.length, 0, "no instruction reaches a Build page");
});

test("a Playground model access denial retries an eligible account and skips the denied one", async t => {
    const h = poolHarness(t);
    h.handler.config.immediateSwitchStatusCodes = [429, 503];
    h.handler.config.streamingMode = "real";
    const accounts = [];
    h.handler.playground.forward = (spec, authIndex) => {
        accounts.push(authIndex);
        const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
        if (authIndex === 0) {
            h.handler.playground.fail("gemini-4-argon", authIndex, 403);
            queue.enqueue({ event_type: "error", message: "Playground upstream 403", status: 403 });
        } else {
            queue.enqueue({ event_type: "response_headers", status: 200 });
            queue.enqueue({ data: `data: ${JSON.stringify(reply)}\n\n`, event_type: "chunk" });
            queue.enqueue({ type: "STREAM_END" });
        }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        const req = apiRequest("openai", "pg-gemini-4-argon");
        req.body.stream = true;
        const res = new FakeResponse();
        await h.handler.forRequest(req).processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 200, res.output);
        assert.match(res.output, /ok/);
    }
    assert.deepEqual(accounts, [0, 1, 1]);
    assert.deepEqual(h.cooled, [0]);
    assert.ok(h.handler.authSource.isAccountCoolingDown(0));
});

test("a Playground 429 does not get masked by another account's existing cooldown", async t => {
    const h = poolHarness(t);
    const accounts = [];
    h.handler.playground.fail("gemini-4-argon", 1, 403);
    h.handler.playground.forward = (spec, authIndex) => {
        accounts.push(authIndex);
        h.handler.playground.fail("gemini-4-argon", authIndex, 429);
        h.handler.connectionRegistry.messageQueues
            .get(spec.request_id)
            .queue.enqueue({ event_type: "error", message: "Resource exhausted", status: 429 });
    };
    const req = apiRequest("openai", "pg-gemini-4-argon");
    req.body.stream = true;
    const res = new FakeResponse();
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 429, res.output);
    assert.deepEqual(accounts, [0]);
    assert.ok(h.handler.playground.isCoolingDown("gemini-4-argon", 0));
    assert.deepEqual(h.cooled, [1, 0]);
    assert.ok(h.switches.includes("rebalance"));
});

test("exhausted Playground accounts cool globally without incrementing Build failure counters", async t => {
    const h = poolHarness(t);
    h.handler.config.immediateSwitchStatusCodes = [429, 503];
    h.handler.playground.forward = spec =>
        h.handler.connectionRegistry.messageQueues
            .get(spec.request_id)
            .queue.enqueue({ event_type: "error", message: "busy", status: 503 });
    const req = apiRequest("claude", "pg-gemini-4-argon");
    const res = new FakeResponse();
    await h.handler.forRequest(req).processClaudeRequest(req, res);
    assert.equal(res.statusCode, 503);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.switches.includes("rebalance"));
    assert.deepEqual(h.cooled, [0, 1]);
    assert.equal(h.handler.authSwitcher.failureCount, 0);
});

// One full tool reply from the Playground upstream.
const segment = text => ({
    candidates: [
        {
            content: { parts: [{ functionCall: { args: { content: text }, name: "output_content" } }], role: "model" },
            finishReason: "STOP",
        },
    ],
    usageMetadata: { candidatesTokenCount: 5, promptTokenCount: 10, totalTokenCount: 15 },
});

function sendSegment(queue, reply) {
    queue.enqueue({ event_type: "response_headers", status: 200 });
    queue.enqueue({ data: JSON.stringify(reply), event_type: "chunk" });
    queue.enqueue({ type: "STREAM_END" });
}

const pgAlias = api =>
    api === "gemini" ? `pg-gemini-4-argon${encodeURIComponent("-抗截断")}` : "pg-gemini-4-argon-抗截断";

test("pg anti-truncation aliases run one tool generation on Playground across all public APIs", async t => {
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            const h = poolHarness(t);
            const registry = h.handler.connectionRegistry;
            const rounds = [];
            h.handler.playground.forward = spec => {
                rounds.push({ ...spec, queueChannel: registry.messageQueues.get(spec.request_id).channel });
                sendSegment(registry.messageQueues.get(spec.request_id).queue, segment("第一段，第二段。"));
            };
            const req = apiRequest(api, pgAlias(api));
            const res = new FakeResponse();
            await h.handler.forRequest(req)[method](req, res);
            assert.equal(res.statusCode, 200, res.output);
            assert.ok(res.output.includes("第一段，") && res.output.includes("第二段。"), res.output);
            assert.ok(!res.output.includes("output_content"), "internal tools stay hidden");
            assert.equal(rounds.length, 1);
            for (const round of rounds) {
                assert.equal(round.path, "/v1beta/models/gemini-4-argon:generateContent");
                assert.equal(round.channel, "playground");
                assert.equal(round.queueChannel, "playground");
                assert.equal(round.anti_truncation, false);
                assert.equal(JSON.parse(round.body).tools[0].functionDeclarations[0].name, "output_content");
            }
            assert.equal(h.build.length, 0, "no round reaches a Build page");
            assert.equal(h.handler.authSwitcher.usageCount, 0);
            assert.equal(registry.messageQueues.size, 0);
        });
    }
});

test("a Playground tool request retries a 429 before output on another account", async t => {
    const h = poolHarness(t);
    const registry = h.handler.connectionRegistry;
    const accounts = [];
    h.handler.playground.forward = (spec, authIndex) => {
        accounts.push(authIndex);
        const queue = registry.messageQueues.get(spec.request_id).queue;
        if (accounts.length === 1) queue.enqueue({ event_type: "error", message: "exhausted", status: 429 });
        else sendSegment(queue, segment("前文，后文。"));
    };
    const req = apiRequest("openai", "pg-gemini-4-argon-抗截断");
    const res = new FakeResponse();
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(JSON.parse(res.output).choices[0].message.content, "前文，后文。");
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[0], accounts[1]);
    assert.deepEqual(h.cooled, [0]);
    assert.ok(h.switches.includes("rebalance"));
    assert.equal(h.handler.authSwitcher.usageCount, 0);
    assert.equal(h.build.length, 0);
});

test("Build requests still count usage and Build is the default handler", async t => {
    const h = poolHarness(t);
    const req = apiRequest("openai", "build-gemini-4-argon");
    assert.equal(h.handler.forRequest(req), h.handler);
    await h.handler.forRequest(req).processOpenAIRequest(req, new FakeResponse());
    assert.equal(h.handler.authSwitcher.usageCount, 1);
});

test("each channel balances only its own load across accounts", t => {
    const h = poolHarness(t);
    const registry = h.handler.connectionRegistry;
    const scope = h.handler.forRequest(apiRequest("openai", "pg-gemini-4-argon"));
    scope.connectionRegistry.createMessageQueue("pg-active", 0, "a1");
    registry.createMessageQueue("build-active", 1, "a1");
    assert.equal(registry.messageQueues.get("pg-active").channel, "playground");
    assert.equal(registry.getQueueCountForAuth(0), 1);
    assert.equal(registry.getQueueCountForAuth(0, "build"), 0);
    for (let i = 0; i < 4; i++) {
        assert.equal(h.handler._selectDispatchAuthIndex(), 0, "Build ignores Playground load");
        assert.equal(scope._selectDispatchAuthIndex(), 1, "Playground ignores Build load");
    }
});

test("interleaved Build and Playground requests rotate independently", t => {
    const h = poolHarness(t);
    const scope = h.handler.forRequest(apiRequest("openai", "pg-gemini-4-argon"));
    const build = [];
    const playground = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        build.push(h.handler._selectDispatchAuthIndex());
        playground.push(scope._selectDispatchAuthIndex());
    }
    assert.deepEqual(build, [0, 1, 0, 1]);
    assert.deepEqual(playground, [0, 1, 0, 1]);
});

test("rotation advances past the only ready account when another account returns", t => {
    const h = poolHarness(t);
    let ready = [0];
    h.handler._getReadyAuthIndices = () => ready;
    assert.equal(h.handler._selectDispatchAuthIndex(), 0);
    ready = [0, 1];
    assert.equal(h.handler._selectDispatchAuthIndex(), 1);
});

test("dispatch prefers a ready account that is not draining", t => {
    const h = poolHarness(t);
    h.handler.browserManager.pendingContextClosures = new Map([[0, "rebalance"]]);
    h.handler.connectionRegistry.createMessageQueue("active", 1);
    assert.equal(h.handler._selectDispatchAuthIndex(), 1);
});

test("duplicate login files share one round-robin position and account load", t => {
    const h = poolHarness(t);
    h.handler.authSource.availableIndices = [0, 1, 2];
    h.handler.browserManager.currentAuthIndex = 2;
    h.handler.authSource.getCanonicalIndex = index => (index === 0 ? 1 : index);
    h.handler._getReadyAuthIndices = () => [0, 1, 2];
    assert.deepEqual(
        Array.from({ length: 4 }, () => h.handler._selectDispatchAuthIndex()),
        [1, 2, 1, 2]
    );
    h.handler.connectionRegistry.createMessageQueue("legacy-duplicate", 0);
    assert.equal(h.handler._selectDispatchAuthIndex(), 2);
});

test("deterministic client errors are not retried and never count as account failures", async t => {
    for (const [model, transport] of [
        ["build-gemini-4-argon", "build"],
        ["pg-gemini-4-argon", "playground"],
    ]) {
        const h = poolHarness(t);
        h.handler.config.switchOnUses = 0; // isolate failure handling from usage rotation
        const attempts = [];
        const fail = spec => {
            attempts.push(spec.request_id);
            h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue.enqueue({
                event_type: "error",
                message: "INVALID_ARGUMENT: The input token count exceeds the maximum",
                status: 400,
            });
        };
        h.handler.playground.forward = fail;
        for (const authIndex of [0, 1])
            h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
                send: data => JSON.parse(data).event_type !== "cancel_request" && fail(JSON.parse(data)),
            });
        const req = apiRequest("openai", model);
        const res = new FakeResponse();
        await h.handler.forRequest(req).processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 400, transport);
        assert.equal(attempts.length, 1, `${transport} must not repeat a deterministic 400`);
        assert.equal(h.handler.authSwitcher.failureCount, 0);
        assert.deepEqual(h.switches, []);
    }
});

test("an invalid API key is account-specific and keeps the normal retry", async t => {
    const h = poolHarness(t);
    let attempts = 0;
    for (const authIndex of [0, 1])
        h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return;
                const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                if (++attempts === 1)
                    queue.enqueue({ event_type: "error", message: "API key not valid. API_KEY_INVALID", status: 400 });
                else answer(queue);
            },
        });
    const req = apiRequest("openai", "build-gemini-4-argon");
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(attempts, 2);
});

test("repeated Playground 403 failures keep a short cooldown without declaring membership invalid", t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const h = poolHarness(t);
    const transport = h.handler.playground;
    for (let i = 0; i < 9; i++) {
        transport.fail("gemini-4-argon", 0, 403);
        assert.equal(transport.cooldownUntil("gemini-4-argon", 0) - now, 60000);
        assert.equal(h.handler.authSource.getAccountCooldown(0).remainingMs, 60000);
    }
    assert.equal(h.handler.authSource.isExpired(0), false);
    assert.equal(h.handler.authSource.isAccountCoolingDown(1), false);
    now += 60000;
    assert.equal(h.handler.authSource.isAccountCoolingDown(0), false);
});

test("Playground dispatch skips accounts cooling down for the model, including when all are cooling", t => {
    const h = poolHarness(t);
    const transport = h.handler.playground;
    transport.fail("gemini-4-argon", 0, 403);
    const scope = h.handler.forRequest(apiRequest("openai", "pg-gemini-4-argon-high"));
    assert.equal(scope.playgroundModel, "gemini-4-argon");
    for (let i = 0; i < 4; i++) assert.equal(scope._selectDispatchAuthIndex(), 1);
    // The same temporary account cooldown also excludes this account from other models.
    const other = h.handler.forRequest(apiRequest("openai", "pg-gemini-new"));
    assert.deepEqual(new Set([0, 1, 2, 3].map(() => other._selectDispatchAuthIndex())), new Set([1]));
    transport.fail("gemini-4-argon", 1, 429);
    assert.throws(() => scope._selectDispatchAuthIndex(), { coolingDown: true });
    assert.equal(scope._selectDispatchAuthIndex([0, 1], { allowFallback: false }), -1);
});

test("all Playground accounts cooling after 503 return an error without dispatch", async t => {
    const h = poolHarness(t);
    h.handler.playground.fail("gemini-4-argon", 0, 503);
    h.handler.playground.fail("gemini-4-argon", 1, 503);
    let sent = 0;
    h.handler.playground.forward = () => sent++;
    const res = new FakeResponse();
    await h.handler
        .forRequest(apiRequest("openai", "pg-gemini-4-argon"))
        .processOpenAIRequest(apiRequest("openai", "pg-gemini-4-argon"), res);
    assert.equal(res.statusCode, 503, res.output);
    assert.equal(sent, 0);
});

test("a Build 429 with limit: 0 tries other accounts but never cools, switches or rebalances", async t => {
    for (const entitled of [1, null]) {
        const h = poolHarness(t);
        h.handler.config.switchOnUses = 0;
        const tried = [];
        for (const authIndex of [0, 1])
            h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
                send(data) {
                    const spec = JSON.parse(data);
                    if (spec.event_type === "cancel_request") return;
                    tried.push(authIndex);
                    const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                    if (authIndex === entitled) return answer(queue);
                    queue.enqueue({
                        event_type: "error",
                        message: "429 RESOURCE_EXHAUSTED Quota exceeded for metric: x, limit: 0, model: gemini-4-argon",
                        status: 429,
                    });
                },
            });
        h.handler._selectDispatchAuthIndex = function (exclude = [], options) {
            return exclude.length ? RequestHandler.prototype._selectDispatchAuthIndex.call(this, exclude, options) : 0;
        };
        const req = apiRequest("openai", "build-gemini-4-argon");
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(req, res);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(res.statusCode, entitled === null ? 429 : 200, res.output);
        assert.deepEqual(tried, [0, 1]);
        assert.deepEqual(h.cooled, []);
        assert.deepEqual(h.switches, []);
        assert.equal(h.handler.authSwitcher.failureCount, 0);
    }
});

test("an ordinary Build 429 still cools the account down", async t => {
    const h = poolHarness(t);
    h.handler.config.switchOnUses = 0;
    for (const authIndex of [0, 1])
        h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return;
                const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                if (authIndex === 1) return answer(queue);
                queue.enqueue({ event_type: "error", message: "Resource exhausted, limit: 15", status: 429 });
            },
        });
    h.handler._selectDispatchAuthIndex = function (exclude = [], options) {
        return exclude.length ? RequestHandler.prototype._selectDispatchAuthIndex.call(this, exclude, options) : 0;
    };
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-3.8-flash"), res);
    assert.equal(res.statusCode, 200, res.output);
    assert.deepEqual(h.cooled, [0]);
});

test("accounts cooling down for Build quota are also excluded from Playground", async t => {
    const h = poolHarness(t);
    h.handler.authSource.isAccountCoolingDown = () => true;
    h.handler.authSource.getRotationIndices = () => [0, 1];
    h.handler.authSource.getAvailableRotationIndices = () => [];
    let served = 0;
    h.handler.playground.forward = spec => {
        served++;
        answer(h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue);
    };
    const build = new FakeResponse();
    h.handler._ensureBrowserBackedRequestReady = RequestHandler.prototype._ensureBrowserBackedRequestReady;
    h.handler.browserManager.notifyUserActivity = () => {};
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-4-argon"), build);
    assert.equal(build.statusCode, 429, "Build honours its own cooldown");
    const req = apiRequest("openai", "pg-gemini-4-argon");
    const res = new FakeResponse();
    await h.handler.forRequest(req).processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 429, res.output);
    assert.equal(served, 0);
});

function failingPool(t, accounts, respond) {
    const h = poolHarness(t);
    h.handler.authSource.availableIndices = accounts;
    h.handler.config.switchOnUses = 0;
    h.handler.config.maxRetries = accounts.length;
    h.handler._getReadyAuthIndices = () => accounts;
    const tried = [];
    for (const authIndex of accounts)
        h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return;
                tried.push(authIndex);
                const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                const response = respond(authIndex);
                if (response) queue.enqueue(response);
                else answer(queue);
            },
        });
    h.handler._selectDispatchAuthIndex = function (exclude = [], options) {
        return exclude.length ? RequestHandler.prototype._selectDispatchAuthIndex.call(this, exclude, options) : 0;
    };
    return { ...h, tried };
}

test("ordinary retries move to accounts the request has not tried yet", async t => {
    const h = failingPool(t, [0, 1, 2], authIndex =>
        authIndex === 2 ? null : { event_type: "error", message: "backend error", status: 500 }
    );
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-3.8-flash"), res);
    assert.equal(res.statusCode, 200, res.output);
    assert.deepEqual(h.tried, [0, 1, 2]);
});

test("the same failure on several accounts is not counted against the current account", async t => {
    const denied = {
        event_type: "error",
        message: "403 PERMISSION_DENIED The caller does not have permission",
        status: 403,
    };
    const h = failingPool(t, [0, 1], () => denied);
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-omni-1.1-flash"), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(h.tried, [0, 1]);
    assert.equal(h.handler.authSwitcher.failureCount, 0);
    assert.deepEqual(h.switches, []);

    // A failure seen on only one account still counts against it.
    const single = failingPool(t, [0], () => denied);
    await single.handler.processOpenAIRequest(apiRequest("openai", "build-gemini-3.8-flash"), new FakeResponse());
    assert.equal(single.handler.authSwitcher.failureCount, 1);
});

test("Playground does not list or accept transcription, music and agent models", async t => {
    const PlaygroundCatalog = require("../src/core/Playground/Catalog");
    const unsupported = [
        "gemini-3.5-transcribe",
        "lyria-3-clip-preview",
        "gemini-omni-flash-preview",
        "deep-research-preview-04-2026",
        "antigravity-preview-09-2026",
    ];
    for (const model of unsupported) assert.match(PlaygroundCatalog.unsupportedReason(model), /use build-/);
    for (const model of [
        "gemini-4-argon",
        "gemini-3.8-flash",
        "gemma-4-31b-it",
        "gemini-3.1-flash-image",
        "gemini-2.5-flash-preview-tts",
        "gemini-3.8-flash-tts",
    ])
        assert.equal(PlaygroundCatalog.unsupportedReason(model), null, model);

    const h = harness(t);
    h.handler.playground.catalog.discover([
        [...unsupported, "gemini-3.8-flash", "gemini-3.8-flash-tts"].map(name => [
            `models/${name}`,
            null,
            "",
            name,
            "",
            1,
            1,
            ["generateContent"],
        ]),
    ]);
    assert.deepEqual(
        h.handler.channelModels().playground.map(m => m.name),
        [
            "models/pg-gemini-4-argon",
            "models/pg-gemini-3.8-flash",
            "models/pg-gemini-3.8-flash-tts",
            "models/pg-gemini-4-argon-抗截断",
            "models/pg-gemini-3.8-flash-抗截断",
            "models/pg-gemini-4-argon-预设",
            "models/pg-gemini-3.8-flash-预设",
        ]
    );
    const reason = model =>
        h.handler._unsupportedPlaygroundRequest({
            body: {},
            method: "POST",
            path: `/v1beta/models/${model}:generateContent`,
        });
    assert.equal(reason("pg-gemini-3.8-flash-tts"), null);
    assert.match(reason("pg-gemini-3.5-transcribe-high"), /does not support gemini-3.5-transcribe/);
    assert.equal(reason("build-gemini-3.5-transcribe"), null);

    const queue = h.handler.connectionRegistry.createMessageQueue("transcribe", 0, "a1");
    // The harness stubs forward; exercise the real transport here.
    require("../src/core/Playground/Transport").prototype.forward.call(
        h.handler.playground,
        {
            body: "{}",
            path: "/v1beta/models/gemini-3.5-transcribe:generateContent",
            request_attempt_id: "a1",
            request_id: "transcribe",
        },
        0
    );
    const error = await queue.dequeue();
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
});

test("Playground drops thoughts the request did not ask for", () => {
    const { WireCodec } = require("../src/core/Playground/WireCodec");
    const chunk = () => ({
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "ok" }], role: "model" } }],
    });
    assert.equal(WireCodec.includesThoughts({}), false);
    assert.equal(WireCodec.includesThoughts({ generationConfig: { thinkingConfig: { includeThoughts: true } } }), true);
    assert.equal(
        WireCodec.includesThoughts({ generation_config: { thinking_config: { include_thoughts: true } } }),
        true
    );
    assert.deepEqual(WireCodec.withoutThoughts(chunk()).candidates[0].content.parts, [{ text: "ok" }]);
});

test("speech requests validate input and map OpenAI voices to Gemini voices", () => {
    const SpeechHandler = require("../src/core/RequestHandler/SpeechHandler");
    const ok = SpeechHandler.buildGeminiRequest({
        input: "Hello",
        model: "build-gemini-3.8-flash-tts",
        voice: "alloy",
    });
    assert.equal(ok.request.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
    assert.deepEqual(ok.request.generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(SpeechHandler.resolveVoice("puck"), "Puck");
    assert.equal(SpeechHandler.resolveVoice(undefined), "Kore");
    assert.equal(
        SpeechHandler.buildGeminiRequest({ input: "Hi", instructions: "Say cheerfully", model: "m" }).request
            .contents[0].parts[0].text,
        "Say cheerfully: Hi"
    );
    // Voices outside the known list (e.g. 3.8 voices) pass through for upstream to validate.
    assert.equal(SpeechHandler.resolveVoice("Fola"), "Fola");
    assert.match(
        SpeechHandler.buildGeminiRequest({ input: "Hi", model: "m", voice: "no body!" }).error,
        /Invalid voice/
    );
    assert.match(SpeechHandler.buildGeminiRequest({ input: " ", model: "m" }).error, /input/);
    assert.match(SpeechHandler.buildGeminiRequest({ input: "Hi" }).error, /model/);
});

test("raw PCM from Gemini is wrapped as WAV, WAV passes through, and pcm output strips the header", () => {
    const SpeechHandler = require("../src/core/RequestHandler/SpeechHandler");
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const wav = SpeechHandler.toAudio(
        { data: pcm.toString("base64"), mimeType: "audio/L16;codec=pcm;rate=24000" },
        "wav"
    );
    assert.equal(wav.contentType, "audio/wav");
    assert.equal(wav.body.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.body.readUInt32LE(24), 24000);
    assert.equal(wav.body.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.body.subarray(44), pcm);
    const passthrough = SpeechHandler.toAudio({ data: wav.body.toString("base64"), mimeType: "audio/wav" }, "wav");
    assert.deepEqual(passthrough.body, wav.body);
    const raw = SpeechHandler.toAudio({ data: wav.body.toString("base64"), mimeType: "audio/wav" }, "pcm");
    assert.deepEqual(raw.body, pcm);
});

test("POST /v1/audio/speech returns audio from a Build TTS model", async t => {
    const SpeechHandler = require("../src/core/RequestHandler/SpeechHandler");
    const h = poolHarness(t);
    const pcm = Buffer.alloc(480, 7);
    const sent = [];
    for (const authIndex of [0, 1])
        h.handler.connectionRegistry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") return;
                sent.push(spec);
                const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
                queue.enqueue({ event_type: "response_headers", status: 200 });
                const audio = { inlineData: { data: pcm.toString("base64"), mimeType: "audio/L16;rate=24000" } };
                queue.enqueue({
                    data: JSON.stringify({ candidates: [{ content: { parts: [audio] }, finishReason: "STOP" }] }),
                    event_type: "chunk",
                });
                queue.enqueue({ type: "STREAM_END" });
            },
        });
    const res = new FakeResponse();
    let body;
    res.end = value => {
        body = value;
        res.writableEnded = true;
    };
    await h.handler.processOpenAISpeechRequest(
        {
            body: { input: "Hello", model: "build-gemini-3.8-flash-tts", voice: "nova" },
            headers: {},
            method: "POST",
            path: "/v1/audio/speech",
            query: {},
        },
        res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.get("Content-Type"), "audio/wav");
    assert.deepEqual(body.subarray(44), pcm);
    assert.equal(sent[0].path, "/v1beta/models/gemini-3.8-flash-tts:generateContent");
    assert.equal(
        JSON.parse(sent[0].body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
        "Leda"
    );
    assert.ok(SpeechHandler);
});

test("POST /v1/audio/speech sends pg-* TTS models to Playground and joins streamed PCM", async t => {
    const h = harness(t);
    const req = {
        body: { input: "hi", model: "pg-gemini-3.8-flash-tts", voice: "Fola" },
        headers: {},
        method: "POST",
        path: "/v1/audio/speech",
        query: {},
    };
    assert.equal(h.handler._unsupportedPlaygroundRequest(req), null);
    const { WireCodec } = require("../src/core/Playground/WireCodec");
    const chunks = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0]), Buffer.from([4, 0, 5, 0])];
    h.handler.playground.forward = spec => {
        h.playground.push({ ...spec });
        const merged = {};
        for (const chunk of chunks) {
            const part = {
                inlineData: { data: chunk.toString("base64"), mimeType: "audio/l16; rate=24000; channels=1" },
            };
            WireCodec.merge(merged, { candidates: [{ content: { parts: [part], role: "model" }, index: 0 }] });
        }
        merged.candidates[0].finishReason = "STOP";
        const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
        queue.enqueue({ event_type: "response_headers", status: 200 });
        queue.enqueue({ data: JSON.stringify(WireCodec.joinAudio(merged)), event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    };
    const res = new FakeResponse();
    let body;
    res.end = value => {
        body = value;
        res.writableEnded = true;
    };
    await h.handler.forRequest(req).processOpenAISpeechRequest(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(h.build.length, 0);
    assert.equal(h.playground[0].channel, "playground");
    assert.equal(h.playground[0].path, "/v1beta/models/gemini-3.8-flash-tts:generateContent");
    assert.deepEqual(body.subarray(44), Buffer.concat(chunks));
    assert.equal(h.handler.authSwitcher.usageCount, 0);
});

test("Playground encodes speechConfig and matches the 2.5/3.1 transcript prefix", () => {
    const { WireCodec } = require("../src/core/Playground/WireCodec");
    const voice = name => ({ prebuiltVoiceConfig: { voiceName: name } });
    const single = WireCodec.encode("gemini-3.8-flash-tts", {
        contents: [{ parts: [{ text: "Hi" }], role: "user" }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: voice("Fola") } },
    });
    assert.deepEqual(single[3][14], [3]);
    assert.deepEqual(single[3][15], [[["Fola"]]]);
    const multi = WireCodec.encode("gemini-3.8-flash-tts", {
        contents: [{ parts: [{ text: "Joe: Hi\nJane: Hello" }] }],
        generation_config: {
            speech_config: {
                language_code: "en-US",
                multi_speaker_voice_config: {
                    speaker_voice_configs: [
                        { speaker: "Joe", voice_config: voice("Kore") },
                        { speaker: "Jane", voiceConfig: voice("Puck") },
                    ],
                },
            },
        },
    });
    // Same layout as the page's own two-speaker request: [null, null, [null, [[speaker, [[voice]]], ...]]].
    assert.deepEqual(multi[3][15], [
        null,
        "en-US",
        [
            null,
            [
                ["Joe", [["Kore"]]],
                ["Jane", [["Puck"]]],
            ],
        ],
    ]);
    // 3.8 needs one part per speaker turn, each naming its speaker (part field 41), as the page sends.
    const turns = multi[1][0][0];
    assert.deepEqual(
        turns.map(part => [part[1], part[40]]),
        [
            ["Hi", ["Joe"]],
            ["Hello", ["Jane"]],
        ]
    );
    assert.equal(
        WireCodec.speakerTurns("Joe: a\nmore\n\nJane:b", ["Jane", "Joe"])
            .turns.map(t => `${t.speaker}=${t.text}`)
            .join("|"),
        "Joe=a\nmore|Jane=b"
    );
    // The documented example: a direction line, then indented turns. The direction is the voice style.
    const documented = WireCodec.encode("gemini-3.8-flash-tts", {
        contents: [
            {
                parts: [
                    {
                        text: "TTS the following conversation between Joe and Jane:\n    Joe: How's it going?\n    Jane: Not too bad.",
                    },
                ],
            },
        ],
        generationConfig: {
            speechConfig: {
                multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: [
                        { speaker: "Joe", voiceConfig: voice("Rami") },
                        { speaker: "Jane", voiceConfig: voice("Fola") },
                    ],
                },
            },
        },
    });
    assert.deepEqual(
        documented[1][0][0].map(part => [part[1], part[40]]),
        [
            ["How's it going?", ["Joe", "TTS the following conversation between Joe and Jane:"]],
            ["Not too bad.", ["Jane", "TTS the following conversation between Joe and Jane:"]],
        ]
    );
    // A single block's voice style: [speaker = null, style], as the page sends.
    const styled = WireCodec.encode("gemini-3.8-flash-tts", {
        contents: [{ parts: [{ speechMetadata: { style: " Calm. " }, text: "Hi" }] }],
    });
    assert.equal(JSON.stringify(styled[1][0][0][0][40]), JSON.stringify([null, "Calm."]));
    const withMetadata = WireCodec.encode("gemini-3.8-flash-tts", {
        contents: [{ parts: [{ speechMetadata: { speaker: "Joe" }, text: "Joe: kept" }] }],
        generationConfig: {
            speechConfig: {
                multiSpeakerVoiceConfig: { speakerVoiceConfigs: [{ speaker: "Joe", voiceConfig: voice("Kore") }] },
            },
        },
    });
    assert.deepEqual(withMetadata[1][0][0][0][40], ["Joe"]);
    const multiConfig = {
        speechConfig: {
            multiSpeakerVoiceConfig: { speakerVoiceConfigs: [{ speaker: "Joe", voiceConfig: voice("Kore") }] },
        },
    };
    assert.throws(
        () =>
            WireCodec.encode("gemini-3.8-flash-tts", {
                contents: [{ parts: [{ text: "Hi" }] }],
                generationConfig: multiConfig,
            }),
        error => error.status === 400 && /configured speaker/.test(error.message)
    );
    // 2.5/3.1 read the public transcript format as is.
    const classic = WireCodec.encode("gemini-2.5-flash-preview-tts", {
        contents: [{ parts: [{ text: "Joe: Hi" }] }],
        generationConfig: multiConfig,
    });
    assert.equal(JSON.stringify(classic[1][0][0]), JSON.stringify([[null, "Joe: Hi"]]));
    assert.throws(
        () =>
            WireCodec.encode("m", {
                contents: [{ parts: [{ text: "Hi" }] }],
                generationConfig: { speechConfig: { voiceConfig: {} } },
            }),
        error => error.status === 400 && /voiceName/.test(error.message)
    );

    const wire = WireCodec.encode("gemini-2.5-flash-preview-tts", {
        contents: [{ parts: [{ text: "Good morning." }] }],
    });
    const native = [wire[0], [[[[null, "## Transcript:\nGood morning."]], "user"]]];
    WireCodec.alignTranscript(wire, native);
    assert.equal(wire[1][0][0][0][1], "## Transcript:\nGood morning.");
    assert.equal(WireCodec.hash(wire), WireCodec.hash(native));
    // 3.8 pages send the text unchanged; any other difference still fails the content check.
    const plain = WireCodec.encode("gemini-3.8-flash-tts", { contents: [{ parts: [{ text: "Hi" }] }] });
    WireCodec.alignTranscript(plain, [plain[0], [[[[null, "Hi"]], "user"]]]);
    assert.equal(plain[1][0][0][0][1], "Hi");
    const other = WireCodec.encode("gemini-2.5-flash-preview-tts", { contents: [{ parts: [{ text: "Hi" }] }] });
    WireCodec.alignTranscript(other, [other[0], [[[[null, "## Transcript:\nBye"]], "user"]]]);
    assert.notEqual(WireCodec.hash(other), WireCodec.hash([other[0], [[[[null, "## Transcript:\nBye"]], "user"]]]));
});

test("joinAudio drops the empty text part that ends a speech stream", () => {
    const { WireCodec } = require("../src/core/Playground/WireCodec");
    const audio = { inlineData: { data: "AQA=", mimeType: "audio/l16; rate=24000" } };
    const response = { candidates: [{ content: { parts: [audio, { text: "" }] } }] };
    assert.deepEqual(WireCodec.joinAudio(response).candidates[0].content.parts, [audio]);
    // Text responses keep their parts untouched.
    const text = { candidates: [{ content: { parts: [{ text: "" }, { text: "a" }] } }] };
    assert.equal(WireCodec.joinAudio(text).candidates[0].content.parts.length, 2);
});

test("speech output in chat formats is a playable WAV data URI, sent whole by fake streaming", async t => {
    const FormatConverter = new (require("../src/core/FormatConverter"))(logger);
    const pcm = Buffer.from([1, 0, 2, 0]);
    const markdown = FormatConverter._inlineDataMarkdown({
        data: pcm.toString("base64"),
        mimeType: "audio/l16; rate=24000; channels=1",
    });
    const match = markdown.match(/^!\[Generated Audio\]\(data:audio\/wav;base64,(.+)\)$/);
    assert.ok(match, markdown);
    const wav = Buffer.from(match[1], "base64");
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.deepEqual(wav.subarray(44), pcm);
    assert.equal(
        FormatConverter._inlineDataMarkdown({ data: "eA==", mimeType: "image/png" }),
        "![Generated Image](data:image/png;base64,eA==)"
    );

    const h = harness(t);
    const media = `![Generated Audio](data:audio/wav;base64,${"A".repeat(1000)})`;
    h.handler.connectionRegistry.connectionsByAuth.set(0, {
        send(data) {
            const spec = JSON.parse(data);
            if (spec.event_type === "cancel_request") return;
            const queue = h.handler.connectionRegistry.messageQueues.get(spec.request_id).queue;
            const response = {
                candidates: [
                    { content: { parts: [{ text: media + "x".repeat(300) }], role: "model" }, finishReason: "STOP" },
                ],
            };
            queue.enqueue({ event_type: "response_headers", status: 200 });
            queue.enqueue({ data: JSON.stringify(response), event_type: "chunk" });
            queue.enqueue({ type: "STREAM_END" });
        },
    });
    const req = apiRequest("openai", "build-gemini-4-argon");
    req.body.stream = true;
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(req, res);
    const deltas = res.output
        .split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "");
    assert.equal(deltas.join(""), media + "x".repeat(300));
    assert.ok(
        deltas.some(text => text.includes(media)),
        "the audio URI is delivered whole"
    );
});

test("the speech endpoint rejects non-TTS pg models and sends instructions as the 3.8 voice style", t => {
    const h = harness(t);
    const reason = model =>
        h.handler._unsupportedPlaygroundRequest({
            body: { input: "hi", model },
            method: "POST",
            path: "/v1/audio/speech",
        });
    assert.match(reason("pg-gemini-4-argon"), /not a text-to-speech model/);
    assert.equal(reason("pg-gemini-2.5-flash-preview-tts"), null);
    assert.equal(reason("build-gemini-4-argon"), null);

    const SpeechHandler = require("../src/core/RequestHandler/SpeechHandler");
    const body = { input: "Have a nice day", instructions: "Cheerful", model: "pg-gemini-3.8-flash-tts" };
    assert.deepEqual(SpeechHandler.buildGeminiRequest(body, { voiceStyle: true }).request.contents[0].parts, [
        { speechMetadata: { style: "Cheerful" }, text: "Have a nice day" },
    ]);
    assert.deepEqual(SpeechHandler.buildGeminiRequest(body).request.contents[0].parts, [
        { text: "Cheerful: Have a nice day" },
    ]);
    const PlaygroundCatalog = require("../src/core/Playground/Catalog");
    assert.equal(PlaygroundCatalog.usesSpeechBlocks("gemini-3.8-flash-lite-tts"), true);
    assert.equal(PlaygroundCatalog.usesSpeechBlocks("models/gemini-3.1-flash-tts-preview"), false);
    assert.equal(PlaygroundCatalog.usesSpeechBlocks("gemini-4-argon"), false);
});

test("joinAudio joins only consecutive PCM parts of one format", () => {
    const { WireCodec } = require("../src/core/Playground/WireCodec");
    const pcm = (bytes, mimeType = "audio/l16; rate=24000") => ({
        inlineData: { data: Buffer.from(bytes).toString("base64"), mimeType },
    });
    const response = {
        candidates: [
            {
                content: {
                    parts: [pcm([1, 0]), pcm([2, 0]), { text: "x" }, pcm([3, 0]), pcm([4, 0], "audio/wav")],
                },
            },
        ],
    };
    const parts = WireCodec.joinAudio(response).candidates[0].content.parts;
    assert.equal(parts.length, 4);
    assert.deepEqual(Buffer.from(parts[0].inlineData.data, "base64"), Buffer.from([1, 0, 2, 0]));
    assert.deepEqual(parts[1], { text: "x" });
    assert.deepEqual(Buffer.from(parts[2].inlineData.data, "base64"), Buffer.from([3, 0]));
    assert.equal(parts[3].inlineData.mimeType, "audio/wav");
});

test("native Gemini requests are tracked under their public channel name", t => {
    const h = harness(t);
    assert.equal(
        h.handler._trackedModelName("/v1beta/models/pg-gemma-4-31b-it-high:generateContent"),
        "pg-gemma-4-31b-it"
    );
    assert.equal(
        h.handler._trackedModelName(
            `/v1beta/models/build-gemini-4-argon${encodeURIComponent("-抗截断")}:generateContent`
        ),
        "build-gemini-4-argon-抗截断"
    );
});
