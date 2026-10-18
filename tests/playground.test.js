const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WireCodec, WireStream } = require("../src/core/Playground/WireCodec");
const PlaygroundTransport = require("../src/core/Playground/Transport");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const body = () => ({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] });
const wireChunk = (text, reason = 1) => [[[[[[null, text]], "model"], reason]], null, [10, 3, 13]];
const response = text => JSON.stringify([[wireChunk(text)]]);

test("JSPB function values retain nested arrays, empty containers, null and booleans", () => {
    const value = { a: [1, true, false, null, "中文🙂", { x: ["one"] }], b: [], c: {}, d: 0 };
    assert.deepEqual(WireCodec.decodeStruct(WireCodec.struct(value)), value);
    assert.equal(WireCodec.decodeValue([null, null, null, 0]), false);
    assert.equal(WireCodec.decodeValue([null, null, null, 1]), true);
});

test("tool declarations, signed history and system instructions use distinct protocol fields", () => {
    const request = body();
    request.systemInstruction = { parts: [{ text: "System" }] };
    request.contents.push({
        parts: [{ functionCall: { args: { query: "hi" }, id: "call1", name: "lookup" }, thoughtSignature: "sig" }],
        role: "model",
    });
    request.contents.push({
        parts: [{ functionResponse: { id: "call1", name: "lookup", response: { items: [1] } } }],
        role: "user",
    });
    request.tools = [
        {
            functionDeclarations: [
                {
                    description: "Find a thing",
                    name: "lookup",
                    parameters: { properties: { query: { type: "STRING" } }, required: ["query"], type: "OBJECT" },
                },
            ],
        },
    ];
    const wire = WireCodec.encode("gemini-4-argon", request);
    assert.equal(wire[0], "models/gemini-4-argon");
    assert.equal(wire[5][0][0][1], "System");
    assert.equal(wire[1][1][0][0][10][0], "lookup");
    assert.equal(wire[1][1][0][0][14], "sig");
    assert.deepEqual(WireCodec.decodeStruct(wire[1][2][0][0][11][1]), { items: [1] });
    assert.equal(wire[6][0][1][0][2][0], 6);
    assert.equal(wire[6][0][1][0][2][6][0][0], "query");
});

test("every UTF-8 text boundary and JSON escape can be fragmented without losing parts", () => {
    const expected = '中文🙂 [brackets] "quotes" \\ slash\nnext';
    const out = {};
    const parser = new WireStream(chunk => WireCodec.merge(out, WireCodec.decode(chunk, "gemini-4-argon")));
    for (const character of ")]}'\n" + response(expected)) parser.feed(character);
    parser.finish();
    assert.equal(out.candidates[0].content.parts[0].text, expected);
    assert.equal(out.candidates[0].finishReason, "STOP");
    assert.equal(out.usageMetadata.totalTokenCount, 13);
});

test("truncated envelopes are rejected even after complete text chunks", () => {
    for (const truncated of ["", "[[", response("prefix").slice(0, -1)]) {
        const parser = new WireStream(() => {});
        parser.feed(truncated);
        assert.throws(() => parser.finish(), /truncated or empty/);
    }
});

test("function responses retain IDs, signatures and blocked finish reasons", () => {
    const part = [];
    part[3] = ["append_output", WireCodec.struct({ done: true, seq: 1, text: "正文" }), "f1"];
    part[14] = "signature";
    const chunk = [[[[[part], "model"], 8]], null, [2, 3, 5]];
    const parsed = WireCodec.decode(chunk, "gemini-4-argon");
    assert.deepEqual(parsed.candidates[0].content.parts[0], {
        functionCall: { args: { done: true, seq: 1, text: "正文" }, id: "f1", name: "append_output" },
        thoughtSignature: "signature",
    });
    assert.equal(parsed.candidates[0].finishReason, "PROHIBITED_CONTENT");
});

function harness(t, mode = "fake") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-routing-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const registry = new ConnectionRegistry(logger);
    const context = {};
    const handler = {
        browserManager: { contexts: new Map([[1, { context }]]) },
        config: {
            modelList: [{ name: "models/gemini-3.8-flash" }, { name: "models/gemini-4-argon" }],
            playgroundCatalogPath: path.join(dir, "playground-models.json"),
            playgroundEnabled: true,
            playgroundModelList: [{ name: "models/gemini-4-argon" }],
        },
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: 1000 },
    };
    const router = new PlaygroundTransport(handler);
    const queue = registry.createMessageQueue("req", 1, "attempt1");
    const spec = {
        body: JSON.stringify(body()),
        path: `/v1beta/models/gemini-4-argon:${mode === "real" ? "streamGenerateContent" : "generateContent"}`,
        request_attempt_id: "attempt1",
        request_id: "req",
        streaming_mode: mode,
    };
    let calls = 0;
    router.sessions.set(context, {
        async request(_model, _body, { onData }) {
            calls++;
            onData(response("hello"));
        },
    });
    return { calls: () => calls, context, handler, queue, registry, router, spec };
}

test("native stream and buffered requests get Gemini output via the existing queue", async t => {
    for (const mode of ["real", "fake"]) {
        const h = harness(t, mode);
        h.router.forward(h.spec, 1);
        const headers = await h.queue.dequeue();
        assert.equal(headers.status, 200);
        assert.equal(headers.headers["x-aistudio-channel"], "playground");
        const chunk = await h.queue.dequeue();
        const data = JSON.parse(mode === "real" ? chunk.data.slice(6) : chunk.data);
        assert.equal(data.candidates[0].content.parts[0].text, "hello");
        assert.equal((await h.queue.dequeue()).type, "STREAM_END");
    }
});

test("real-streamed speech is sent as one joined clip, not one event per PCM part", async t => {
    const h = harness(t, "real");
    h.spec.path = "/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent";
    const audioChunk = (bytes, finish) => {
        const part = [];
        part[2] = ["audio/l16; rate=24000; channels=1", Buffer.from(bytes).toString("base64")];
        // chunk = [candidates], candidate = [[parts, role], finishReason]
        return [[[[[part], "model"], ...(finish ? [1] : [])]]];
    };
    h.router.sessions.set(h.context, {
        async request(_model, _body, { onData }) {
            onData(JSON.stringify([[audioChunk([1, 0]), audioChunk([2, 0]), audioChunk([3, 0], true)]]));
        },
    });
    h.router.forward(h.spec, 1);
    const headers = await h.queue.dequeue();
    assert.equal(headers.status, 200, headers.message);
    assert.equal(headers.headers["content-type"], "text/event-stream");
    const chunk = await h.queue.dequeue();
    assert.ok(chunk.data.startsWith("data: "));
    const parts = JSON.parse(chunk.data.slice(6)).candidates[0].content.parts;
    assert.equal(parts.length, 1);
    assert.deepEqual(Buffer.from(parts[0].inlineData.data, "base64"), Buffer.from([1, 0, 2, 0, 3, 0]));
    assert.equal((await h.queue.dequeue()).type, "STREAM_END");
});

test("cancellation and timeouts abort Playground without returning late content", async t => {
    const h = harness(t);
    let aborted = false;
    h.router.sessions.set(h.context, {
        request(_m, _b, { signal }) {
            return new Promise((resolve, reject) =>
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        reject(new Error("cancelled"));
                    },
                    { once: true }
                )
            );
        },
    });
    h.router.forward(h.spec, 1);
    assert.equal(h.router.cancel("req", "old-attempt"), false);
    h.queue.close("client_disconnect");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(h.queue.messages.length, 0);
});

test("cancelled Playground waiters settle promptly and never take the active page", async () => {
    const Session = require("../src/core/Playground/Session");
    const session = new Session({}, () => {});
    let release;
    const models = [];
    session._request = async model => {
        models.push(model);
        if (model === "first")
            await new Promise(resolve => {
                release = resolve;
            });
    };
    const first = session.request("first", {}, { signal: new AbortController().signal });
    await new Promise(resolve => setImmediate(resolve));
    const aborter = new AbortController();
    const waiting = session.request("cancelled", {}, { signal: aborter.signal });
    aborter.abort();
    await assert.rejects(waiting, error => error.status === 499);
    const third = session.request("third", {}, { signal: new AbortController().signal });
    assert.deepEqual(models, ["first"]);
    release();
    await Promise.all([first, third]);
    assert.deepEqual(models, ["first", "third"]);
});

test("incomplete Playground streams fail without allowing a retry after visible content", async t => {
    const h = harness(t, "real");
    h.router.sessions.set(h.context, {
        async request(_m, _b, { onData }) {
            onData(response("prefix").slice(0, -1));
        },
    });
    h.router.forward(h.spec, 1);
    assert.equal((await h.queue.dequeue()).status, 200);
    assert.match((await h.queue.dequeue()).data, /prefix/);
    const error = await h.queue.dequeue();
    assert.equal(error.status, 502);
    assert.equal(error.retryable, false);
    assert.match(error.message, /truncated/);
});

test("Playground timeouts report 504 and stale attempts cannot publish errors", async t => {
    const h = harness(t);
    h.handler.timeouts.FAKE_STREAM = 10;
    h.router.sessions.set(h.context, {
        request(_m, _b, { signal }) {
            return new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
            );
        },
    });
    h.router.forward(h.spec, 1);
    assert.equal((await h.queue.dequeue()).status, 504);
    const next = harness(t);
    let fail;
    next.router.sessions.set(next.context, {
        request() {
            return new Promise((_, reject) => {
                fail = reject;
            });
        },
    });
    next.router.forward(next.spec, 1);
    next.registry.messageQueues.get("req").requestAttemptId = "new-attempt";
    fail(new Error("stale"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(next.queue.messages.length, 0);
});

test("true streaming does not accumulate a second complete response", async t => {
    const h = harness(t, "real");
    const original = WireCodec.merge;
    let merges = 0;
    WireCodec.merge = (...args) => {
        merges++;
        return original(...args);
    };
    try {
        h.router.forward(h.spec, 1);
        await h.queue.dequeue();
        assert.match((await h.queue.dequeue()).data, /hello/);
        assert.equal((await h.queue.dequeue()).type, "STREAM_END");
        assert.equal(merges, 0);
    } finally {
        WireCodec.merge = original;
    }
});

test("cooling Playground accounts fail quickly without dispatch or extending cooldown", async t => {
    const h = harness(t);
    h.router.fail("gemini-4-argon", 1, 429);
    const until = h.router.cooldownUntil("gemini-4-argon", 1);
    h.router.forward(h.spec, 1);
    assert.equal((await h.queue.dequeue()).status, 503);
    assert.equal(h.calls(), 0);
    assert.equal(h.router.cooldownUntil("gemini-4-argon", 1), until);
});

test("first Playground permission failure can switch accounts, but committed streams cannot retry", async t => {
    for (const committed of [false, true]) {
        const h = harness(t, "real");
        h.router.sessions.set(h.context, {
            async request(_m, _b, { onData }) {
                if (committed) onData(response("prefix"));
                throw Object.assign(new Error("Playground HTTP 403: The caller does not have permission"), {
                    status: 403,
                });
            },
        });
        h.router.forward(h.spec, 1);
        if (committed) {
            await h.queue.dequeue();
            await h.queue.dequeue();
        }
        const error = await h.queue.dequeue();
        assert.equal(error.status, committed ? 403 : 503);
        if (committed) assert.equal(error.retryable, false);
        assert.ok(h.router.cooldownUntil("gemini-4-argon", 1) > Date.now());
        assert.equal(h.router.cooldownUntil("gemini-4-argon", 2), 0);
    }
});

test("non-generation endpoints are rejected by the Playground transport", async t => {
    for (const endpoint of ["countTokens", "batchEmbedContents"]) {
        const h = harness(t);
        h.router.forward({ ...h.spec, path: `/v1beta/models/gemini-4-argon:${endpoint}` }, 1);
        const error = await h.queue.dequeue();
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.equal(h.calls(), 0);
    }
});

test("the Playground catalog keeps configured models, adds discovered ones once and survives restart", t => {
    const h = harness(t);
    const raw = [
        [
            ["models/gemini-4-argon", null, "", "Argon", "", 1000, 100, ["generateContent"]],
            ["models/gemini-new", null, "", "New", "", 2000, 200, ["generateContent"]],
            ["models/embedding-only", null, "", "Embed", "", 1, 1, ["embedContent"]],
        ],
    ];
    h.router.catalog.discover(raw);
    h.router.catalog.discover(raw);
    const names = h.router.models().map(m => m.name);
    assert.deepEqual(names, ["models/gemini-4-argon", "models/gemini-new"]);
    assert.equal(h.router.models()[0].outputTokenLimit, 100);
    // Build's list is never touched by Playground discovery.
    assert.deepEqual(
        h.handler.config.modelList.map(m => m.name),
        ["models/gemini-3.8-flash", "models/gemini-4-argon"]
    );
    const restored = new PlaygroundTransport(h.handler);
    assert.deepEqual(
        restored.models().map(m => m.name),
        names
    );
    h.handler.config.playgroundEnabled = false;
    assert.deepEqual(restored.models(), []);
});

test("a catalog saved by the removed router is restored once", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-catalog-legacy-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    fs.writeFileSync(
        path.join(dir, "model-routes.json"),
        JSON.stringify({ accounts: {}, models: [{ name: "models/gemini-old" }], version: 2 })
    );
    const transport = new PlaygroundTransport({
        config: { playgroundCatalogPath: path.join(dir, "playground-models.json"), playgroundEnabled: true },
        logger,
    });
    assert.deepEqual(
        transport.models().map(m => m.name),
        ["models/gemini-old"]
    );
});
