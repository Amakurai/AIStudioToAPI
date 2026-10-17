const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ModelRouter = require("../src/core/ModelRouter");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const wireChunk = text => [[[[[[null, text]], "model"], 1]], null, [10, 3, 13]];

// Exactly what build.js reports when AI Studio's ProxyUnaryCall rejects a Build generation request.
const BUILD_PROXY_REJECTION =
    'Proxy browser error: Google API returned error: 400 INVALID_ARGUMENT {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

function harness(t, catalog) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-build-proxy-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    fs.writeFileSync(
        path.join(dir, "routes.json"),
        JSON.stringify({ accounts: {}, models: catalog.map(name => ({ name: `models/${name}` })), version: 2 })
    );
    const registry = new ConnectionRegistry(logger);
    const context = {};
    const handler = {
        browserManager: { contexts: new Map([[1, { context }]]) },
        config: {
            modelList: [{ name: "models/gemini-3.7-flash" }, { name: "models/gemini-3.8-flash" }],
            modelRoutesPath: path.join(dir, "routes.json"),
            playgroundEnabled: true,
        },
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: 1000 },
    };
    const router = new ModelRouter(handler);
    const queue = registry.createMessageQueue("req", 1, "attempt1");
    let calls = 0;
    router.sessions.set(context, {
        async request(_model, _body, { onData }) {
            calls++;
            onData(JSON.stringify([[wireChunk("hello")]]));
        },
    });
    const spec = model => ({
        body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] }),
        path: `/v1beta/models/${model}:generateContent`,
        request_attempt_id: "attempt1",
        request_id: "req",
        streaming_mode: "fake",
    });
    const receive = message =>
        registry._handleIncomingMessage(
            JSON.stringify({ request_attempt_id: "attempt1", request_id: "req", ...message }),
            1
        );
    return { calls: () => calls, queue, receive, router, spec };
}

test("bare Build proxy INVALID_ARGUMENT is a fallback signal; detailed validation errors are not", () => {
    assert.equal(ModelRouter.canFallback({ event_type: "error", message: BUILD_PROXY_REJECTION, status: 400 }), true);
    for (const message of [
        'Google API returned error: 400 INVALID_ARGUMENT {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"contents"}]}]}}',
        'Google API returned error: 400 INVALID_ARGUMENT {"error":{"code":400,"message":"* GenerateContentRequest.contents: contents is not specified","status":"INVALID_ARGUMENT"}}',
        "invalid request",
    ])
        assert.equal(ModelRouter.canFallback({ event_type: "error", message, status: 400 }), false);
    // The same text with another status keeps its existing meaning.
    assert.equal(ModelRouter.canFallback({ event_type: "error", message: BUILD_PROXY_REJECTION, status: 500 }), false);
});

test("Build proxy rejection of a Playground-listed model is served by Playground and learned", async t => {
    const h = harness(t, ["gemini-3.8-flash"]);
    assert.equal(h.router.forward(h.spec("gemini-3.8-flash"), 1), false);
    h.receive({ event_type: "error", message: BUILD_PROXY_REJECTION, status: 400 });
    assert.equal((await h.queue.dequeue()).status, 200);
    assert.match((await h.queue.dequeue()).data, /hello/);
    assert.equal((await h.queue.dequeue()).type, "STREAM_END");
    assert.equal(h.calls(), 1);
    assert.equal(h.router.channel("gemini-3.8-flash-抗截断", 1), "playground");
});

test("Build proxy rejection of a model Playground does not list is returned unchanged", async t => {
    const h = harness(t, ["gemini-3.8-flash"]);
    assert.equal(h.router.forward(h.spec("gemini-3.7-flash"), 1), false);
    h.receive({ event_type: "error", message: BUILD_PROXY_REJECTION, status: 400 });
    const error = await h.queue.dequeue();
    assert.equal(error.event_type, "error");
    assert.equal(error.status, 400);
    assert.equal(h.calls(), 0);
    assert.equal(h.router.channel("gemini-3.7-flash", 1), "build");
});
