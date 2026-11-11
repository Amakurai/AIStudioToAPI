const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ModelChannel = require("../src/core/ModelChannel");
const FormatConverter = require("../src/core/FormatConverter");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const PlaygroundTransport = require("../src/core/Playground/Transport");
const { WireCodec } = require("../src/core/Playground/WireCodec");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const schema = { properties: { query: { type: "string" } }, required: ["query"], type: "object" };
const processors = {
    claude: "processClaudeRequest",
    gemini: "processRequest",
    openai: "processOpenAIRequest",
    responses: "processOpenAIResponseRequest",
};

class Response extends EventEmitter {
    constructor() {
        super();
        Object.assign(this, {
            headers: {},
            headersSent: false,
            output: "",
            socket: { destroyed: false, writable: true },
            statusCode: 200,
            writableEnded: false,
        });
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
    status(value) {
        this.statusCode = value;
        return this;
    }
    type(value) {
        return this.set("Content-Type", value);
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

function harness(t, { complete = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-preset-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const config = {
        fakeStreamTimeoutMs: 1000,
        maxRetries: 1,
        modelList: [{ name: "models/gemini-4-argon" }],
        playgroundCatalogPath: path.join(dir, "models.json"),
        playgroundEnabled: true,
        playgroundModelList: [{ name: "models/gemini-4-argon" }, { name: "models/gemini-3.8-flash-tts" }],
        playgroundSettingsPath: path.join(dir, "settings.json"),
        streamingMode: "fake",
        streamTimeoutMs: 1000,
        switchOnUses: 0,
    };
    const registry = new ConnectionRegistry(logger);
    const handler = new RequestHandler({ config }, registry, logger, { currentAuthIndex: 0 }, config, {});
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._getReadyAuthIndices = () => [0];
    handler._selectDispatchAuthIndex = () => 0;
    handler.playground.settings.values.googleSearch = true;
    const sent = [];
    let queue;
    handler.playground.forward = spec => {
        sent.push(spec);
        queue = registry.messageQueues.get(spec.request_id).queue;
        queue.enqueue({
            event_type: "response_headers",
            headers: { "content-type": spec.streaming_mode === "real" ? "text/event-stream" : "application/json" },
            status: 200,
        });
        const response = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                functionCall: { args: { query: "hi" }, id: "call1", name: "lookup" },
                                thoughtSignature: "signature",
                            },
                        ],
                        role: "model",
                    },
                    finishReason: "STOP",
                },
            ],
        };
        const json = JSON.stringify(response);
        queue.enqueue({ data: spec.streaming_mode === "real" ? `data: ${json}\n\n` : json, event_type: "chunk" });
        if (complete) queue.enqueue({ type: "STREAM_END" });
    };
    return { finish: () => queue.enqueue({ type: "STREAM_END" }), handler, sent };
}

function request(api, stream, model = "pg-gemini-4-argon-fake-预设") {
    const req = { headers: {}, method: "POST", query: { alt: "json" } };
    if (api === "gemini") {
        return {
            ...req,
            body: {
                contents: [{ parts: [{ text: "Hi" }], role: "user" }],
                stream,
                tools: [{ functionDeclarations: [{ name: "lookup", parameters: schema }] }],
            },
            path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        };
    }
    const body = { max_tokens: 100, messages: [{ content: "Hi", role: "user" }], model, stream };
    if (api === "responses")
        return {
            ...req,
            body: {
                input: "Hi",
                model,
                stream,
                tools: [{ name: "lookup", parameters: schema, type: "function" }],
            },
            path: "/v1/responses",
        };
    body.tools =
        api === "claude"
            ? [{ input_schema: schema, name: "lookup" }]
            : [{ function: { name: "lookup", parameters: schema }, type: "function" }];
    return { ...req, body, path: api === "claude" ? "/v1/messages" : "/v1/chat/completions" };
}

test("preset names only apply to Playground and decode native URL model names", () => {
    for (const name of [
        "pg-gemini-4-argon-预设",
        "models/pg-gemini-4-argon-预设",
        "pg-gemini-4-argon-%E9%A2%84%E8%AE%BE",
    ])
        assert.equal(ModelChannel.playgroundPreset(name), "gemini-4-argon");
    for (const name of ["gemini-4-argon-预设", "build-gemini-4-argon-预设", "pg-gemini-4-argon", "pg--预设"])
        assert.equal(ModelChannel.playgroundPreset(name), null);
    const converter = new FormatConverter(logger, { config: {} });
    for (const name of [
        "pg-gemini-4-argon-预设",
        "pg-gemini-4-argon-fake-预设",
        "pg-gemini-4-argon-抗截断-fake-预设",
    ]) {
        const parsed = converter.parseModelSuffixes(name);
        assert.equal(parsed.cleanModelName, "pg-gemini-4-argon");
        assert.equal(parsed.streamingMode, "real");
        assert.equal(FormatConverter.stripModelSuffixes(name), "pg-gemini-4-argon");
    }
    const parsed = converter.parseModelSuffixes("pg-gemini-4-argon-high-fake-search-code-预设");
    assert.equal(parsed.cleanModelName, "pg-gemini-4-argon");
    assert.equal(parsed.thinkingLevel, "HIGH");
    assert.equal(parsed.forceWebSearch, true);
    assert.equal(parsed.forceCodeExecution, true);
    assert.equal(parsed.streamingMode, "real");
});

for (const [api, processor] of Object.entries(processors)) {
    test(`${api} preset respects client response format and uses real streaming when requested`, async t => {
        for (const stream of [undefined, false, "false", true])
            await t.test(String(stream), async t => {
                const { handler, sent } = harness(t);
                const req = request(api, stream);
                if (api === "gemini" && stream === true)
                    req.path = req.path.replace(":generateContent", ":streamGenerateContent");
                const streaming = stream === true;
                const originalTools = req.body.tools;
                const res = new Response();
                assert.equal(handler._unsupportedPlaygroundRequest(req), null);
                const scope = handler.forRequest(req);
                assert.equal(scope.playgroundModel, "gemini-4-argon");
                await scope[processor](req, res);
                assert.equal(res.statusCode, 200, res.output);
                if (streaming) assert.match(res.get("content-type"), /text\/event-stream/);
                else {
                    const response = JSON.parse(res.output);
                    const call =
                        api === "openai"
                            ? response.choices[0].message.tool_calls[0]
                            : api === "responses"
                              ? response.output.find(item => item.type === "function_call")
                              : api === "claude"
                                ? response.content.find(item => item.type === "tool_use")
                                : response.candidates[0].content.parts.find(part => part.functionCall)?.functionCall;
                    assert.equal(call.function?.name || call.name, "lookup");
                }
                assert.match(res.output, /lookup/);
                assert.equal(sent.length, 1);
                assert.equal(sent[0].channel, "playground");
                assert.equal(
                    sent[0].path,
                    `/v1beta/models/gemini-4-argon:${streaming ? "streamGenerateContent" : "generateContent"}`
                );
                assert.equal(sent[0].streaming_mode, streaming ? "real" : "fake");
                const body = JSON.parse(sent[0].body);
                assert.equal(body.tools[0].functionDeclarations[0].name, "lookup");
                assert.equal(body.toolConfig.includeServerSideToolInvocations, true);
                assert.equal(WireCodec.encode("gemini-4-argon", body)[13][2], true);
                assert.equal(req.body.tools, originalTools, "client tool definitions are preserved");
                assert.equal(handler.config.streamingMode, "fake", "the preset does not change other requests");
            });
    });
}

test("preset tool replies wait for upstream completion across all public APIs", async t => {
    for (const [api, processor] of Object.entries(processors))
        await t.test(api, async t => {
            const { handler } = harness(t);
            const context = {};
            handler.browserManager.contexts = new Map([[0, { context }]]);
            handler.playground.forward = PlaygroundTransport.prototype.forward.bind(handler.playground);
            let release;
            const pending = new Promise(resolve => {
                release = resolve;
            });
            let received;
            const receivedChunks = new Promise(resolve => {
                received = resolve;
            });
            handler.playground.sessions.set(context, {
                async request(_model, _body, { onData }) {
                    const chunk = (parts, reason) => [[[[parts, "model"], reason]], null, [1, 1, 2]];
                    const call = [];
                    call[3] = ["lookup", WireCodec.struct({ query: "hi" }), "call1"];
                    // The upstream emits text before the call. Neither may be delivered early.
                    onData(JSON.stringify([[chunk([[null, "I will use lookup."]], 0), chunk([call], 1)]]));
                    received();
                    await pending;
                },
            });
            const req = request(api, true);
            if (api === "gemini") req.path = req.path.replace(":generateContent", ":streamGenerateContent");
            const res = new Response();
            const task = handler.forRequest(req)[processor](req, res);
            try {
                await receivedChunks;
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(res.headersSent, false);
                assert.equal(res.output, "");
                assert.equal(res.writableEnded, false);
            } finally {
                release();
                await task;
            }
            assert.equal(res.statusCode, 200, res.output);
            assert.match(res.output, /lookup/);
            assert.match(res.output, /hi/);
            assert.equal(res.writableEnded, true);
        });
});

test("preset requests preserve tool results in the next conversation round", async t => {
    for (const [api, processor] of Object.entries(processors))
        await t.test(api, async t => {
            const { handler, sent } = harness(t);
            const req = request(api, false);
            if (api === "gemini")
                req.body.contents.push(
                    {
                        parts: [{ functionCall: { args: { query: "hi" }, id: "call1", name: "lookup" } }],
                        role: "model",
                    },
                    {
                        parts: [{ functionResponse: { id: "call1", name: "lookup", response: { result: "found" } } }],
                        role: "user",
                    }
                );
            else if (api === "responses")
                req.body.input = [
                    { content: "Hi", role: "user" },
                    { arguments: '{"query":"hi"}', call_id: "call1", name: "lookup", type: "function_call" },
                    { call_id: "call1", output: '{"result":"found"}', type: "function_call_output" },
                ];
            else if (api === "claude")
                req.body.messages.push(
                    {
                        content: [{ id: "call1", input: { query: "hi" }, name: "lookup", type: "tool_use" }],
                        role: "assistant",
                    },
                    {
                        content: [{ content: '{"result":"found"}', tool_use_id: "call1", type: "tool_result" }],
                        role: "user",
                    }
                );
            else
                req.body.messages.push(
                    {
                        content: null,
                        role: "assistant",
                        tool_calls: [
                            {
                                function: { arguments: '{"query":"hi"}', name: "lookup" },
                                id: "call1",
                                type: "function",
                            },
                        ],
                    },
                    { content: '{"result":"found"}', role: "tool", tool_call_id: "call1" }
                );
            const res = new Response();
            await handler.forRequest(req)[processor](req, res);
            assert.equal(res.statusCode, 200, res.output);
            const parts = JSON.parse(sent[0].body).contents.flatMap(content => content.parts);
            assert.ok(parts.some(part => part.functionCall?.name === "lookup"));
            assert.ok(parts.some(part => part.functionResponse?.name === "lookup"));
            assert.equal(sent[0].streaming_mode, "fake");
        });
});

test("invalid upstream tool endings are errors before any partial reply reaches a client", async t => {
    for (const reason of [10, 12, 13])
        for (const [api, processor] of Object.entries(processors))
            for (const stream of [false, true])
                await t.test(`${reason}/${api}/${stream}`, async t => {
                    const { handler } = harness(t);
                    const context = {};
                    handler.browserManager.contexts = new Map([[0, { context }]]);
                    handler.playground.forward = PlaygroundTransport.prototype.forward.bind(handler.playground);
                    handler.playground.sessions.set(context, {
                        async request(_model, _body, { onData }) {
                            onData(JSON.stringify([[[[[[[[null, "unfinished answer"]], "model"], reason]]]]]));
                        },
                    });
                    const req = request(api, stream);
                    if (api === "gemini" && stream)
                        req.path = req.path.replace(":generateContent", ":streamGenerateContent");
                    const res = new Response();
                    await handler.forRequest(req)[processor](req, res);
                    assert.equal(res.statusCode, 502, res.output);
                    assert.match(res.output, /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS/);
                    assert.doesNotMatch(res.output, /unfinished answer/);
                    assert.equal(handler.playground.cooldowns.size, 0, "model output errors do not cool accounts");
                });
});

test("preset models are listed only on Playground and do not advertise TTS", t => {
    const { handler } = harness(t);
    const models = handler.channelModels();
    assert.ok(models.playground.some(model => model.name === "models/pg-gemini-4-argon-预设"));
    assert.ok(!models.playground.some(model => model.name.endsWith("tts-预设")));
    assert.ok(!models.build.some(model => model.name.endsWith("-预设")));
    assert.match(
        handler._unsupportedPlaygroundRequest(request("openai", false, "pg-gemini-3.8-flash-tts-预设")),
        /chat model/
    );
    const ordinary = request("openai", false, "pg-gemini-4-argon");
    handler.forRequest(ordinary);
    assert.equal(ordinary.body.stream, false);
    assert.equal(ordinary.playgroundPreset, undefined);
});
