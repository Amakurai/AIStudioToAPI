const test = require("node:test");
const assert = require("node:assert/strict");
const AntiTruncation = require("../src/core/AntiTruncation");
const Output = require("../src/core/DuplexToolTransport");
const MessageQueue = require("../src/utils/MessageQueue");
const RequestHandler = require("../src/core/RequestHandler");
const FormatConverter = require("../src/core/FormatConverter");
const { decodeResponse, createFetch } = require("../scripts/duplex-client");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const body = () => ({ contents: [{ parts: [{ text: "写一篇文章" }], role: "user" }] });
const reply = (text, finishReason = "STOP", extra = []) => ({
    candidates: [
        {
            content: {
                parts: [
                    ...extra,
                    {
                        functionCall: {
                            args: { content: text },
                            name: "output_content",
                        },
                        thoughtSignature: "signature",
                    },
                ],
                role: "model",
            },
            finishReason,
        },
    ],
    usageMetadata: { candidatesTokenCount: 5, promptTokenCount: 10, totalTokenCount: 15 },
});
const plain = (text, finishReason = "STOP", extra = []) => ({
    ...reply(text, finishReason),
    candidates: [{ content: { parts: [...extra, { text }], role: "model" }, finishReason }],
});
const textOf = response =>
    response.candidates[0].content.parts
        .filter(p => !p.thought)
        .map(p => p.text)
        .join("");
const frames = res =>
    res.output
        .split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));

const { EventEmitter } = require("node:events");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");

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
        this.type("application/json");
        return this.send(JSON.stringify(value));
    }
}

function requestHarness(responses, { accounts = [0, 1, 2] } = {}) {
    const registry = new ConnectionRegistry(logger);
    const config = {
        fakeStreamTimeoutMs: 1000,
        immediateSwitchStatusCodes: [429],
        maxRetries: 3,
        retryDelay: 1,
        streamingMode: "real",
        switchOnUses: 0,
    };
    const handler = new RequestHandler({ config }, registry, logger, { currentAuthIndex: 0 }, config, {});
    const sent = [];
    const sentAccounts = [];
    const cancelled = [];
    const switched = [];
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._selectDispatchAuthIndex = () => 0;
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    handler._prepareImmediateStatusRetry = async (error, requestId, tracker) => {
        switched.push(error.status);
        const next = accounts.find(authIndex => !tracker.attemptedAuthIndices.has(authIndex));
        if (next === undefined) return false;
        tracker.nextAuthIndex = next;
        tracker.attemptedAuthIndices.add(next);
        return true;
    };
    handler.authSwitcher.handleRequestFailureAndSwitch = async error => {
        switched.push(error.status);
    };
    for (const authIndex of accounts)
        registry.connectionsByAuth.set(authIndex, {
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") {
                    cancelled.push({ authIndex, ...spec });
                    return;
                }
                sent.push(spec);
                sentAccounts.push(authIndex);
                const queue = registry.messageQueues.get(spec.request_id).queue;
                const selected = responses[Math.min(sent.length - 1, responses.length - 1)];
                const response = typeof selected === "function" ? selected(spec) : selected;
                if (response === null) return;
                if (response.event_type === "error") {
                    queue.enqueue(response);
                    return;
                }
                queue.enqueue({ event_type: "response_headers", status: 200 });
                const json = JSON.stringify(response);
                queue.enqueue({ data: json.slice(0, 17), event_type: "chunk" });
                queue.enqueue({ data: json.slice(17), event_type: "chunk" });
                queue.enqueue({ type: "STREAM_END" });
            },
        });
    return { cancelled, handler, registry, sent, sentAccounts, switched };
}

function apiRequest(api, model, stream) {
    const common = { headers: {}, method: "POST", query: {} };
    if (api === "gemini")
        return {
            ...common,
            body: body(),
            path: `/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent" : "generateContent"}`,
        };
    if (api === "responses") return { ...common, body: { input: "Hi", model, stream }, path: "/v1/responses" };
    return {
        ...common,
        body: { max_tokens: 100, messages: [{ content: "Hi", role: "user" }], model, stream },
        path: api === "claude" ? "/v1/messages" : "/v1/chat/completions",
    };
}

const processors = {
    claude: "processClaudeRequest",
    gemini: "processRequest",
    openai: "processOpenAIRequest",
    responses: "processOpenAIResponseRequest",
};

function harness(respond) {
    const parent = new MessageQueue();
    const entries = new Map([["parent", { authIndex: 0, queue: parent }]]);
    const sent = [];
    const cancelled = [];
    let counter = 0;
    const handler = {
        _cancelBrowserRequest: id => cancelled.push(id),
        _createImmediateSwitchTracker: authIndex => ({ attemptedAuthIndices: new Set([authIndex]) }),
        _forwardRequest(spec) {
            sent.push(spec);
            const queue = entries.get(spec.request_id).queue;
            if (respond) respond(queue, spec);
        },
        _generateRequestAttemptId: id => `${id}-attempt`,
        _generateRequestId: () => `child-${++counter}`,
        _getUsageStatsService: () => null,
        authSwitcher: { incrementUsageCount() {}, shouldSwitchByUsage: () => false },
        connectionRegistry: {
            createMessageQueue(id, authIndex) {
                const queue = new MessageQueue();
                entries.set(id, { authIndex, queue });
                return queue;
            },
            messageQueues: entries,
            removeMessageQueue(id, reason) {
                entries.get(id)?.queue.close(reason);
                entries.delete(id);
            },
        },
        logger: { info() {} },
        timeouts: { FAKE_STREAM: 1000 },
    };
    const spec = {
        anti_truncation: true,
        body: JSON.stringify(body()),
        path: "/v1beta/models/gemini-3.8-flash:generateContent",
        request_id: "parent",
    };
    return { cancelled, entries, handler, parent, sent, spec };
}

test("only the supported exact aliases activate on either channel", () => {
    for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        for (const prefix of ["", "build-", "pg-"])
            assert.equal(AntiTruncation.baseModel(encodeURIComponent(`${prefix}${model}-抗截断`)), model);
        assert.equal(AntiTruncation.baseModel(model), null);
        assert.equal(AntiTruncation.baseModel(`${model}-抗截断-high`), null);
    }
    assert.equal(AntiTruncation.baseModel("gemini-other-抗截断"), null);
});

test("preparation declares one string field and a short hint without changing the preset", () => {
    const original = {
        ...body(),
        generationConfig: { maxOutputTokens: 32000, temperature: 0.8 },
        systemInstruction: { parts: [{ text: "保留任意标签及格式" }] },
    };
    const snapshot = structuredClone(original);
    const { request } = Output.prepare(original);
    assert.deepEqual(original, snapshot, "the caller's request must not be mutated");
    assert.deepEqual(request.systemInstruction, original.systemInstruction);
    assert.deepEqual(request.contents[0].parts[0], original.contents[0].parts[0]);
    assert.match(request.contents[0].parts.at(-1).text, /output_content/);
    assert.equal(request.tools[0].functionDeclarations.length, 1);
    const declaration = request.tools[0].functionDeclarations[0];
    assert.equal(declaration.name, "output_content");
    assert.deepEqual(declaration.parameters.properties, { content: { type: "STRING" } });
    assert.deepEqual(declaration.parameters.required, ["content"]);
    assert.deepEqual(request.generationConfig, {
        candidateCount: 1,
        maxOutputTokens: 32000,
        stopSequences: [],
        temperature: 0.8,
    });
    const pg = AntiTruncation.playgroundBody(request);
    assert.equal(pg.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.deepEqual(pg.systemInstruction, original.systemInstruction);
});

test("one generation unwraps the full reply byte-for-byte and preserves usage and native thoughts", async () => {
    const text = '  <analysis>预设文本</analysis>\n<think>原样保留</think>\n<正文>你好🙂\r\n"\\</正文>  ';
    const upstream = reply(text, "STOP", [{ text: "native reasoning", thought: true }]);
    let calls = 0;
    const result = await Output.generate(body(), async () => {
        calls++;
        return upstream;
    });
    assert.equal(calls, 1);
    assert.equal(textOf(result), text);
    assert.deepEqual(result.candidates[0].content.parts[0], { text: "native reasoning", thought: true });
    assert.deepEqual(result.usageMetadata, upstream.usageMetadata);
    assert.ok(result.candidates[0].content.parts.every(part => !part.functionCall));
});

test("valid plain text and token-limited output finish after one generation without continuation", async () => {
    for (const response of [reply("partial", "MAX_TOKENS"), plain("partial", "MAX_TOKENS"), plain("complete")]) {
        let calls = 0;
        const result = await Output.generate(body(), async () => {
            calls++;
            return response;
        });
        assert.equal(calls, 1);
        assert.equal(
            textOf(result),
            textOf(response) || response.candidates[0].content.parts[0].functionCall.args.content
        );
        assert.equal(result.candidates[0].finishReason, response.candidates[0].finishReason);
    }
});

test("malformed, empty and thought-only responses fail without repair or another generation", async () => {
    const invalid = [
        null,
        [],
        {},
        { candidates: [] },
        reply(" "),
        plain(""),
        plain("", "STOP", [{ text: "thinking only", thought: true }]),
        reply("partial", "MALFORMED_FUNCTION_CALL"),
    ];
    for (const args of [null, '{"content":', {}, { content: 42 }, []]) {
        const response = reply("unused");
        response.candidates[0].content.parts[0].functionCall.args = args;
        invalid.push(response);
    }
    const multiple = reply("one");
    multiple.candidates[0].content.parts.push(reply("two").candidates[0].content.parts[0]);
    invalid.push(multiple);
    const unknown = reply("one");
    unknown.candidates[0].content.parts[0].functionCall.name = "unknown";
    invalid.push(unknown);
    for (const response of invalid) {
        let calls = 0;
        await assert.rejects(
            Output.generate(body(), async () => {
                calls++;
                return response;
            }),
            error => error.status === 502 && error.retryable === false
        );
        assert.equal(calls, 1);
    }
});

test("stop strings apply to decoded content and never cut the JSON envelope", async () => {
    const request = { ...body(), generation_config: { stop_sequences: ["END", "STOP"] } };
    const result = await Output.generate(request, async sent => {
        assert.equal(sent.generationConfig.stopSequences, undefined);
        return reply("beforeENDhidden", "MAX_TOKENS");
    });
    assert.equal(textOf(result), "before");
    assert.equal(result.candidates[0].finishReason, "STOP");
});

test("blocked replies preserve their status and do not reveal internal calls", async () => {
    for (const reason of AntiTruncation.BLOCKED_FINISH_REASONS) {
        const result = await Output.generate(body(), async () => reply("blocked", reason));
        assert.equal(result.candidates[0].finishReason, reason);
        assert.equal(textOf(result), "");
    }
    const result = await Output.generate(body(), async () => ({ promptFeedback: { blockReason: "SAFETY" } }));
    assert.equal(result.promptFeedback.blockReason, "SAFETY");
    assert.equal(result.candidates[0].finishReason, "SAFETY");
});

test("unsupported inputs fail locally and historical tools become text while thought parts are dropped", () => {
    for (const patch of [
        { tools: [{}] },
        { cachedContent: "x" },
        { generationConfig: { responseMimeType: "application/json" } },
        { contents: [{ parts: [{ inlineData: { data: "x", mimeType: "image/png" } }] }] },
    ])
        assert.throws(
            () => Output.prepare({ ...body(), ...patch }),
            error => error.status === 400
        );
    const request = body();
    request.contents.push({
        parts: [
            { text: "old reasoning", thought: true },
            { functionCall: { args: { content: "old answer" }, name: "old" } },
            { text: "signature", thoughtSignature: "retained" },
        ],
        role: "model",
    });
    const prepared = Output.prepare(request).request;
    assert.deepEqual(prepared.contents[1].parts, [
        { text: "old answer" },
        { text: "signature", thoughtSignature: "retained" },
    ]);
    assert.equal(prepared.contents.at(-1).role, "user");
});

test("forwarding buffers a complete response, publishes it once and cleans the child queue", async () => {
    const h = harness(queue => {
        const json = JSON.stringify(reply("正文"));
        queue.enqueue({ data: json.slice(0, 20), event_type: "chunk" });
        queue.enqueue({ data: json.slice(20), event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    });
    await AntiTruncation.forward(h.handler, { ...h.spec, anti_truncation_segments: true }, 0);
    assert.equal((await h.parent.dequeue()).text, "正文");
    assert.equal((await h.parent.dequeue()).status, 200);
    assert.equal(textOf(JSON.parse((await h.parent.dequeue()).data)), "正文");
    assert.equal((await h.parent.dequeue()).type, "STREAM_END");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].anti_truncation, false);
    assert.equal(h.sent[0].streaming_mode, "fake");
    assert.equal(h.entries.size, 1);
    assert.deepEqual(h.cancelled, []);
});

test("cancellation and deadlines abort pending work and clean queues", async () => {
    for (const cancel of [false, true]) {
        const h = harness();
        h.handler.timeouts.FAKE_STREAM = 15;
        const run = AntiTruncation.forward(h.handler, h.spec, 0);
        if (cancel) h.parent.close("client_disconnect");
        await run;
        if (!cancel) assert.equal((await h.parent.dequeue()).status, 504);
        assert.deepEqual(h.cancelled, ["child-1"]);
        assert.equal(h.entries.size, 1);
        assert.equal(h.parent.listenerCount("close"), 0);
    }
    assert.equal(AntiTruncation.maxWaitMs(1000), 2000);
});

test("all aliases and API formats return the unchanged full reply after one upstream generation", async t => {
    const text = "<analysis>keep</analysis>\n<thinking>keep this too</thinking>\n<任意标签>你好🙂</任意标签>";
    for (const [api, method] of Object.entries(processors)) {
        for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
            for (const mode of ["nonstream", "real", "fake"]) {
                await t.test(`${api}/${model}/${mode}`, async () => {
                    const h = requestHarness([reply(text)]);
                    h.handler.config.antiTruncationStreamingMode = mode;
                    const res = new FakeResponse();
                    await h.handler[method](apiRequest(api, `${model}-抗截断`, mode !== "nonstream"), res);
                    assert.equal(res.statusCode, 200, res.output);
                    assert.equal(h.sent.length, 1);
                    assert.equal(JSON.parse(h.sent[0].body).tools[0].functionDeclarations[0].name, "output_content");
                    assert.ok(res.output.includes("keep this too"), res.output);
                    assert.doesNotMatch(res.output, /output_content|append_output|finish_output/);
                    assert.equal(h.registry.messageQueues.size, 0);
                    assert.ok(res.writableEnded);
                    if (api === "openai") {
                        const received =
                            mode === "nonstream"
                                ? JSON.parse(res.output).choices[0].message.content
                                : frames(res)
                                      .map(event => event.choices?.[0]?.delta?.content || "")
                                      .join("");
                        assert.equal(received, text);
                    }
                });
            }
        }
    }
});

test("token limits, native reasoning and protocol failures survive every public API", async t => {
    for (const [api, method] of Object.entries(processors)) {
        for (const stream of [false, true]) {
            await t.test(`${api}/${stream}`, async () => {
                const h = requestHarness([
                    reply("retained", "MAX_TOKENS", [{ text: "native thought", thought: true }]),
                ]);
                const res = new FakeResponse();
                await h.handler[method](apiRequest(api, "gemini-4-argon-抗截断", stream), res);
                assert.equal(res.statusCode, 200, res.output);
                assert.ok(res.output.includes("retained"), res.output);
                assert.ok(res.output.includes("native thought"), res.output);
                assert.match(res.output, /length|max_tokens|incomplete|MAX_TOKENS/);
                assert.equal(h.sent.length, 1);
                const invalid = requestHarness([reply("", "MALFORMED_FUNCTION_CALL")]);
                const failed = new FakeResponse();
                await invalid.handler[method](apiRequest(api, "gemini-4-argon-抗截断", stream), failed);
                assert.equal(failed.statusCode, 502, failed.output);
                assert.equal(invalid.sent.length, 1, "no protocol repair or whole-request replay");
                assert.deepEqual(invalid.switched, []);
                assert.equal(invalid.registry.messageQueues.size, 0);
            });
        }
    }
});

test("ordinary account errors may retry before output; the successful result needs no follow-up", async () => {
    const h = requestHarness([{ event_type: "error", message: "limited", status: 429 }, reply("recovered")]);
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "gemini-4-argon-抗截断", false), res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(JSON.parse(res.output).choices[0].message.content, "recovered");
    assert.deepEqual(h.sentAccounts, [0, 1]);
    assert.equal(h.sent[0].body, h.sent[1].body);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("disconnect before readiness or during generation cannot publish or dispatch later work", async () => {
    for (const beforeReady of [false, true]) {
        const h = requestHarness([null]);
        let ready;
        if (beforeReady)
            h.handler._ensureBrowserBackedRequestReady = () =>
                new Promise(resolve => {
                    ready = resolve;
                });
        const res = new FakeResponse();
        const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-4-argon-抗截断", true), res);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(res.headersSent, false);
        assert.equal(res.output, "");
        res.socket.destroyed = true;
        const disconnectedAt = Date.now();
        res.emit("close");
        await pending;
        assert.ok(Date.now() - disconnectedAt < 500, "disconnect must cancel promptly");
        ready?.(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.sent.length, beforeReady ? 0 : 1);
        assert.equal(
            h.cancelled.filter(cancel => cancel.request_id === h.sent[0]?.request_id).length,
            beforeReady ? 0 : 1
        );
        assert.equal(h.registry.messageQueues.size, 0);
        assert.equal(res.output, "");
    }
});

test("native reasoning remains independent of preset labels and tag splitting requires explicit opt-in", async () => {
    const text = "<think>preset text</think>answer";
    for (const split of [undefined, false, true]) {
        const h = requestHarness([reply(text, "STOP", [{ text: "native thought", thought: true }])]);
        h.handler.config.antiTruncationSplitThinking = split;
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(apiRequest("openai", "gemini-4-argon-抗截断", false), res);
        const message = JSON.parse(res.output).choices[0].message;
        assert.equal(message.content, split ? "answer" : text);
        assert.ok(message.reasoning_content.includes("native thought"));
        if (split) assert.ok(message.reasoning_content.includes("preset text"));
    }
    const ConfigLoader = require("../src/utils/ConfigLoader");
    const previous = process.env.ANTI_TRUNCATION_SPLIT_THINKING;
    try {
        delete process.env.ANTI_TRUNCATION_SPLIT_THINKING;
        assert.equal(new ConfigLoader(logger).loadConfiguration().antiTruncationSplitThinking, false);
    } finally {
        if (previous === undefined) delete process.env.ANTI_TRUNCATION_SPLIT_THINKING;
        else process.env.ANTI_TRUNCATION_SPLIT_THINKING = previous;
    }
});

test("optional OpenAI tool output uses one output_content call and round-trips in all modes", async () => {
    const text = '<analysis>keep</analysis>\n你好🙂 "\\';
    for (const mode of ["nonstream", "real", "fake"]) {
        const h = requestHarness([reply(text, "STOP", [{ text: "native thought", thought: true }])]);
        h.handler.config.antiTruncationStreamingMode = mode;
        const req = apiRequest("openai", "gemini-4-argon-抗截断", mode !== "nonstream");
        req.headers["x-anti-truncation-output"] = "tools";
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 200, res.output);
        assert.ok(res.output.includes("output_content"));
        assert.doesNotMatch(res.output, /append_output|finish_output/);
        const response = new Response(res.output, { headers: res.headers });
        const decoded = await decodeResponse(response);
        if (mode === "nonstream") {
            const value = await decoded.json();
            assert.equal(value.choices[0].message.content, text);
            assert.equal(value.choices[0].message.reasoning_content, "native thought");
            assert.equal(value.choices[0].finish_reason, "stop");
        } else {
            const value = frames({ output: await decoded.text() });
            assert.equal(value.map(event => event.choices?.[0]?.delta?.content || "").join(""), text);
            assert.equal(
                value.map(event => event.choices?.[0]?.delta?.reasoning_content || "").join(""),
                "native thought"
            );
            assert.equal(value.at(-1).choices[0].finish_reason, "stop");
        }
        assert.equal(h.sent.length, 1);
    }
});

test("client decoder handles fragmented UTF-8 and JSON escapes and rejects incomplete tool output", async () => {
    const text = '你好🙂\n"\\<custom>正文</custom>';
    const call = { function: { arguments: JSON.stringify({ content: text }), name: "output_content" } };
    const payload =
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(payload);
    const response = new Response(
        new ReadableStream({
            start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream", "x-anti-truncation-output": "tools" } }
    );
    const decoded = frames({ output: await (await decodeResponse(response)).text() });
    assert.equal(decoded.map(event => event.choices[0].delta.content || "").join(""), text);
    assert.equal(decoded.at(-1).choices[0].finish_reason, "length");
    await assert.rejects(
        decodeResponse(
            new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [] } }] }), {
                headers: { "content-type": "application/json", "x-anti-truncation-output": "tools" },
            })
        ),
        /without content/
    );
});

test("client adapter recognizes prefixed aliases and keeps ordinary requests unchanged", async () => {
    for (const model of [
        "pg-gemini-4-argon-抗截断",
        "build-gemini-3.8-flash-抗截断",
        "gemini-3.7-flash-抗截断",
        "pg-gemini-4-argon",
    ]) {
        let request;
        const fetch = createFetch(async sent => {
            request = sent;
            return new Response("error", { status: 429 });
        });
        await fetch("https://example.test/v1/chat/completions", { body: JSON.stringify({ model }), method: "POST" });
        assert.equal(request.headers.get("x-anti-truncation-output"), model.endsWith("-抗截断") ? "tools" : null);
    }
});

test("alias requests with client tools fall back to the base model on every public API", async t => {
    const tools = {
        claude: [{ input_schema: { properties: {}, type: "object" }, name: "get_weather" }],
        gemini: [{ functionDeclarations: [{ name: "get_weather" }] }],
        openai: [
            { function: { name: "get_weather", parameters: { properties: {}, type: "object" } }, type: "function" },
        ],
        responses: [{ name: "get_weather", parameters: { properties: {}, type: "object" }, type: "function" }],
    };
    const plain = { candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }] };
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            const h = requestHarness([plain]);
            const req = apiRequest(api, "gemini-4-argon-抗截断", false);
            req.body.tools = tools[api];
            const res = new FakeResponse();
            await h.handler[method](req, res);
            assert.equal(res.statusCode, 200, res.output);
            assert.ok(res.output.includes("ok"), res.output);
            assert.equal(h.sent.length, 1);
            assert.equal(h.sent[0].path, "/v1beta/models/gemini-4-argon:generateContent");
            assert.equal(h.sent[0].anti_truncation, undefined);
            const sentTools = JSON.parse(h.sent[0].body).tools;
            assert.equal(sentTools[0].functionDeclarations[0].name, "get_weather");
        });
    }
});

test("fallback detection covers tools, toolConfig, cachedContent and forced built-ins", () => {
    for (const extra of [
        { tools: [{ googleSearch: {} }] },
        { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
        { cached_content: "cache" },
    ]) {
        assert.equal(AntiTruncation.requiresOriginalModel({ ...body(), ...extra }), true);
    }
    assert.equal(AntiTruncation.requiresOriginalModel({ ...body(), tools: [] }), false);
    assert.equal(AntiTruncation.requiresOriginalModel(body()), false);
    assert.equal(AntiTruncation.openAIRequiresOriginalModel({ tools: [] }), false);
    assert.equal(AntiTruncation.openAIRequiresOriginalModel({ functions: [{ name: "f" }] }), true);
    assert.equal(AntiTruncation.openAIRequiresOriginalModel({}, { forceWebSearch: true }), true);
});

test("OpenAI, Responses and Claude converters preserve the alias and trailing-user compatibility", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const model = "gemini-3.8-flash-抗截断";
    const results = await Promise.all([
        converter.translateOpenAIToGoogle({
            messages: [
                { content: "Hi", role: "user" },
                { content: "Hello", role: "assistant" },
            ],
            model,
        }),
        converter.translateOpenAIResponseToGoogle({
            input: [
                { content: "Hi", role: "user" },
                { content: "Hello", role: "assistant" },
            ],
            model,
        }),
        converter.translateClaudeToGoogle({
            max_tokens: 100,
            messages: [
                { content: "Hi", role: "user" },
                { content: "Hello", role: "assistant" },
            ],
            model,
        }),
    ]);
    for (const result of results) {
        assert.equal(result.cleanModelName, model);
        assert.equal(result.googleRequest.contents.at(-1).role, "user");
        assert.doesNotThrow(() => Output.prepare(result.googleRequest));
    }
});

test("countTokens maps both path and nested model without injecting tools", () => {
    const handler = Object.create(RequestHandler.prototype);
    const spec = {
        body: JSON.stringify({ generateContentRequest: { model: "models/gemini-3.8-flash-抗截断", ...body() } }),
        is_generative: false,
        path: "/v1beta/models/gemini-3.8-flash-抗截断:countTokens",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(spec);
    assert.equal(spec.path, "/v1beta/models/gemini-3.8-flash:countTokens");
    assert.equal(JSON.parse(spec.body).generateContentRequest.model, "models/gemini-3.8-flash");
    assert.equal(spec.anti_truncation, undefined);
});

test("all aliases are present exactly once with metadata from their original model", () => {
    const { models } = require("../configs/models.json");
    for (const name of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        const original = models.find(model => model.name === `models/${name}`);
        const aliases = models.filter(model => model.name === `models/${name}-抗截断`);
        assert.equal(aliases.length, 1);
        assert.equal(aliases[0].inputTokenLimit, original.inputTokenLimit);
        assert.ok(aliases[0].supportedGenerationMethods.includes("generateContent"));
    }
});
