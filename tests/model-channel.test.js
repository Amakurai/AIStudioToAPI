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

test("Build anti-truncation accepts the build- prefix; Playground rejects anti-truncation", () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.playground = { enabled: true };
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
    assert.throws(
        () =>
            handler._initializeProxyRequestAttempt({
                is_generative: true,
                path: "/v1beta/models/pg-gemini-4-argon-抗截断:generateContent",
                request_id: "r",
            }),
        error => error.status === 400 && /anti-truncation/.test(error.message)
    );
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
    assert.match(reason("POST", "/v1/chat/completions", { model: "pg-gemini-4-argon-抗截断" }), /anti-truncation/);
    assert.match(
        reason("POST", `/v1beta/models/pg-gemini-4-argon${encodeURIComponent("-抗截断")}:generateContent`),
        /anti-truncation/
    );
    assert.match(reason("POST", "/v1beta/models/pg-gemini-4-argon:countTokens"), /only support content generation/);
    assert.match(reason("POST", "/v1/messages/count_tokens", { model: "pg-gemini-4-argon" }), /only support/);
    assert.match(reason("POST", "/v1/embeddings", { model: "pg-gemini-4-argon" }), /only support/);
    assert.match(reason("GET", "/v1beta/models/pg-gemini-4-argon"), /only support/);
    h.handler.config.playgroundEnabled = false;
    assert.match(reason("POST", "/v1/chat/completions", { model: "pg-gemini-4-argon" }), /disabled/);
});

test("each channel lists its own models with its own prefix", t => {
    const h = harness(t);
    const names = channel => h.handler.channelModels()[channel].map(model => model.name);
    assert.deepEqual(names("build"), ["models/build-gemini-3.8-flash", "models/build-gemini-4-argon"]);
    assert.deepEqual(names("playground"), ["models/pg-gemini-4-argon"]);
    h.handler.playground.catalog.discover([[["models/gemini-new", null, "", "New", "", 1, 1, ["generateContent"]]]]);
    assert.deepEqual(names("playground"), ["models/pg-gemini-4-argon", "models/pg-gemini-new"]);
    assert.equal(names("build").length, 2);
    h.handler.config.playgroundEnabled = false;
    assert.deepEqual(names("playground"), []);
});
