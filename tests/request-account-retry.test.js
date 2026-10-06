const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AuthSource = require("../src/auth/AuthSource");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const limited = () => ({ event_type: "error", message: "Quota exhausted", status: 429 });
const success = () => ({
    candidates: [{ content: { parts: [{ text: "recovered" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
});

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.headersSent = false;
        this.output = "";
        this.statusCode = 200;
        this.writableEnded = false;
        this.socket = { destroyed: false, writable: true };
    }
    setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
    }
    set(name, value) {
        if (typeof name === "object") {
            for (const [key, entry] of Object.entries(name)) this.setHeader(key, entry);
        } else this.setHeader(name, value);
        return this;
    }
    get(name) {
        return this.headers[name.toLowerCase()];
    }
    getHeader(name) {
        return this.get(name);
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
        this.set(headers || {});
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

function harness({ available = [0, 1, 2], current = 0, ready = available, respond = () => success() } = {}) {
    // Avoid loading real credential files while exercising AuthSource's actual availability rules.
    const authSource = Object.assign(Object.create(AuthSource.prototype), {
        accountCooldowns: new Map(),
        accountNameMap: new Map(),
        availableIndices: available,
        canonicalIndexMap: new Map(available.map(index => [index, index])),
        rotationIndices: available,
    });
    const registry = new ConnectionRegistry(logger);
    const sent = [];
    const cancelled = [];
    const switched = [];
    const browser = {
        contexts: new Map(),
        currentAuthIndex: current,
        initializingContexts: new Set(),
        async launchOrSwitchContext(index) {
            await this.switchAccount(index);
        },
        notifyUserActivity() {},
        async preCleanupForSwitch() {},
        async rebalanceContextPool() {},
        async switchAccount(index) {
            switched.push(index);
            this.currentAuthIndex = index;
            addReadyAccount(index);
        },
    };
    function addReadyAccount(index) {
        browser.contexts.set(index, { page: { isClosed: () => false } });
        registry.connectionsByAuth.set(index, {
            readyState: 1,
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") {
                    cancelled.push({ index, spec });
                    return;
                }
                sent.push({ index, spec });
                const queue = registry.messageQueues.get(spec.request_id).queue;
                // Fail deterministically if a regression loops back through attempted accounts forever.
                const response =
                    sent.length > available.length + 1
                        ? { event_type: "error", message: "retry loop", status: 400 }
                        : respond(index, spec, sent.length);
                if (response.event_type === "error") {
                    queue.enqueue(response);
                    return;
                }
                queue.enqueue({ event_type: "response_headers", headers: {}, status: 200 });
                const json = JSON.stringify(response);
                const streamed = spec.path.includes(":streamGenerateContent") && spec.streaming_mode === "real";
                queue.enqueue({ data: streamed ? `data: ${json}\n\n` : json, event_type: "chunk" });
                queue.enqueue({ type: "STREAM_END" });
            },
        });
    }
    for (const index of ready) addReadyAccount(index);
    const config = {
        fakeStreamTimeoutMs: 100,
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 1,
        retryDelay: 1,
        streamingMode: "real",
        switchOnUses: 0,
    };
    const handler = new RequestHandler({ config }, registry, logger, browser, config, authSource);
    return { authSource, browser, cancelled, handler, registry, sent, switched };
}

function rawRequest(h, sourceIndex) {
    const spec = {
        body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] }),
        is_generative: true,
        path: "/v1beta/models/gemini-3.8-flash:generateContent",
        request_id: `test-${h.sent.length}`,
        streaming_mode: "fake",
    };
    h.handler._initializeProxyRequestAttempt(spec);
    const queue = h.registry.createMessageQueue(spec.request_id, sourceIndex, spec.request_attempt_id);
    return { queue, spec };
}

test("429 retries visit all ready accounts even after the current account has already failed", async () => {
    const h = harness({
        available: [0, 1, 2, 3],
        respond: (_index, _spec, count) => (count < 4 ? limited() : success()),
    });
    const { queue, spec } = rawRequest(h, 2);
    const result = await h.handler._executeRequestWithRetries(spec, queue);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(h.sent.length, 4);
    assert.equal(h.sent[0].index, 2);
    assert.deepEqual([...new Set(h.sent.map(item => item.index))].sort(), [0, 1, 2, 3]);
    assert.equal(new Set(h.sent.map(item => item.spec.request_attempt_id)).size, 4);
    assert.deepEqual(
        h.cancelled.map(item => item.index),
        h.sent.slice(0, -1).map(item => item.index)
    );
    for (const item of h.sent.slice(0, -1)) assert.equal(h.authSource.isAccountCoolingDown(item.index), true);
    assert.equal(h.authSource.isAccountCoolingDown(h.sent.at(-1).index), false);
    h.registry.removeMessageQueue(spec.request_id);
});

test("429 can cold-start a spare account when the ready pool is exhausted", async () => {
    const h = harness({ current: 1, ready: [1], respond: index => (index === 2 ? success() : limited()) });
    const { queue, spec } = rawRequest(h, 1);
    const result = await h.handler._executeRequestWithRetries(spec, queue);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(
        h.sent.map(item => item.index),
        [1, 0, 2]
    );
    assert.deepEqual(h.switched, [0, 2]);
    assert.deepEqual(h.handler._getReadyAuthIndices(), [2]);
    h.registry.removeMessageQueue(spec.request_id);
});

test("when every account returns 429, each is tried once and the original status is returned", async () => {
    const h = harness({ ready: [0, 1], respond: limited });
    const { queue, spec } = rawRequest(h, 1);
    const result = await h.handler._executeRequestWithRetries(spec, queue);
    assert.equal(result.success, false);
    assert.equal(result.error.status, 429);
    assert.equal(result.error.skipAccountSwitch, true);
    assert.deepEqual(h.sent.map(item => item.index).sort(), [0, 1, 2]);
    assert.deepEqual(h.handler._getReadyAuthIndices(), []);
    assert.deepEqual(h.authSource.getAvailableRotationIndices(), []);
    h.registry.removeMessageQueue(spec.request_id);
});

test("a single limited account returns 429 without restarting or retrying the same account", async () => {
    const h = harness({ available: [0], respond: limited });
    const { queue, spec } = rawRequest(h, 0);
    const result = await h.handler._executeRequestWithRetries(spec, queue);
    assert.equal(result.error.status, 429);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.switched, []);
    h.registry.removeMessageQueue(spec.request_id);
});

test("failed standby initialization never restarts the cooling source account during recovery", async () => {
    const h = harness({ ready: [0] });
    h.authSource.markAccountCoolingDown(0);
    const launched = [];
    h.browser.launchOrSwitchContext = async index => {
        launched.push(index);
        throw new Error("Unexpected direct recovery of a cooling account");
    };
    h.browser.switchAccount = async index => {
        h.switched.push(index);
        throw new Error("Standby browser failed to initialize");
    };
    const res = new FakeResponse();
    const recovered = await h.handler._handleBrowserRecovery(res);
    assert.equal(recovered, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(launched, []);
    assert.deepEqual(h.switched, [1, 2]);
    assert.equal(h.handler.currentAuthIndex, -1);
    assert.equal(h.handler.authSwitcher.isSystemBusy, false);
    assert.equal(h.authSource.isAccountCoolingDown(0), true);
    assert.equal(h.sent.length, 0);
});

const processors = {
    claude: "processClaudeRequest",
    gemini: "processRequest",
    openai: "processOpenAIRequest",
    responses: "processOpenAIResponseRequest",
};

function apiRequest(api, stream) {
    const common = { headers: {}, method: "POST", query: {} };
    const model = "gemini-3.8-flash";
    if (api === "gemini")
        return {
            ...common,
            body: { contents: [{ parts: [{ text: "Hi" }], role: "user" }] },
            path: `/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`,
        };
    if (api === "responses") return { ...common, body: { input: "Hi", model, stream }, path: "/v1/responses" };
    return {
        ...common,
        body: { max_tokens: 100, messages: [{ content: "Hi", role: "user" }], model, stream },
        path: api === "claude" ? "/v1/messages" : "/v1/chat/completions",
    };
}

test("all public handlers retry non-current dispatch accounts on 429 with MAX_RETRIES=1", async t => {
    for (const [api, processor] of Object.entries(processors)) {
        for (const mode of ["nonstream", "real", "fake"]) {
            await t.test(`${api} ${mode}`, async () => {
                const h = harness({ respond: index => (index === 1 ? limited() : success()) });
                h.handler._dispatchCursor = 1;
                h.handler.config.streamingMode = mode === "fake" ? "fake" : "real";
                const res = new FakeResponse();
                await h.handler[processor](apiRequest(api, mode !== "nonstream"), res);
                assert.equal(res.statusCode, 200, res.output);
                assert.match(res.output, /recovered/);
                assert.equal(h.sent.length, 2);
                assert.equal(h.sent[0].index, 1);
                assert.notEqual(h.sent[1].index, 1);
                assert.equal(h.authSource.isAccountCoolingDown(1), true);
                assert.equal(h.authSource.isAccountCoolingDown(0), false);
                assert.equal(h.registry.messageQueues.size, 0);
                assert.equal(res.writableEnded, true);
                for (let next = 0; next < 6; next++) assert.notEqual(h.handler._selectDispatchAuthIndex(), 1);
            });
        }
    }
});

test("fake-stream errors after a keepalive preserve 429 after every account has failed", async () => {
    const h = harness({ respond: limited });
    const { queue, spec } = rawRequest(h, 1);
    const res = new FakeResponse();
    res.__proxyApiFormat = "gemini";
    res.__proxyResponseStreamMode = "fake";
    res.type("text/event-stream");
    res.write(": keep-alive\n\n");
    await h.handler._handlePseudoStreamResponse(spec, queue, { headers: {} }, res);
    const errorEvent = res.output.split("\n").find(line => line.startsWith("data: "));
    const payload = JSON.parse(errorEvent.slice(6));
    assert.equal(res.statusCode, 200);
    assert.equal(payload.error.code, 429);
    assert.equal(payload.error.status, "RESOURCE_EXHAUSTED");
    assert.equal(res.writableEnded, true);
    assert.equal(h.sent.length, 3);
    h.registry.removeMessageQueue(spec.request_id);
});

function duplexSegment(seq, text, done) {
    return {
        candidates: [
            {
                content: {
                    parts: [
                        {
                            functionCall: { args: { done, seq, text }, name: "append_output" },
                            thoughtSignature: "retained-signature",
                        },
                    ],
                    role: "model",
                },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
    };
}

function sseFrames(res) {
    return res.output
        .split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));
}

test("anti-truncation continuation switches the actual dispatch account without repeating accepted text", async t => {
    for (const mode of ["nonstream", "real", "fake"]) {
        await t.test(mode, async () => {
            const h = harness({
                respond: (_index, _spec, count) => {
                    if (count === 1) return duplexSegment(1, "accepted ", false);
                    if (count === 2) return limited();
                    return duplexSegment(2, "continued", true);
                },
            });
            h.handler._dispatchCursor = 1;
            h.handler.config.streamingMode = mode === "fake" ? "fake" : "real";
            const req = apiRequest("openai", mode !== "nonstream");
            req.body.model += "-抗截断";
            const res = new FakeResponse();
            await h.handler.processOpenAIRequest(req, res);
            assert.equal(res.statusCode, 200, res.output);
            const visible =
                mode === "nonstream"
                    ? JSON.parse(res.output).choices[0].message.content
                    : sseFrames(res)
                          .map(frame => frame.choices?.[0]?.delta?.content || "")
                          .join("");
            assert.equal(visible, "accepted continued", res.output);
            assert.equal(h.sent.length, 3);
            assert.equal(h.sent[0].index, 1);
            assert.equal(h.sent[1].index, 1);
            assert.notEqual(h.sent[2].index, 1);
            assert.equal(h.sent[1].spec.body, h.sent[2].spec.body);
            const history = JSON.parse(h.sent[2].spec.body).contents;
            assert.ok(history.some(turn => turn.parts.some(part => part.thoughtSignature === "retained-signature")));
            assert.ok(history.some(turn => turn.parts.some(part => part.functionResponse?.response?.received === 1)));
            assert.equal(h.authSource.isAccountCoolingDown(1), true);
            assert.equal(h.authSource.isAccountCoolingDown(h.sent[2].index), false);
            assert.equal(h.registry.messageQueues.size, 0);
            assert.equal(res.writableEnded, true);
        });
    }
});

test("all accounts already cooling return 429 without dispatch for ordinary and anti-truncation requests", async t => {
    for (const alias of [false, true]) {
        for (const stream of [false, true]) {
            await t.test(`alias=${alias} stream=${stream}`, async () => {
                const h = harness();
                for (const index of h.authSource.availableIndices) h.authSource.markAccountCoolingDown(index);
                const req = apiRequest("openai", stream);
                if (alias) req.body.model += "-抗截断";
                const res = new FakeResponse();
                // Ordinary fake-stream handlers can have already committed keepalive headers.
                if (stream && !alias) {
                    res.type("text/event-stream");
                    res.write(": keep-alive\n\n");
                }
                await h.handler.processOpenAIRequest(req, res);
                const error = stream ? sseFrames(res).find(frame => frame.error)?.error : JSON.parse(res.output).error;
                assert.equal(error?.code, 429, res.output);
                assert.equal(res.statusCode, stream ? 200 : 429);
                assert.equal(h.sent.length, 0);
                assert.deepEqual(h.switched, []);
                assert.equal(h.registry.messageQueues.size, 0);
                assert.equal(res.writableEnded, true);
            });
        }
    }
});

test("ordinary requests disconnected during account switching never dispatch a retry", async t => {
    for (const api of ["openai", "responses", "claude", "gemini"]) {
        for (const mode of ["nonstream", "real", "fake"]) {
            await t.test(`${api} ${mode}`, async () => {
                const h = harness({ respond: index => (index === 0 ? limited() : success()) });
                h.handler.config.streamingMode = mode === "fake" ? "fake" : "real";
                const res = new FakeResponse();
                const originalSwitch = h.browser.switchAccount.bind(h.browser);
                h.browser.switchAccount = async index => {
                    res.destroyed = true;
                    res.emit("close");
                    await originalSwitch(index);
                };
                await h.handler[processors[api]](apiRequest(api, mode !== "nonstream"), res);
                assert.equal(h.sent.length, 1, "Client has disconnected: no additional upstream generation is allowed");
                assert.equal(h.registry.messageQueues.size, 0);
            });
        }
    }
});
