const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ModelChannel = require("../src/core/ModelChannel");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const BuildChatTransport = require("../src/core/BuildChat/Transport");
const { BuildChatCodec, BuildChatResponse } = require("../src/core/BuildChat/Codec");
const { WireStream } = require("../src/core/Playground/WireCodec");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const APPLET = "d117fcc2-70d2-4538-80cb-ad773d33d2b0";
const MODELS = [{ name: "models/gemini-4-argon" }, { name: "models/gemini-3.8-flash" }];

/** One StreamCodeAssistantOfflineGeneration update (a snapshot of one run step), shaped like captured traffic. */
function update(role, parts, { done = true, step = role === "model" ? 1 : 0, tokens = null, tool = null } = {}) {
    const turn = [
        role ? [[parts, role]] : null,
        null,
        null,
        null,
        null,
        null,
        ["1792505082", 498486098],
        done ? ["1792505141", 670331637] : null,
        null,
        tool,
        [APPLET, ["1792505082", 498486098]],
        step,
        done ? 1 : 2,
        "models/gemini-4-argon",
        null,
        tokens,
        "249dba1a-cbf5-4511-9ce6-f0c922baf459",
    ];
    return [null, null, [turn], "57917838-9297-405e-8485-7056b5fcac10"];
}

const thought = [null, "**Planning**\n\nShort answer."];
thought[12] = 1;
const STREAM = JSON.stringify([
    [
        update("user", [[null, "Tell me a story"]]),
        update("user", [[null, "Tell me a story"]]),
        update("model", [thought, [null, "Once upon"]], { done: false }),
        update("model", [thought, [null, "Once upon a time, "]], { done: false }),
        update("model", [thought, [null, "Once upon a time, a keeper lit the lamp."]], {
            tokens: ["2054", "1262", "16592"],
        }),
    ],
]);

/** An agent run: thinking, a file read, more thinking, the answer, then the files snapshot. */
const AGENT_RUN = JSON.stringify([
    [
        update("user", [[null, "Write four lines about the sea"]]),
        update("user", [[null, "Write four lines about the sea"]]),
        update("model", [thought], { done: false }),
        update("model", [thought], { tokens: ["18736", "280"] }),
        update(null, null, { done: false, step: 6, tool: [null, ["index.html"]] }),
        update(null, null, { step: 6, tool: [null, ["index.html", "<content>"]] }),
        update("model", [thought], { step: 10, tokens: ["3089", "424", "35236"] }),
        update("model", [[null, "Here are four lines:"]], { done: false, step: 44 }),
        update("model", [[null, "Here are four lines:\nEndless blue."]], {
            step: 44,
            tokens: ["2226", "308", "54428"],
        }),
        update(null, null, { step: 45, tool: ["model", "Snapshot"] }),
    ],
]);

/** A fake session that reads the same trajectory each time the transport asks for another read. */
const replaying = (stream, seen = []) => ({
    reads: 0,
    async request(model, encoded, { onData, onPassEnd }) {
        seen.push({ model, signText: encoded.signText });
        do {
            this.reads++;
            for (let i = 0; i < stream.length; i += 100) await onData(stream.slice(i, i + 100));
        } while (await onPassEnd());
    },
});

function parse(text, response, pieces = 7) {
    const chunks = [];
    const parser = new WireStream(raw => {
        const chunk = response.update(raw);
        if (chunk) chunks.push(chunk);
    });
    const size = Math.ceil(text.length / pieces);
    for (let i = 0; i < text.length; i += size) parser.feed(text.slice(i, i + size));
    parser.finish();
    return chunks;
}

test("bdc- names the Build Chat channel", () => {
    assert.deepEqual(ModelChannel.parse("bdc-gemini-4-argon"), {
        channel: "buildchat",
        model: "gemini-4-argon",
        prefixed: true,
    });
    assert.deepEqual(ModelChannel.parse("models/bdc-gemini-3.8-flash"), {
        channel: "buildchat",
        model: "gemini-3.8-flash",
        prefixed: true,
    });
    assert.equal(ModelChannel.publicName("buildchat", "models/gemini-4-argon"), "bdc-gemini-4-argon");
    assert.equal(ModelChannel.parse("build-gemini-4-argon").channel, "build");
});

test("encode keeps text turns, folds the system instruction in and signs the joined text", () => {
    const encoded = BuildChatCodec.encode({
        contents: [
            { parts: [{ text: "  My name is Alice." }], role: "user" },
            { parts: [{ text: "thinking", thought: true }, { text: "Hi Alice." }], role: "model" },
            { parts: [{ text: "What is my name?\r\nOne word.\n\n" }], role: "user" },
        ],
        generationConfig: { temperature: 0.2, thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
        systemInstruction: { parts: [{ text: "Be brief." }] },
        tools: [{ googleSearch: {} }],
    });
    assert.deepEqual(encoded.contents, [
        [
            [
                [null, "Be brief."],
                [null, "  My name is Alice."],
            ],
            "user",
        ],
        [[[null, "Hi Alice."]], "model"],
        [[[null, "What is my name?\nOne word."]], "user"],
    ]);
    assert.equal(encoded.signText, "Be brief.   My name is Alice. Hi Alice. What is my name?\nOne word.");
    assert.equal(encoded.includeThoughts, true);
    assert.equal(encoded.thinkingLevel, 1);
    // A system instruction before a leading model turn becomes its own user turn.
    const leadingModel = BuildChatCodec.encode({
        contents: [{ parts: [{ text: "Hello" }], role: "model" }],
        systemInstruction: { parts: [{ text: "Rules" }] },
    });
    assert.deepEqual(leadingModel.contents[0], [[[null, "Rules"]], "user"]);
});

test("encode rejects what the Build assistant cannot carry", () => {
    const reject = (body, pattern) =>
        assert.throws(
            () => BuildChatCodec.encode(body),
            error => error.status === 400 && error.retryable === false && pattern.test(error.message)
        );
    reject({ contents: [] }, /contents must not be empty/);
    reject({ contents: [{ parts: [{ inlineData: { data: "x", mimeType: "image/png" } }] }] }, /only text parts/);
    reject({ contents: [{ parts: [{ functionCall: { args: {}, name: "f" } }], role: "model" }] }, /only text/);
    reject({ contents: [{ parts: [{ text: "x" }], role: "function" }] }, /unsupported role/);
    reject(
        { contents: [{ parts: [{ text: "x" }] }], tools: [{ functionDeclarations: [{ name: "f" }] }] },
        /function tools are not supported/
    );
    reject({ cachedContent: "cachedContents/1", contents: [{ parts: [{ text: "x" }] }] }, /cachedContent/);
    reject({ contents: [{ parts: [{ text: "   " }] }] }, /no text/);
});

test("the signed envelope is replayed with this request's contents, model and applet in a new conversation", () => {
    const template = [
        [[[[null, "signed text"]], "user"]],
        "!botguard",
        null,
        null,
        null,
        1,
        null,
        "models/gemini-4-argon",
        null,
        null,
        null,
        null,
        null,
        [2, null, 2],
        null,
        1,
        null,
        null,
        [1, null, null, 3],
    ];
    const contents = [[[[null, "Hi"]], "user"]];
    const body = BuildChatCodec.request(template, {
        appletId: APPLET,
        contents,
        model: "gemini-3.8-flash",
        thinkingLevel: 1,
    });
    assert.deepEqual(body[0], contents);
    assert.equal(body[1], "!botguard");
    assert.equal(body[7], "models/gemini-3.8-flash");
    assert.equal(body[11], APPLET);
    assert.equal(body[22], 1);
    assert.deepEqual(body[18], [1, null, null, 1]);
    assert.deepEqual(template[18], [1, null, null, 3], "the captured template is not modified");
    assert.deepEqual(
        BuildChatCodec.request(template, {
            appletId: APPLET,
            contents,
            model: "gemini-4-argon",
            thinkingLevel: null,
        })[18],
        [1, null, null, 3]
    );
});

test("RPC errors inside JSPB bodies map to HTTP statuses", () => {
    assert.deepEqual(BuildChatCodec.rpcError('[,[5,"Requested entity was not found."]]'), {
        message: "Requested entity was not found.",
        status: 404,
    });
    assert.deepEqual(BuildChatCodec.rpcError('[7,"The caller does not have permission"]'), {
        message: "The caller does not have permission",
        status: 403,
    });
    assert.equal(BuildChatCodec.rpcError('["249dba1a-cbf5-4511-9ce6-f0c922baf459","d117"]'), null);
    assert.equal(BuildChatCodec.rpcError('[,[8,"Quota \\"x\\" exceeded"]]').message, 'Quota "x" exceeded');
    assert.equal(BuildChatCodec.rpcError('[,[3,"bad"]]').status, 400);
    assert.equal(BuildChatCodec.rpcError("[[]]"), null);
});

test("cumulative snapshots become text deltas, a final response and usage", () => {
    const response = new BuildChatResponse("gemini-4-argon");
    const chunks = parse(STREAM, response);
    const text = chunks.flatMap(chunk => chunk.candidates[0].content.parts.map(part => part.text)).join("");
    assert.equal(text, "Once upon a time, a keeper lit the lamp.");
    assert.ok(chunks.every(chunk => chunk.candidates[0].content.parts.every(part => !part.thought)));
    assert.equal(response.complete, true);
    const last = response.finish();
    assert.equal(last.candidates[0].finishReason, "STOP");
    assert.deepEqual(last.usageMetadata, {
        cachedContentTokenCount: 16592,
        candidatesTokenCount: 1262,
        promptTokenCount: 18646,
        totalTokenCount: 19908,
    });
    assert.deepEqual(response.final().candidates[0].content.parts, [
        { text: "Once upon a time, a keeper lit the lamp." },
    ]);

    const withThoughts = new BuildChatResponse("gemini-4-argon", { includeThoughts: true });
    const thoughtChunks = parse(STREAM, withThoughts, 3);
    assert.equal(thoughtChunks[0].candidates[0].content.parts[0].thought, true);
    assert.equal(withThoughts.final().candidates[0].content.parts.length, 2);
});

test("a stream without a finished model turn is not complete", () => {
    const response = new BuildChatResponse("gemini-4-argon");
    parse(
        JSON.stringify([[update("user", [[null, "Hi"]]), update("model", [[null, "Hel"]], { done: false })]]),
        response
    );
    assert.equal(response.complete, false);
    // A later read can batch several steps into one update; every step counts.
    const batched = new BuildChatResponse("gemini-3.1-flash-lite");
    const [userStep] = update("user", [[null, "Capital of Egypt?"]])[2];
    const [modelStep] = update("model", [[null, "Cairo"]], { tokens: ["18737", "55"] })[2];
    const chunks = parse(JSON.stringify([[[null, null, [userStep, modelStep], "conversation"]]]), batched);
    assert.equal(batched.complete, true);
    assert.equal(chunks[0].candidates[0].content.parts[0].text, "Cairo");
    // A superseded step left running does not hold back a run whose latest step finished.
    const superseded = new BuildChatResponse("gemini-3-flash-preview");
    parse(
        JSON.stringify([
            [
                update("user", [[null, "Hi"]]),
                update("model", [thought], { done: false, step: 2 }),
                update("model", [[null, "Hello"]], { step: 7 }),
            ],
        ]),
        superseded
    );
    assert.equal(superseded.complete, true);
    // A run that only echoed the user turn before the read closed is not complete either.
    const echoed = new BuildChatResponse("gemini-4-argon");
    parse(JSON.stringify([[update("user", [[null, "Hi"]]), update("user", [[null, "Hi"]])]]), echoed);
    assert.equal(echoed.complete, false);
});

test("an agent run returns its model text only, sums usage over model calls and skips tool steps", () => {
    const response = new BuildChatResponse("gemini-3.8-flash");
    const chunks = parse(AGENT_RUN, response, 5);
    assert.equal(response.complete, true);
    assert.equal(
        chunks.map(chunk => chunk.candidates[0].content.parts.map(part => part.text).join("")).join(""),
        "Here are four lines:\nEndless blue."
    );
    assert.deepEqual(response.final().candidates[0].content.parts, [{ text: "Here are four lines:\nEndless blue." }]);
    assert.deepEqual(response.usage, {
        cachedContentTokenCount: 89664,
        candidatesTokenCount: 1012,
        promptTokenCount: 113715,
        totalTokenCount: 114727,
    });
    assert.match(response.summary(), /steps=\[0,1m,6,10m,44m,45\]/);
    const withThoughts = new BuildChatResponse("gemini-3.8-flash", { includeThoughts: true });
    parse(AGENT_RUN, withThoughts);
    const [thoughts, text] = withThoughts.final().candidates[0].content.parts;
    assert.equal(thoughts.thought, true);
    assert.equal(thoughts.text, "**Planning**\n\nShort answer.\n\n**Planning**\n\nShort answer.");
    assert.equal(text.text, "Here are four lines:\nEndless blue.");
});

function transportHarness(t, session, extraConfig = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-buildchat-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const registry = new ConnectionRegistry(logger);
    const context = {};
    const transport = new BuildChatTransport({
        authSource: { accountNameMap: new Map([[0, "Alice@Example.com"]]) },
        browserManager: { contexts: new Map([[0, { context }]]) },
        config: {
            buildChatAppletsPath: path.join(dir, "applets.json"),
            buildChatEnabled: true,
            buildChatModelList: MODELS,
            ...extraConfig,
        },
        connectionRegistry: registry,
        logger,
        timeouts: { FAKE_STREAM: 5000, STREAM_CHUNK: 5000 },
    });
    transport.sessions.set(context, session);
    /** Events up to the end of the response or its error. */
    const run = async spec => {
        const queue = registry.createMessageQueue("req", 0, "a1");
        transport.forward({ request_attempt_id: "a1", request_id: "req", ...spec }, 0);
        const events = [];
        for (;;) {
            const event = await queue.dequeue(1000);
            events.push(event);
            if (event.type === "STREAM_END" || event.event_type === "error") return events;
        }
    };
    return { dir, run, transport };
}

const request = (stream = false) => ({
    body: JSON.stringify({ contents: [{ parts: [{ text: "Tell me a story" }], role: "user" }] }),
    path: `/v1beta/models/gemini-4-argon:${stream ? "streamGenerateContent" : "generateContent"}`,
    streaming_mode: stream ? "real" : "fake",
});

test("the transport returns the final snapshot, or streams deltas", async t => {
    const seen = [];
    const session = replaying(STREAM, seen);
    const h = transportHarness(t, session);
    const [headers, body, end] = await h.run(request());
    assert.equal(headers.event_type, "response_headers");
    assert.equal(headers.headers["x-aistudio-channel"], "buildchat");
    const json = JSON.parse(body.data);
    assert.equal(json.candidates[0].content.parts[0].text, "Once upon a time, a keeper lit the lamp.");
    assert.equal(json.usageMetadata.candidatesTokenCount, 1262);
    assert.equal(end.type, "STREAM_END");
    assert.equal(session.reads, 2, "a second read confirms the run is over");
    assert.deepEqual(seen[0], { model: "gemini-4-argon", signText: "Tell me a story" });

    const events = await h.run(request(true));
    assert.equal(events[0].headers["content-type"], "text/event-stream");
    const sse = events.slice(1, -1).map(event => JSON.parse(event.data.replace(/^data: /, "")));
    assert.equal(
        sse.map(c => c.candidates[0].content.parts.map(p => p.text).join("")).join(""),
        "Once upon a time, a keeper lit the lamp."
    );
    assert.equal(sse.at(-1).candidates[0].finishReason, "STOP");
    assert.equal(sse.at(-1).usageMetadata.candidatesTokenCount, 1262);
    assert.equal(sse.length, 4, "one chunk per grown snapshot (thoughts omitted), then the finish");
    assert.equal(events.at(-1).type, "STREAM_END");
});

test("temporary applets that could not be deleted are kept per account for its next request", async t => {
    const seen = [];
    const session = {
        async request(model, encoded, { leftovers, onData, onPassEnd }) {
            seen.push(leftovers.list());
            // This request deletes what an earlier one left; its own applet cannot be deleted.
            for (const id of leftovers.list()) leftovers.remove(id);
            leftovers.add(APPLET);
            do await onData(STREAM);
            while (await onPassEnd());
        },
    };
    const h = transportHarness(t, session);
    await h.run(request());
    await h.run(request());
    assert.deepEqual(seen, [[], [APPLET]]);
    const file = path.join(h.dir, "applets.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
        leftovers: { "alice@example.com": [APPLET] },
        version: 2,
    });
    // A restart loads them, and only for the account that left them.
    const restarted = new BuildChatTransport({
        authSource: { accountNameMap: new Map() },
        browserManager: { contexts: new Map() },
        config: { buildChatAppletsPath: file, buildChatEnabled: true },
        connectionRegistry: new ConnectionRegistry(logger),
        logger,
        timeouts: { FAKE_STREAM: 5000 },
    });
    assert.deepEqual(restarted.leftovers.forAccount("alice@example.com").list(), [APPLET]);
    assert.deepEqual(restarted.leftovers.forAccount("bob@example.com").list(), []);
});

test("a read that closes before the run ends is read again until the answer arrives", async t => {
    const early = JSON.stringify([
        [update("user", [[null, "Tell me a story"]]), update("user", [[null, "Tell me a story"]])],
    ]);
    const reads = [early, STREAM, STREAM];
    const session = {
        async request(model, encoded, { onData, onPassEnd }) {
            do await onData(reads.shift());
            while (await onPassEnd());
        },
    };
    const h = transportHarness(t, session);
    const [, body] = await h.run(request());
    assert.equal(JSON.parse(body.data).candidates[0].content.parts[0].text, "Once upon a time, a keeper lit the lamp.");
    assert.equal(reads.length, 0);
});

test("upstream failures become errors, cool the account down and never fake a finish", async t => {
    for (const [stream, pattern, status] of [
        ['[,[8,"Resource has been exhausted"]]', /exhausted/, 429],
        [JSON.stringify([[update("model", [[null, "Hel"]], { done: false })]]), /without a finished answer/, 502],
    ]) {
        const h = transportHarness(t, replaying(stream));
        const [error] = await h.run(request());
        assert.equal(error.event_type, "error");
        assert.equal(error.status, status);
        assert.match(error.message, pattern);
        assert.equal(h.transport.isCoolingDown("gemini-4-argon", 0), true);
    }
    const h = transportHarness(t, {
        async request() {
            throw Object.assign(new Error("Build Chat HTTP 403: The caller does not have permission"), { status: 403 });
        },
    });
    const [error] = await h.run(request());
    // An account without permission lets the bounded account switch try another one.
    assert.equal(error.status, 503);
    assert.equal(h.transport.isCoolingDown("gemini-4-argon", 0), true);
    // A page automation failure while signing is retried elsewhere without cooling the account.
    const page = transportHarness(t, {
        async request(model, encoded, { onStage }) {
            onStage("submit_prompt");
            throw new Error("locator.click: Timeout 30000ms exceeded.");
        },
    });
    const [pageError] = await page.run(request());
    assert.equal(pageError.status, 503);
    assert.equal(page.transport.isCoolingDown("gemini-4-argon", 0), false);
});

test("the transport rejects bad requests without touching the page", async t => {
    let calls = 0;
    const session = {
        async request() {
            calls++;
        },
    };
    let h = transportHarness(t, session);
    let [error] = await h.run({ ...request(), path: "/v1beta/models/gemini-4-argon-抗截断:generateContent" });
    assert.match(error.message, /anti-truncation/);
    [error] = await h.run({ ...request(), body: JSON.stringify({ contents: [{ parts: [{ inlineData: {} }] }] }) });
    assert.equal(error.status, 400);
    assert.match(error.message, /only text parts/);
    h = transportHarness(t, session, { buildChatEnabled: false });
    [error] = await h.run(request());
    assert.match(error.message, /disabled/);
    assert.equal(calls, 0);
    assert.deepEqual(h.transport.models(), []);
});

function routeHarness(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-buildchat-route-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const registry = new ConnectionRegistry(logger);
    const config = {
        buildChatAppletsPath: path.join(dir, "applets.json"),
        buildChatEnabled: true,
        buildChatModelList: MODELS,
        fakeStreamTimeoutMs: 1000,
        immediateSwitchStatusCodes: [429],
        maxRetries: 1,
        modelList: [{ name: "models/gemini-4-argon" }],
        playgroundCatalogPath: path.join(dir, "playground-models.json"),
        playgroundEnabled: true,
        playgroundModelList: [],
        retryDelay: 1,
        streamingMode: "fake",
        switchOnUses: 0,
    };
    const handler = new RequestHandler({ config }, registry, logger, { currentAuthIndex: 0 }, config, {});
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._selectDispatchAuthIndex = () => 0;
    const forwarded = { build: [], buildchat: [] };
    registry.connectionsByAuth.set(0, {
        send(data) {
            const spec = JSON.parse(data);
            if (spec.event_type !== "cancel_request") forwarded.build.push(spec);
        },
    });
    handler.buildChat.forward = spec => {
        forwarded.buildchat.push({ ...spec, queueChannel: registry.messageQueues.get(spec.request_id).channel });
        const { queue } = registry.messageQueues.get(spec.request_id);
        queue.enqueue({ event_type: "response_headers", status: 200 });
        queue.enqueue({
            data: JSON.stringify({
                candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
            }),
            event_type: "chunk",
        });
        queue.enqueue({ type: "STREAM_END" });
    };
    return { forwarded, handler };
}

test("every public API sends bdc-* to Build Chat with the prefix removed and leaves Build state alone", async t => {
    const { EventEmitter } = require("node:events");
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
    const common = { headers: {}, method: "POST", query: {} };
    const requests = {
        claude: {
            ...common,
            body: { max_tokens: 100, messages: [{ content: "Hi", role: "user" }], model: "bdc-gemini-4-argon" },
            path: "/v1/messages",
        },
        gemini: {
            ...common,
            body: { contents: [{ parts: [{ text: "Hi" }], role: "user" }] },
            path: "/v1beta/models/bdc-gemini-4-argon:generateContent",
        },
        openai: {
            ...common,
            body: { messages: [{ content: "Hi", role: "user" }], model: "bdc-gemini-4-argon" },
            path: "/v1/chat/completions",
        },
        responses: { ...common, body: { input: "Hi", model: "bdc-gemini-4-argon" }, path: "/v1/responses" },
    };
    const processors = {
        claude: "processClaudeRequest",
        gemini: "processRequest",
        openai: "processOpenAIRequest",
        responses: "processOpenAIResponseRequest",
    };
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            const h = routeHarness(t);
            const usage = h.handler.authSwitcher.usageCount;
            const res = new FakeResponse();
            const req = requests[api];
            await h.handler.forRequest(req)[method](req, res);
            assert.equal(res.statusCode, 200, res.output);
            assert.equal(h.forwarded.build.length, 0);
            assert.equal(h.forwarded.buildchat.length, 1);
            assert.equal(h.forwarded.buildchat[0].path, "/v1beta/models/gemini-4-argon:generateContent");
            assert.equal(h.forwarded.buildchat[0].channel, "buildchat");
            assert.equal(h.forwarded.buildchat[0].queueChannel, "buildchat");
            assert.equal(h.handler.authSwitcher.usageCount, usage, "Build rotation is not counted");
        });
    }
});

test("bdc-* requests other than text generation are rejected up front and models are listed", t => {
    const h = routeHarness(t);
    const reason = (method, reqPath, body = {}) =>
        h.handler._unsupportedPlaygroundRequest({ body, method, path: reqPath });
    assert.equal(reason("POST", "/v1/chat/completions", { model: "bdc-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1/messages", { model: "bdc-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1/responses", { model: "bdc-gemini-4-argon" }), null);
    assert.equal(reason("POST", "/v1beta/models/bdc-gemini-4-argon:streamGenerateContent"), null);
    assert.match(reason("POST", "/v1beta/models/bdc-gemini-4-argon:countTokens"), /only support text generation/);
    assert.match(reason("POST", "/v1/embeddings", { model: "bdc-gemini-4-argon" }), /only support/);
    assert.match(reason("POST", "/v1/audio/speech", { model: "bdc-gemini-4-argon" }), /only support/);
    assert.match(reason("POST", "/v1/chat/completions", { model: "bdc-gemini-4-argon-抗截断" }), /anti-truncation/);
    assert.match(
        reason("POST", `/v1beta/models/bdc-gemini-4-argon${encodeURIComponent("-抗截断")}:generateContent`),
        /anti-truncation/
    );
    assert.deepEqual(
        h.handler.channelModels().buildchat.map(model => model.name),
        ["models/bdc-gemini-4-argon", "models/bdc-gemini-3.8-flash"]
    );
    h.handler.config.buildChatEnabled = false;
    assert.match(reason("POST", "/v1/chat/completions", { model: "bdc-gemini-4-argon" }), /disabled/);
    assert.deepEqual(h.handler.channelModels().buildchat, []);
});

test("a bdc- anti-truncation path never starts the duplex transport", () => {
    const handler = Object.create(RequestHandler.prototype);
    const spec = {
        is_generative: true,
        path: `/v1beta/models/bdc-gemini-4-argon${encodeURIComponent("-抗截断")}:generateContent`,
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(spec);
    assert.equal(spec.channel, "buildchat");
    assert.equal(spec.anti_truncation, undefined);
});
