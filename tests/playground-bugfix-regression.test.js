const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WireCodec } = require("../src/core/Playground/WireCodec");
const PlaygroundSession = require("../src/core/Playground/Session");
const PlaygroundTransport = require("../src/core/Playground/Transport");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const RPC =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = () => ({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] });
const chunk = (text, reason = 0) => JSON.stringify([[[[[[null, text]], "model"], reason]], null, [1, 1, 2]]);
const encode = request => WireCodec.encode("gemini-4-argon", request);

function harness(t, { mode = "fake", fakeStream = 1000, streamChunk, request = body() } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-playground-fix-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const registry = new ConnectionRegistry(logger);
    const context = {};
    const handler = {
        browserManager: { contexts: new Map([[1, { context }]]) },
        config: {
            modelList: [{ name: "models/gemini-4-argon" }],
            playgroundCatalogPath: path.join(dir, "playground-models.json"),
            playgroundEnabled: true,
        },
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: fakeStream, STREAM_CHUNK: streamChunk },
    };
    const router = new PlaygroundTransport(handler);
    const queue = registry.createMessageQueue("req", 1, "attempt1");
    const spec = {
        body: JSON.stringify(request),
        path: `/v1beta/models/gemini-4-argon:${mode === "real" ? "streamGenerateContent" : "generateContent"}`,
        request_attempt_id: "attempt1",
        request_id: "req",
        streaming_mode: mode,
    };
    return { context, queue, registry, router, spec };
}

async function drain(queue) {
    const messages = [];
    for (;;) {
        const message = await queue.dequeue(2000);
        messages.push(message);
        if (message.type === "STREAM_END" || message.event_type === "error") return messages;
    }
}

const waitForAbort = signal =>
    new Promise((_, reject) =>
        signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Playground request cancelled"), { retryable: false, status: 499 })),
            { once: true }
        )
    );

/** A browser page double: the UI submission is signed over textarea-normalized text. */
function fakeContext({ capture = true, firstEvaluate, chunks = [], template16 } = {}) {
    const state = { headers: null, payload: null };
    let routeHandler;
    let filled = "";
    const page = {
        async close() {
            this.closed = true;
        },
        closed: false,
        async evaluate(_fn, args) {
            if (args) {
                state.payload = args.payload;
                state.headers = args.headers;
                return firstEvaluate || { done: false, status: 200 };
            }
            const next = chunks.shift();
            return next === undefined
                ? { chunk: "", done: true, status: 200 }
                : { chunk: next, done: false, status: 200 };
        },
        getByRole(_role, { name }) {
            return {
                async click() {
                    if (!(name instanceof RegExp) || !capture) return;
                    const template = ["models/gemini-4-argon", [[[[null, filled]], "user"]], null, []];
                    template[3][4] = 1;
                    template[3][16] = template16;
                    await routeHandler({
                        abort: async () => {},
                        continue: async () => {},
                        fulfill: async () => {},
                        request: () => ({
                            allHeaders: async () => ({ cookie: "secret", "x-aistudio-g1-tier": "t" }),
                            postData: () => JSON.stringify(template),
                            url: () => RPC,
                        }),
                    });
                },
                async fill(text) {
                    // HTMLTextAreaElement.value normalizes CRLF and CR to LF.
                    filled = text.replace(/\r\n?/g, "\n");
                },
                async isVisible() {
                    return false;
                },
                async waitFor() {},
            };
        },
        async goto() {},
        isClosed() {
            return this.closed;
        },
        on() {},
        async route(_pattern, handlerFn) {
            routeHandler = handlerFn;
        },
        url: () => "https://aistudio.google.com/prompts/new_chat",
    };
    return { context: { newPage: async () => page }, page, state };
}

const runSession = (context, request, timeoutMs = 1000) => {
    const received = [];
    const promise = new PlaygroundSession(context, () => {}).request("gemini-4-argon", request, {
        onData: value => received.push(value),
        signal: new AbortController().signal,
        timeoutMs,
    });
    return { promise, received };
};

test("#1 a request timing out while queued behind the account's active request does not cool the account down", async t => {
    const h = harness(t, { fakeStream: 30 });
    const session = new PlaygroundSession(h.context, () => {});
    session.pending = new Promise(() => {}); // another request still owns this account's page
    h.router.sessions.set(h.context, session);
    h.router.forward(h.spec, 1);
    const error = (await drain(h.queue)).at(-1);
    assert.equal(error.event_type, "error");
    assert.equal(error.status, 503, "busy account must use the immediate account-switch path");
    assert.notEqual(error.retryable, false, "nothing was dispatched, so another account may retry");
    assert.match(error.message, /queued/);
    assert.equal(h.router.cooldownUntil("gemini-4-argon", 1), 0);
});

test("#1 a timeout after dispatch still reports 504 and cools the account down", async t => {
    const h = harness(t, { fakeStream: 30 });
    h.router.sessions.set(h.context, {
        request(_m, _b, { onStage, signal }) {
            onStage("queued");
            onStage("request_dispatched");
            return waitForAbort(signal);
        },
    });
    h.router.forward(h.spec, 1);
    const error = (await drain(h.queue)).at(-1);
    assert.equal(error.status, 504);
    assert.ok(h.router.cooldownUntil("gemini-4-argon", 1) > Date.now());
});

test("#2 an active real stream may outlive the total deadline while chunks keep arriving", async t => {
    const h = harness(t, { fakeStream: 60, mode: "real", streamChunk: 200 });
    h.router.sessions.set(h.context, {
        async request(_m, _b, { onData, signal }) {
            onData(`[[${chunk("a")}`);
            for (let i = 0; i < 12; i++) {
                await sleep(10);
                if (signal.aborted) throw new Error("aborted");
                onData(`,${chunk("b")}`);
            }
            onData(`,${chunk("end", 1)}]]`);
        },
    });
    h.router.forward(h.spec, 1);
    const messages = await drain(h.queue);
    assert.equal(messages.at(-1).type, "STREAM_END", JSON.stringify(messages.at(-1)));
    assert.equal(messages.filter(m => m.event_type === "chunk").length, 14);
});

test("#2 a real stream that stalls after starting times out by inactivity", async t => {
    const h = harness(t, { fakeStream: 5000, mode: "real", streamChunk: 40 });
    h.router.sessions.set(h.context, {
        request(_m, _b, { onData, signal }) {
            onData(`[[${chunk("a")}`);
            return waitForAbort(signal);
        },
    });
    const startedAt = Date.now();
    h.router.forward(h.spec, 1);
    const messages = await drain(h.queue);
    assert.equal(messages.at(-1).status, 504);
    assert.equal(messages.at(-1).retryable, false, "visible output must not be retried");
    assert.ok(Date.now() - startedAt < 2000);
});

test("#3 malformed contents are a non-retryable 400 that never cool the account down", async t => {
    for (const request of [
        { contents: [{ role: "user" }] },
        { contents: [null] },
        { contents: [{ parts: [null] }] },
        { contents: [{ parts: [{ text: "x" }] }], systemInstruction: { text: "be brief" } },
    ]) {
        assert.throws(
            () => encode(request),
            error => error.status === 400 && error.retryable === false && /^Playground:/.test(error.message)
        );
    }
    const h = harness(t, { request: { contents: [{ role: "user" }] } });
    h.router.sessions.set(h.context, new PlaygroundSession(h.context, () => {}));
    h.router.forward(h.spec, 1);
    const error = (await drain(h.queue)).at(-1);
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    assert.match(error.message, /contents\[0\]\.parts must be an array/);
    assert.equal(h.router.cooldownUntil("gemini-4-argon", 1), 0);
});

test("#4 a UI submission timeout before inference may be retried on another account", async () => {
    const { context } = fakeContext({ capture: false });
    const { promise } = runSession(context, body(), 20);
    await assert.rejects(promise, error => {
        assert.equal(error.status, 504);
        assert.notEqual(error.retryable, false);
        assert.match(error.message, /before inference started/);
        return true;
    });
});

test("#5 public safety categories unknown to MakerSuite are left at their defaults", () => {
    const wire = encode({
        ...body(),
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
        ],
    });
    assert.deepEqual(wire[2], [[null, null, 7, 4]]);
    for (const setting of [
        { category: "not a category", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "WRONG" },
    ])
        assert.throws(() => encode({ ...body(), safetySettings: [setting] }), /unsupported safety setting/);
});

test("#6 CRLF content signs successfully and is sent with the signed line breaks", async () => {
    const { context, state } = fakeContext({ chunks: [`[[${chunk("ok", 1)}]]`] });
    const request = { contents: [{ parts: [{ text: "line 1\r\nline 2\rline 3" }], role: "user" }] };
    const { promise, received } = runSession(context, request);
    await promise;
    assert.equal(state.payload[1][0][0][0][1], "line 1\nline 2\nline 3");
    assert.equal(state.headers.cookie, undefined);
    assert.match(received.join(""), /ok/);
});

test("#7 thoughts are only requested when includeThoughts is true", async () => {
    const thinking = config => encode({ ...body(), generationConfig: { thinkingConfig: config } })[3][16];
    assert.equal(thinking({ thinkingLevel: "high" })[0], 0);
    assert.equal(thinking({ thinkingBudget: 128 })[0], 0);
    assert.equal(thinking({ includeThoughts: false })[0], 0);
    assert.equal(thinking({ includeThoughts: true, thinkingLevel: "low" })[0], 1);
    assert.equal(thinking({ include_thoughts: true })[0], 1);

    // Without a thinking config, the UI template's "show thoughts" default must not leak through.
    const { context, state } = fakeContext({ chunks: [`[[${chunk("ok", 1)}]]`], template16: [1, 2048] });
    await runSession(context, body()).promise;
    assert.deepEqual(state.payload[3][16], [0, 2048]);
    assert.equal(state.payload[3][4], 1, "other native defaults are preserved");
});

test("#8 typeless schemas are inferred instead of being narrowed to strings", () => {
    const types = schema => (schema[17] ? schema[17].map(branch => branch[0]) : [schema[0]]);
    const head = schema => JSON.parse(JSON.stringify(schema.slice(0, 5)));
    const any = WireCodec.schema({ description: "anything" });
    assert.deepEqual(types(any).slice(0, 3), [1, 2, 4]);
    assert.equal(any[2], "anything");
    assert.ok(
        any[17].some(branch => branch[3] === true),
        "null is accepted"
    );

    assert.deepEqual(head(WireCodec.schema({ enum: [1, 2] })), [3, null, null, null, ["1", "2"]]);
    assert.equal(WireCodec.schema({ enum: [1, 2.5] })[0], 2);
    assert.deepEqual(head(WireCodec.schema({ enum: ["a", null] })), [1, null, null, true, ["a"]]);
    assert.deepEqual(types(WireCodec.schema({ enum: ["a", true] })), [1, 4]);
    assert.deepEqual(head(WireCodec.schema({ const: "fixed" })), [1, null, null, null, ["fixed"]]);
    assert.equal(WireCodec.schema({ minLength: 2 })[0], 1);
    assert.equal(WireCodec.schema({ maximum: 9 })[0], 2);
    assert.equal(WireCodec.schema({ required: ["a"] })[0], 6);
    assert.equal(WireCodec.schema({ maxItems: 2 })[0], 5);
    assert.equal(WireCodec.schema({ anyOf: [{ type: "string" }] })[0], undefined, "combinators keep their own types");

    const tool = encode({
        ...body(),
        tools: [
            { functionDeclarations: [{ name: "f", parametersJsonSchema: { properties: { v: {} }, type: "object" } }] },
        ],
    });
    assert.ok(tool[6][0][1][0][2][6][0][1][17], "an empty property schema becomes a scalar union");
});

test("snake_case generation fields are honoured like their camelCase forms", () => {
    const wire = encode({
        ...body(),
        generationConfig: {
            image_config: { aspect_ratio: "16:9", image_size: "2K" },
            media_resolution: "MEDIA_RESOLUTION_LOW",
            response_format: { text: { mime_type: "APPLICATION_JSON" } },
            response_modalities: ["text", "IMAGE"],
        },
    });
    assert.deepEqual(wire[3][14], [1, 2]);
    assert.deepEqual(wire[3][26], ["16:9", "2K"]);
    assert.equal(wire[3][17], 1);
    assert.equal(wire[3][7], "application/json");
    assert.throws(() => encode({ ...body(), generationConfig: { responseModalities: ["SMELL"] } }), /modality/);
});

test("a browser fetch network failure reports a 502 with its cause", async () => {
    const { context, page } = fakeContext({ firstEvaluate: { done: true, error: "NetworkError", status: 0 } });
    const { promise } = runSession(context, body());
    await assert.rejects(promise, error => error.status === 502 && /network failure: NetworkError/.test(error.message));
    assert.equal(page.closed, true);
});
