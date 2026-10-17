const test = require("node:test");
const assert = require("node:assert/strict");
const AntiTruncation = require("../src/core/AntiTruncation");
const Duplex = require("../src/core/DuplexToolTransport");
const MessageQueue = require("../src/utils/MessageQueue");

const body = () => ({ contents: [{ parts: [{ text: "写一篇文章" }], role: "user" }] });
// One signed append_output turn, as the upstream model returns it.
const reply = (seq, text, done, finishReason = "STOP") => ({
    candidates: [
        {
            content: {
                parts: [
                    {
                        functionCall: {
                            args: { ...(done === undefined ? {} : { done }), seq, text },
                            name: "append_output",
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
const textOf = response => response.candidates[0].content.parts[0].text;

test("only the supported exact opt-in aliases activate, including encoded native paths", () => {
    for (const base of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        assert.equal(AntiTruncation.baseModel(base + "-抗截断"), base);
        assert.equal(AntiTruncation.baseModel(base + encodeURIComponent("-抗截断")), base);
        assert.equal(AntiTruncation.baseModel(base), null);
    }
    assert.equal(AntiTruncation.baseModel("gemini-3.6-flash-抗截断"), null);
    assert.equal(AntiTruncation.baseModel("gemini-3.8-pro-抗截断"), null);
    assert.equal(AntiTruncation.baseModel("%invalid"), null);
});

test("complete output preserves text byte-for-byte and hides internal calls", async () => {
    const original = body();
    const snapshot = JSON.stringify(original);
    const text = '<hello>你好</hello>\n```js\nconst x = "\\n";\n```\n';
    let count = 0;
    const result = await Duplex.generate(original, async request => {
        count++;
        assert.equal(request.toolConfig.functionCallingConfig.mode, "ANY");
        assert.equal(request.tools[0].functionDeclarations[0].name, "append_output");
        return reply(1, text, true);
    });
    assert.equal(count, 1);
    assert.equal(textOf(result), text);
    assert.equal(result.candidates[0].finishReason, "STOP");
    assert.ok(!JSON.stringify(result).includes("functionCall"));
    assert.equal(JSON.stringify(original), snapshot);
});

test("continuation preserves signature, acknowledges call, appends text and sums usage", async () => {
    let count = 0;
    const reasons = [];
    const result = await Duplex.generate(
        body(),
        async request => {
            if (count++) {
                assert.equal(request.contents.at(-3).parts[0].thoughtSignature, "signature");
                assert.equal(request.contents.at(-2).parts[0].functionResponse.name, "append_output");
                assert.ok(request.contents.at(-1).parts[0].text);
                return reply(2, "后半段", true);
            }
            return reply(1, "前半段\n", false);
        },
        reason => reasons.push(reason)
    );
    assert.deepEqual(reasons, ["continue"]);
    assert.equal(textOf(result), "前半段\n后半段");
    assert.deepEqual(result.usageMetadata, { candidatesTokenCount: 10, promptTokenCount: 20, totalTokenCount: 30 });
});

test("incomplete answers stop at the segment cap and retain MAX_TOKENS", async () => {
    let count = 0;
    const result = await Duplex.generate(body(), async () => {
        count++;
        return reply(count, String(count), false);
    });
    assert.equal(count, AntiTruncation.MAX_SEGMENTS + 1);
    assert.equal(textOf(result), Array.from({ length: AntiTruncation.MAX_SEGMENTS }, (_, i) => String(i + 1)).join(""));
    assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
});

test("MAX_TOKENS overrides a premature model completion claim", async () => {
    let count = 0;
    const result = await Duplex.generate(body(), async () =>
        ++count === 1 ? reply(1, "A", true, "MAX_TOKENS") : reply(2, "B", true)
    );
    assert.equal(count, 2);
    assert.equal(textOf(result), "AB");
});

test("stop sequences work across continuation boundaries", async () => {
    const input = body();
    input.generationConfig = { stopSequences: ["<END>"] };
    let count = 0;
    const result = await Duplex.generate(input, async request => {
        assert.equal(request.generationConfig.stopSequences, undefined);
        return ++count === 1 ? reply(1, "answer<EN", false) : reply(2, "D>hidden", true);
    });
    assert.equal(textOf(result), "answer");
});

test("malformed calls fail explicitly and blocked output never leaks tools or triggers continuation", async () => {
    await assert.rejects(
        Duplex.generate(body(), async () => reply(0, "partial", false)),
        /repair exhausted/
    );
    let count = 0;
    const result = await Duplex.generate(body(), async () => {
        count++;
        return reply(1, "", false, "SAFETY");
    });
    assert.equal(count, 1);
    assert.equal(result.candidates[0].finishReason, "SAFETY");
    assert.ok(!JSON.stringify(result).includes("functionCall"));
});

test("client tools and structured outputs are rejected without overwriting them", () => {
    for (const extra of [
        { tools: [{ googleSearch: {} }] },
        { cachedContent: "cache" },
        { generationConfig: { responseMimeType: "application/json" } },
        { generationConfig: { candidateCount: 2 } },
    ]) {
        assert.throws(
            () => Duplex.prepare({ ...body(), ...extra }),
            error => error.status === 400
        );
    }
});

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

test("forwarding buffers real queue chunks, rewrites transport and cleans child queues", async () => {
    const h = harness(queue => {
        const json = JSON.stringify(reply(1, "正文", true));
        queue.enqueue({ event_type: "response_headers", status: 200 });
        queue.enqueue({ data: json.slice(0, 30), event_type: "chunk" });
        queue.enqueue({ data: json.slice(30), event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    });
    await AntiTruncation.forward(h.handler, h.spec, 0);
    assert.equal((await h.parent.dequeue()).status, 200);
    const data = JSON.parse((await h.parent.dequeue()).data);
    assert.equal(data.candidates[0].content.parts[0].text, "正文");
    assert.equal((await h.parent.dequeue()).type, "STREAM_END");
    assert.equal(h.sent[0].anti_truncation, false);
    assert.equal(h.sent[0].streaming_mode, "fake");
    assert.equal(h.entries.size, 1);
    assert.equal(h.cancelled.length, 0);
});

test("client cancellation aborts the child and releases its queue", async () => {
    const h = harness();
    const pending = AntiTruncation.forward(h.handler, h.spec, 0);
    h.parent.close("client_disconnect");
    await pending;
    assert.deepEqual(h.cancelled, ["child-1"]);
    assert.equal(h.entries.size, 1);
    assert.equal(h.parent.listenerCount("close"), 0);
});

test("deadline aborts hanging upstream work", async () => {
    const h = harness();
    h.handler.timeouts.FAKE_STREAM = 10;
    await AntiTruncation.forward(h.handler, h.spec, 0);
    const error = await h.parent.dequeue();
    assert.equal(error.event_type, "error");
    assert.equal(error.status, 504);
    assert.deepEqual(h.cancelled, ["child-1"]);
    assert.equal(h.entries.size, 1);
});

test("each continuation gets its own upstream timeout", async () => {
    let round = 0;
    const h = harness(queue => {
        round++;
        const response = reply(round, String(round), round === 3);
        setTimeout(() => {
            queue.enqueue({ data: JSON.stringify(response), event_type: "chunk" });
            queue.enqueue({ type: "STREAM_END" });
        }, 120);
    });
    h.handler.timeouts.FAKE_STREAM = 300;
    await AntiTruncation.forward(h.handler, h.spec, 0);
    assert.equal((await h.parent.dequeue()).status, 200);
    assert.equal(JSON.parse((await h.parent.dequeue()).data).candidates[0].content.parts[0].text, "123");
    assert.equal((await h.parent.dequeue()).type, "STREAM_END");
    assert.equal(round, 3);
    assert.deepEqual(h.cancelled, []);
});

const RequestHandler = require("../src/core/RequestHandler");
const FormatConverter = require("../src/core/FormatConverter");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("request routing strips aliases only on the two allowed models and buffers generation", () => {
    const handler = Object.create(RequestHandler.prototype);
    for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        for (const suffix of ["-抗截断", encodeURIComponent("-抗截断")]) {
            const spec = {
                is_generative: true,
                path: `/v1beta/models/${model}${suffix}:streamGenerateContent`,
                request_id: "r",
                streaming_mode: "real",
            };
            handler._initializeProxyRequestAttempt(spec);
            assert.equal(spec.path, `/v1beta/models/${model}:streamGenerateContent`);
            assert.equal(spec.anti_truncation, true);
            assert.equal(spec.anti_truncation_mode, "duplex");
            assert.equal(spec.streaming_mode, "fake");
        }
        const original = {
            is_generative: true,
            path: `/v1beta/models/${model}:streamGenerateContent`,
            request_id: "r",
            streaming_mode: "real",
        };
        handler._initializeProxyRequestAttempt(original);
        assert.equal(original.anti_truncation, undefined);
        assert.equal(original.streaming_mode, "real");
    }
    const other = {
        is_generative: true,
        path: "/v1beta/models/gemini-3.6-flash-抗截断:generateContent",
        request_id: "r",
    };
    handler._initializeProxyRequestAttempt(other);
    assert.equal(other.anti_truncation, undefined);
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
        assert.doesNotThrow(() => Duplex.prepare(result.googleRequest));
    }
});

test("restored output converts to ordinary text in all non-streaming and SSE formats", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const response = await Duplex.generate(body(), async () => reply(1, "你好正文", true));
    const model = "gemini-3.7-flash-抗截断";
    const outputs = [
        converter.convertGoogleToOpenAINonStream(response, model),
        converter.convertGoogleToResponseAPINonStream(response, model),
        converter.convertGoogleToClaudeNonStream(response, model),
        converter.translateGoogleToOpenAIStream(JSON.stringify(response), model, {}),
        converter.translateGoogleToResponseAPIStream(JSON.stringify(response), model, {}),
        converter.translateGoogleToClaudeStream(JSON.stringify(response), model, {}),
    ];
    for (const output of outputs) {
        const value = typeof output === "string" ? output : JSON.stringify(output);
        assert.ok(value.includes("你好正文"));
        assert.ok(!value.includes("append_output"));
        assert.ok(!value.includes('"tool_calls"'));
    }
});

test("native histories ending in a model turn gain an ordinary user turn; function turns are rejected", () => {
    const input = body();
    input.contents.push({ parts: [{ text: "previous reply" }], role: "model" });
    const { request } = Duplex.prepare(input);
    assert.equal(request.contents.at(-1).role, "user");
    assert.equal(request.contents.at(-1).parts[0].text, "\n");
    assert.equal(input.contents.length, 2);
    const withFunction = body();
    withFunction.contents.push({ parts: [{ functionResponse: { name: "previous", response: {} } }], role: "user" });
    assert.throws(
        () => Duplex.prepare(withFunction),
        error => error.status === 400
    );
});

test("a single OpenAI stop string is honored after conversion", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const { googleRequest } = await converter.translateOpenAIToGoogle({
        messages: [{ content: "Hi", role: "user" }],
        model: "gemini-3.8-flash-抗截断",
        stop: "END",
    });
    const result = await Duplex.generate(googleRequest, async request => {
        assert.equal(request.generationConfig.stopSequences, undefined);
        return reply(1, "answerENDhidden", true);
    });
    assert.equal(result.candidates[0].content.parts[0].text, "answer");
});

test("invalid input is rejected before any paid request", async () => {
    for (const input of [
        null,
        [],
        { contents: [null] },
        { contents: [{ parts: [null] }] },
        { ...body(), generationConfig: { stopSequences: 1 } },
        { ...body(), generationConfig: { stopSequences: [null] } },
        { ...body(), generationConfig: { candidateCount: 0 } },
        { ...body(), generationConfig: { responseModalities: "TEXT" } },
        { ...body(), systemInstruction: "invalid" },
    ]) {
        let sent = false;
        await assert.rejects(
            Duplex.generate(input, async () => {
                sent = true;
            }),
            error => error.status === 400
        );
        assert.equal(sent, false);
    }
});

test("native protobuf spellings preserve system instructions and stop sequences", async () => {
    const input = {
        ...body(),
        generation_config: { stop_sequences: ["END"] },
        system_instruction: { parts: [{ text: "My instruction" }] },
    };
    const snapshot = JSON.stringify(input);
    const result = await Duplex.generate(input, async request => {
        assert.equal(request.generation_config, undefined);
        assert.equal(request.system_instruction, undefined);
        assert.equal(request.systemInstruction.parts[0].text, "My instruction");
        assert.equal(request.generationConfig.stopSequences, undefined);
        return reply(1, "answerENDignored", true);
    });
    assert.equal(result.candidates[0].content.parts[0].text, "answer");
    assert.equal(JSON.stringify(input), snapshot);
    assert.throws(
        () => Duplex.prepare({ ...body(), generation_config: { response_mime_type: "application/json" } }),
        error => error.status === 400
    );
    assert.throws(
        () => Duplex.prepare({ ...body(), tool_config: { functionCallingConfig: { mode: "NONE" } } }),
        error => error.status === 400
    );
});

test("malformed upstream envelopes and function statuses fail rather than return a blank success", async () => {
    for (const response of [
        null,
        [],
        {},
        { candidates: [] },
        reply(1, "partial", true, "MALFORMED_FUNCTION_CALL"),
        reply(1, "partial", true, "OTHER"),
        reply(1, "partial", true, ""),
    ]) {
        await assert.rejects(
            Duplex.generate(body(), async () => response),
            error => error.status === 502 && error.retryable === false
        );
    }
});

test("prompt blocking remains a content-filter result in compatibility responses", async () => {
    let sent = 0;
    const response = await Duplex.generate(body(), async () => {
        sent++;
        return { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 12 } };
    });
    assert.equal(sent, 1);
    assert.equal(response.promptFeedback.blockReason, "SAFETY");
    const converter = new FormatConverter(logger, { config: {} });
    assert.equal(converter.convertGoogleToOpenAINonStream(response).choices[0].finish_reason, "content_filter");
});

test("continuation acknowledgement echoes the upstream function call ID", async () => {
    let sent = 0;
    await Duplex.generate(body(), async request => {
        if (sent++) {
            assert.equal(request.contents.at(-2).parts[0].functionResponse.id, "upstream-call-id");
            return reply(2, "B", true);
        }
        const response = reply(1, "A", false);
        response.candidates[0].content.parts[0].functionCall.id = "upstream-call-id";
        return response;
    });
});

test("valid text cut off before the done flag can continue on MAX_TOKENS", async () => {
    let sent = 0;
    const result = await Duplex.generate(body(), async () =>
        sent++ ? reply(2, "B", true) : reply(1, "A", undefined, "MAX_TOKENS")
    );
    assert.equal(result.candidates[0].content.parts[0].text, "AB");
});

test("Responses marks exhausted continuation as incomplete in JSON and SSE, only for aliases", async () => {
    const response = await Duplex.generate(body(), async () => reply(1, "part", false));
    const converter = new FormatConverter(logger, { config: {} });
    for (const model of ["gemini-3.7-flash-抗截断", "gemini-3.8-flash-抗截断", "gemini-4-argon-抗截断"]) {
        const result = converter.convertGoogleToResponseAPINonStream(response, model);
        assert.equal(result.status, "incomplete");
        assert.equal(result.incomplete_details.reason, "max_output_tokens");
        assert.equal(result.output[0].status, "incomplete");
        const sse = converter.translateGoogleToResponseAPIStream(JSON.stringify(response), model, {});
        assert.match(sse, /event: response.incomplete/);
        assert.doesNotMatch(sse, /event: response.completed/);
        const events = sse
            .split("\n")
            .filter(line => line.startsWith("data: "))
            .map(line => JSON.parse(line.slice(6)));
        const final = events.at(-1).response;
        assert.equal(final.incomplete_details.reason, "max_output_tokens");
        assert.equal(final.output[0].status, "incomplete");
    }
    assert.equal(converter.convertGoogleToResponseAPINonStream(response, "gemini-3.8-flash").status, "completed");
});

test("cancellation still closes and releases queues when sending cancel throws", async () => {
    const h = harness();
    h.handler._cancelBrowserRequest = () => {
        throw new Error("socket already closed");
    };
    const pending = AntiTruncation.forward(h.handler, h.spec, 0);
    const waiting = h.parent.dequeue();
    assert.doesNotThrow(() => h.parent.close("client_disconnect"));
    await assert.rejects(waiting, error => error.code === "QUEUE_CLOSED");
    await pending;
    assert.equal(h.entries.size, 1);
    assert.equal(h.parent.listenerCount("close"), 0);
});

test("closing a queue twice settles pending readers and notifies listeners exactly once", async () => {
    const queue = new MessageQueue();
    let closed = 0;
    queue.on("close", () => {
        closed++;
    });
    const waiting = queue.dequeue();
    queue.close("client_disconnect");
    queue.close("handler_cleanup");
    await assert.rejects(waiting, error => error.reason === "client_disconnect");
    assert.equal(closed, 1);
    assert.equal(queue.closeReason, "client_disconnect");
});

test("transport preserves non-retryable protocol errors and clears child queues", async () => {
    const h = harness(queue => {
        queue.enqueue({ data: "{invalid", event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    });
    await AntiTruncation.forward(h.handler, h.spec, 0);
    const error = await h.parent.dequeue();
    assert.equal(error.status, 502);
    assert.equal(error.retryable, false);
    assert.equal(h.entries.size, 1);
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

test("all aliases traverse all four public handlers in streaming and non-streaming modes", async t => {
    for (const base of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        for (const [api, method] of Object.entries(processors)) {
            for (const stream of [false, true]) {
                await t.test(`${base} ${api} stream=${stream}`, async () => {
                    const h = requestHarness(duplexTextReplies(["前半", "后半"]));
                    const res = new FakeResponse();
                    await h.handler[method](apiRequest(api, `${base}-抗截断`, stream), res);
                    assert.equal(res.statusCode, 200, res.output);
                    assert.equal(visibleText(res, api, stream), "前半后半", res.output);
                    assert.ok(!res.output.includes("deliver_response"));
                    assert.equal(h.sent.length, 3);
                    assert.equal(h.handler.authSwitcher.usageCount, 3);
                    assert.equal(h.sent[0].path, `/v1beta/models/${base}:generateContent`);
                    assert.equal(h.sent[0].streaming_mode, "fake");
                    assert.equal(h.registry.messageQueues.size, 0);
                    assert.equal(h.switched.length, 0);
                    if (stream) assert.equal(res.get("Content-Type"), "text/event-stream");
                    assert.equal(res.writableEnded, true);
                });
            }
        }
    }
});

test("protocol repair is bounded without switching accounts", async () => {
    const h = requestHarness([{}]);
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", false), res);
    assert.equal(res.statusCode, 502);
    assert.equal(h.sent.length, 3);
    assert.equal(h.switched.length, 0);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("buffered alias retry retains duplex after a 429 without leaking intermediate events", async () => {
    const h = requestHarness([
        { event_type: "error", message: "rate limited", status: 429 },
        ...duplexTextReplies(["recovered"]),
    ]);
    const res = new FakeResponse();
    await h.handler.processOpenAIResponseRequest(apiRequest("responses", "gemini-3.7-flash-抗截断", false), res);
    assert.equal(res.statusCode, 200, res.output);
    assert.ok(res.output.includes("recovered"));
    assert.equal(h.sent.length, 3);
    for (const spec of h.sent)
        assert.equal(JSON.parse(spec.body).tools[0].functionDeclarations[0].name, "append_output");
    assert.deepEqual(h.switched, [429]);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("anti-truncation retries the failed continuation across all public APIs without replaying accepted text", async t => {
    for (const [api, method] of Object.entries(processors)) {
        for (const stream of [false, true]) {
            await t.test(`${api} stream=${stream}`, async () => {
                const h = requestHarness([
                    duplexReply("append_output", { seq: 1, text: "accepted " }),
                    { event_type: "error", message: "rate limited", status: 429 },
                    duplexReply("append_output", { done: true, seq: 2, text: "continued" }),
                ]);
                const res = new FakeResponse();
                await h.handler[method](apiRequest(api, "gemini-3.8-flash-抗截断", stream), res);
                assert.equal(res.statusCode, 200, res.output);
                assert.equal(visibleText(res, api, stream), "accepted continued");
                assert.deepEqual(h.sentAccounts, [0, 0, 1]);
                assert.equal(h.sent[1].body, h.sent[2].body);
                const history = JSON.parse(h.sent[2].body).contents;
                assert.ok(history.some(turn => turn.parts.some(part => part.functionResponse)));
                assert.equal(h.handler.authSwitcher.usageCount, 3);
                assert.equal(h.registry.messageQueues.size, 0);
            });
        }
    }
});

test("OpenAI duplex retries both the first round and a repair round on the selected account", async t => {
    for (const repair of [false, true]) {
        for (const stream of [false, true]) {
            await t.test(`repair=${repair} stream=${stream}`, async () => {
                const h = requestHarness([
                    ...(repair ? [duplexReply("append_output", { seq: 9, text: "invalid" })] : []),
                    { event_type: "error", message: "rate limited", status: 429 },
                    duplexReply("append_output", { done: true, seq: 1, text: "recovered" }),
                ]);
                const res = new FakeResponse();
                await h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.7-flash-抗截断", stream), res);
                assert.equal(res.statusCode, 200, res.output);
                assert.equal(visibleText(res, "openai", stream), "recovered");
                assert.equal(h.sent.at(-2).body, h.sent.at(-1).body);
                assert.equal(h.sentAccounts.at(-1), 1);
                assert.equal(h.registry.messageQueues.size, 0);
            });
        }
    }
});

const incompleteMarkers = {
    claude: /"stop_reason":"max_tokens"/,
    gemini: /"finishReason":"MAX_TOKENS"/,
    openai: /"finish_reason":"length"/,
    responses: /"status":"incomplete"/,
};

test("all rate-limited accounts keep accepted text as incomplete and never restart buffered generation", async t => {
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            const h = requestHarness([
                duplexReply("append_output", { seq: 1, text: "accepted" }),
                { event_type: "error", message: "upstream rate limit", status: 429 },
            ]);
            const res = new FakeResponse();
            await h.handler[method](apiRequest(api, "gemini-3.7-flash-抗截断", false), res);
            assert.equal(res.statusCode, 200, res.output);
            assert.deepEqual(h.sentAccounts, [0, 0, 1, 2]);
            for (const spec of h.sent.slice(2)) assert.equal(spec.body, h.sent[1].body);
            assert.equal(visibleText(res, api, false), "accepted");
            assert.match(res.output, incompleteMarkers[api]);
            assert.equal(h.registry.messageQueues.size, 0);
        });
    }
});

test("a first-round failure with nothing accepted still returns the original upstream error", async t => {
    for (const [api, method] of Object.entries(processors)) {
        await t.test(api, async () => {
            const h = requestHarness([{ event_type: "error", message: "upstream rate limit", status: 429 }]);
            const res = new FakeResponse();
            await h.handler[method](apiRequest(api, "gemini-3.7-flash-抗截断", false), res);
            assert.equal(res.statusCode, 429, res.output);
            assert.deepEqual(h.sentAccounts, [0, 1, 2]);
            assert.ok(res.output.includes("upstream rate limit"));
            assert.equal(h.registry.messageQueues.size, 0);
        });
    }
});

test("native transport also retries JSON error envelopes and keeps subsequent usage on the new account", async () => {
    const h = requestHarness([
        { error: { code: 429, message: "rate limited" } },
        reply(1, "first", false),
        reply(2, "second", true),
    ]);
    const attempts = [];
    h.handler._getUsageStatsService = () => ({ recordAttempt: (id, account) => attempts.push(account) });
    const parent = h.registry.createMessageQueue("parent", 0, "attempt");
    await AntiTruncation.forward(
        h.handler,
        {
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
        },
        0
    );
    assert.equal((await parent.dequeue()).status, 200);
    assert.equal(JSON.parse((await parent.dequeue()).data).candidates[0].content.parts[0].text, "firstsecond");
    assert.deepEqual(h.sentAccounts, [0, 1, 1]);
    assert.deepEqual(attempts, [1, 1]);
    assert.equal(h.registry.getAuthIndexForRequest("parent"), 1);
    h.registry.removeMessageQueue("parent");
});

test("the shared retry helper keeps rate-limited accounts excluded across continuation rounds", async () => {
    const h = requestHarness([
        { event_type: "error", message: "first account limited", status: 429 },
        reply(1, "accepted", false),
        { event_type: "error", message: "second account limited", status: 429 },
        reply(2, " continued", true),
    ]);
    const coolingDown = new Set();
    h.handler.authSource.markAccountCoolingDown = authIndex => coolingDown.add(authIndex);
    h.handler.authSource.isAccountCoolingDown = authIndex => coolingDown.has(authIndex);
    h.handler._getReadyAuthIndices = () => [0, 1, 2];
    h.handler._selectDispatchAuthIndex = RequestHandler.prototype._selectDispatchAuthIndex;
    h.handler._prepareImmediateStatusRetry = RequestHandler.prototype._prepareImmediateStatusRetry;
    h.handler.authSwitcher.switchToNextAuth = async ({ excludeIndices }) => {
        const next = [0, 1, 2].find(account => !excludeIndices.includes(account) && !coolingDown.has(account));
        if (next === undefined) return { success: false };
        h.handler.browserManager.currentAuthIndex = next;
        return { success: true };
    };
    const parent = h.registry.createMessageQueue("parent", 0, "attempt");
    await AntiTruncation.forward(
        h.handler,
        {
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
        },
        0
    );
    assert.equal((await parent.dequeue()).status, 200);
    assert.equal(JSON.parse((await parent.dequeue()).data).candidates[0].content.parts[0].text, "accepted continued");
    assert.equal(h.sent.length, 4);
    assert.notEqual(h.sentAccounts[1], 0);
    assert.equal(h.sentAccounts[2], h.sentAccounts[1]);
    assert.equal(coolingDown.has(h.sentAccounts[3]), false);
    assert.equal(coolingDown.size, 2);
    assert.equal(h.sent[2].body, h.sent[3].body);
    assert.equal(h.registry.getAuthIndexForRequest("parent"), h.sentAccounts[3]);
    h.registry.removeMessageQueue("parent");
});

test("account retry moves parent ownership and cancellation follows the actual child account", async () => {
    const h = requestHarness([{ event_type: "error", message: "limited", status: 429 }, null]);
    const parent = h.registry.createMessageQueue("parent", 0, "attempt");
    const prepare = h.handler._prepareImmediateStatusRetry;
    h.handler._prepareImmediateStatusRetry = async (...args) => {
        assert.equal(h.registry.getAuthIndexForRequest("parent"), null);
        h.registry.closeMessageQueuesForAuth(0, "context_closed");
        assert.equal(parent.closed, false);
        return prepare(...args);
    };
    const pending = AntiTruncation.forward(
        h.handler,
        {
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
        },
        0
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.sentAccounts, [0, 1]);
    assert.equal(h.registry.getQueueCountForAuth(0), 0);
    assert.equal(h.registry.getQueueCountForAuth(1), 1);
    h.registry.closeMessageQueuesForAuth(0, "reconnect_cleanup");
    assert.equal(parent.closed, false);
    // A delayed response from the failed child cannot reach its replacement.
    h.registry._handleIncomingMessage(
        JSON.stringify({
            data: "stale data",
            event_type: "chunk",
            request_attempt_id: h.sent[0].request_attempt_id,
            request_id: h.sent[0].request_id,
        }),
        0
    );
    assert.equal(h.registry.messageQueues.get(h.sent[1].request_id).queue.messages.length, 0);
    h.registry.removeMessageQueue("parent", "client_disconnect");
    await pending;
    assert.ok(
        h.cancelled.some(
            call =>
                call.authIndex === 1 &&
                call.request_id === h.sent[1].request_id &&
                call.request_attempt_id === h.sent[1].request_attempt_id
        )
    );
    assert.equal(h.registry.messageQueues.size, 0);
});

test("disconnect or parent replacement while a retry waits cannot dispatch another upstream call", async t => {
    for (const replace of [false, true]) {
        await t.test(`replace=${replace}`, async () => {
            const h = requestHarness([{ event_type: "error", message: "limited", status: 429 }]);
            const parent = h.registry.createMessageQueue("parent", 0, "attempt");
            let finishSwitch;
            h.handler._prepareImmediateStatusRetry = async (error, id, tracker) => {
                await new Promise(resolve => {
                    finishSwitch = resolve;
                });
                tracker.nextAuthIndex = 1;
                return true;
            };
            const pending = AntiTruncation.forward(
                h.handler,
                {
                    body: JSON.stringify(body()),
                    path: "/v1beta/models/gemini-3.8-flash:generateContent",
                    request_id: "parent",
                },
                0
            );
            await new Promise(resolve => setImmediate(resolve));
            let replacement;
            if (replace) replacement = h.registry.createMessageQueue("parent", 2, "replacement");
            else h.registry.removeMessageQueue("parent", "client_disconnect");
            // Parent cancellation must settle even if recovery has not completed yet.
            await pending;
            finishSwitch();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(parent.closed, true);
            assert.equal(h.sent.length, 1);
            if (replacement) {
                assert.equal(replacement.closed, false);
                assert.equal(replacement.messages.length, 0);
                assert.equal(h.registry.getAuthIndexForRequest("parent"), 2);
                h.registry.removeMessageQueue("parent");
            }
            assert.equal(h.registry.messageQueues.size, 0);
        });
    }
});

test("actual disconnect handler releases parent and child even with a broken socket", async () => {
    const h = requestHarness([null]);
    const parent = h.registry.createMessageQueue("parent", 0, "attempt");
    const res = new FakeResponse();
    h.handler._setupClientDisconnectHandler(res, "parent");
    const pending = AntiTruncation.forward(
        h.handler,
        {
            anti_truncation: true,
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
        },
        0
    );
    assert.equal(h.registry.messageQueues.size, 2);
    h.registry.connectionsByAuth.get(0).send = () => {
        throw new Error("socket closed");
    };
    assert.doesNotThrow(() => res.emit("close"));
    await pending;
    assert.equal(parent.closed, true);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("local validation errors avoid upstream calls and account switching through the public handler", async () => {
    const h = requestHarness([reply(1, "should not be called", true)]);
    const req = apiRequest("openai", "gemini-3.8-flash-抗截断", false);
    req.body.stop = [null];
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(h.sent.length, 0);
    assert.equal(h.switched.length, 0);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("original Flash models still send ordinary requests without the internal tool", async () => {
    for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
        const h = requestHarness([
            {
                candidates: [
                    { content: { parts: [{ text: "ordinary response" }], role: "model" }, finishReason: "STOP" },
                ],
            },
        ]);
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(apiRequest("openai", model, false), res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.output.includes("ordinary response"));
        assert.equal(h.sent.length, 1);
        assert.equal(JSON.parse(h.sent[0].body).tools, undefined);
    }
});

test("blocked finish reasons stay visible in native output and map to filtering for aliases", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const model = "gemini-3.7-flash-抗截断";
    const response = await Duplex.generate(body(), async () => reply(1, "hidden", true, "PROHIBITED_CONTENT"));
    assert.equal(response.candidates[0].finishReason, "PROHIBITED_CONTENT");
    assert.equal(converter.convertGoogleToOpenAINonStream(response, model).choices[0].finish_reason, "content_filter");
    assert.equal(
        converter.convertGoogleToResponseAPINonStream(response, model).incomplete_details.reason,
        "content_filter"
    );
    assert.match(
        converter.translateGoogleToResponseAPIStream(JSON.stringify(response), model, {}),
        /event: response.incomplete/
    );
    assert.doesNotMatch(JSON.stringify(response), /hidden/);
});

test("native snake-case config works alongside forced thinking without losing limits", async () => {
    const h = requestHarness(duplexTextReplies(["answerENDhidden"]));
    h.handler.config.forceThinking = true;
    const req = apiRequest("gemini", "gemini-3.8-flash-抗截断", false);
    req.body.generation_config = {
        max_output_tokens: 123,
        stop_sequences: ["END"],
        thinking_config: { include_thoughts: false },
    };
    const res = new FakeResponse();
    await h.handler.processRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(JSON.parse(res.output).candidates[0].content.parts[0].text, "answer");
    const upstream = JSON.parse(h.sent[0].body);
    assert.equal(upstream.generationConfig.maxOutputTokens, 123);
    assert.equal(upstream.generationConfig.thinkingConfig.includeThoughts, false);
    assert.equal(upstream.generation_config, undefined);
    assert.equal(upstream.generationConfig.thinking_config, undefined);
});

test("invalid native histories return 400 without an unhandled rejected request", async () => {
    const h = requestHarness([reply(1, "unused", true)]);
    const req = apiRequest("gemini", "gemini-3.7-flash-抗截断", false);
    req.body.contents = [null];
    const res = new FakeResponse();
    await h.handler.processRequest(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(h.sent.length, 0);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("anti-truncation parent and child count as one request when dispatching accounts", async () => {
    const h = requestHarness([null]);
    h.registry.createMessageQueue("parent", 0, "attempt");
    h.registry.createMessageQueue("ordinary", 1, "attempt");
    const pending = AntiTruncation.forward(
        h.handler,
        {
            anti_truncation: true,
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
        },
        0
    );
    try {
        assert.equal(h.registry.getQueueCountForAuth(0), 1);
        assert.equal(h.registry.getQueueCountForAuth(1), 1);
    } finally {
        h.registry.removeMessageQueue("parent", "client_disconnect");
        h.registry.removeMessageQueue("ordinary");
        await pending;
    }
});

test("invalid native anti-truncation parameters use INVALID_ARGUMENT and do not count as usage", async () => {
    const h = requestHarness([reply(1, "unused", true)]);
    const req = apiRequest("gemini", "gemini-3.8-flash-抗截断", false);
    req.body.generationConfig = { stopSequences: [null] };
    const res = new FakeResponse();
    await h.handler.processRequest(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.output).error.status, "INVALID_ARGUMENT");
    assert.equal(h.handler.authSwitcher.usageCount, 0);
    assert.equal(h.switched.length, 0);
});

test("internal queues remain visible for draining and count on their own if a parent is absent", () => {
    const registry = new ConnectionRegistry(logger);
    registry.createMessageQueue("parent", 0);
    registry.createMessageQueue("child", 0, "attempt", "parent");
    registry.createMessageQueue("other-account-child", 1, "attempt", "parent");
    assert.equal(registry.getQueueCountForAuth(0), 1);
    assert.equal(registry.getQueueCountForAuth(1), 1);
    registry.removeMessageQueue("parent");
    assert.equal(registry.getQueueCountForAuth(0), 1);
    assert.equal(registry.hasMessageQueueForAuth(0), true);
    registry.removeMessageQueue("child");
    registry.removeMessageQueue("other-account-child");
    assert.equal(registry.hasMessageQueueForAuth(0), false);
    assert.equal(registry.messageQueues.size, 0);
});

test("account selection balances ordinary requests with anti-truncation requests", () => {
    const h = requestHarness([]);
    h.registry.createMessageQueue("anti-parent", 0);
    h.registry.createMessageQueue("anti-child", 0, "attempt", "anti-parent");
    h.registry.createMessageQueue("ordinary", 1);
    h.handler._getReadyAuthIndices = () => [0, 1];
    assert.equal(RequestHandler.prototype._selectDispatchAuthIndex.call(h.handler), 0);
    assert.equal(RequestHandler.prototype._selectDispatchAuthIndex.call(h.handler), 1);
    for (const id of [...h.registry.messageQueues.keys()]) h.registry.removeMessageQueue(id);
});

test("replacing an attempt cancels its child without contaminating the replacement queue", async () => {
    const h = requestHarness([null]);
    const oldParent = h.registry.createMessageQueue("parent", 0, "old-attempt");
    const oldAttempt = AntiTruncation.forward(
        h.handler,
        {
            anti_truncation: true,
            body: JSON.stringify(body()),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_attempt_id: "old-attempt",
            request_id: "parent",
        },
        0
    );
    assert.equal(h.registry.messageQueues.size, 2);
    const replacement = h.registry.createMessageQueue("parent", 0, "new-attempt");
    await oldAttempt;
    assert.equal(oldParent.closed, true);
    assert.equal(replacement.closed, false);
    assert.equal(replacement.messages.length, 0);
    assert.equal(h.registry.messageQueues.size, 1);
    h.registry.removeMessageQueue("parent");
});

function visibleText(res, api, stream) {
    if (!stream) {
        const response = JSON.parse(res.output);
        if (api === "openai") return response.choices[0].message.content;
        if (api === "responses")
            return response.output
                .filter(item => item.type === "message")
                .flatMap(item => item.content)
                .map(part => part.text || "")
                .join("");
        if (api === "claude") return response.content.map(part => part.text || "").join("");
        return response.candidates[0].content.parts.map(part => part.text || "").join("");
    }
    const events = res.output
        .split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));
    if (api === "openai") return events.map(event => event.choices?.[0]?.delta?.content || "").join("");
    if (api === "responses")
        return events
            .filter(event => event.type === "response.output_text.delta")
            .map(event => event.delta)
            .join("");
    if (api === "claude")
        return events
            .filter(event => event.type === "content_block_delta" && event.delta?.type === "text_delta")
            .map(event => event.delta.text)
            .join("");
    return events
        .flatMap(event => event.candidates?.[0]?.content?.parts || [])
        .map(part => part.text || "")
        .join("");
}

test("large Unicode text survives three continuations and all public response formats byte-for-byte", async t => {
    const { createHash } = require("node:crypto");
    const hash = value => createHash("sha256").update(value).digest("hex");
    const expected =
        Array.from(
            { length: 4096 },
            (_, i) =>
                `[${String(i).padStart(4, "0")}] 中文段落🙂🚀，完整内容保留；<item>${i}</item> **Markdown** \\n "quoted"\t\r\n`
        ).join("") + "【唯一结尾-EOF】";
    const first = Math.floor(expected.length / 3);
    const second = Math.floor((expected.length * 2) / 3);
    const chunks = [expected.slice(0, first), expected.slice(first, second), expected.slice(second)];
    for (const model of ["gemini-3.7-flash-抗截断", "gemini-3.8-flash-抗截断", "gemini-4-argon-抗截断"]) {
        for (const [api, method] of Object.entries(processors)) {
            for (const stream of [false, true]) {
                await t.test(`${model} ${api} stream=${stream}`, async () => {
                    const h = requestHarness(duplexTextReplies(chunks));
                    h.handler.timeouts.FAKE_STREAM = 5000;
                    const res = new FakeResponse();
                    await h.handler[method](apiRequest(api, model, stream), res);
                    assert.equal(res.statusCode, 200);
                    const actual = visibleText(res, api, stream);
                    assert.equal(Buffer.byteLength(actual), Buffer.byteLength(expected));
                    assert.equal(hash(actual), hash(expected));
                    assert.ok(actual.endsWith("【唯一结尾-EOF】"));
                    assert.equal(h.registry.messageQueues.size, 0);
                });
            }
        }
    }
});

test("chunk limits leave headroom for JSON and explicit thinking budgets", async () => {
    for (const [generationConfig, limit] of [
        [{}, 12000],
        [{ maxOutputTokens: 4096 }, 3072],
        [{ maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 1024 } }, 2304],
        [{ maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: -1 } }, 3072],
        [{ maxOutputTokens: 50 }, 64],
        [{ maxOutputTokens: 65536 }, 12000],
    ]) {
        let sent = 0;
        const result = await Duplex.generate({ ...body(), generationConfig }, async request => {
            sent++;
            assert.match(request.systemInstruction.parts.at(-1).text, new RegExp(`within ${limit} characters`));
            return reply(sent, `part${sent}`, sent === 4);
        });
        assert.equal(sent, 4);
        assert.equal(textOf(result), "part1part2part3part4");
        assert.equal(result.candidates[0].finishReason, "STOP");
    }
});

test("segment capacity never shrinks when the output budget grows", () => {
    let previous = 0;
    for (let budget = 1; budget <= 65536; budget += 97) {
        const capacity = AntiTruncation.textChunkLimit(budget) * AntiTruncation.MAX_SEGMENTS;
        assert.ok(capacity >= previous, `budget ${budget}: ${capacity} < ${previous}`);
        previous = capacity;
    }
    assert.ok(AntiTruncation.textChunkLimit(undefined) * AntiTruncation.MAX_SEGMENTS >= previous);
    // The outer wait covers every possible segment, finish_output and repair call.
    assert.equal(AntiTruncation.maxWaitMs(1000), 1000 * (AntiTruncation.MAX_SEGMENTS + 1 + 2) + 1000);
});

test("malformed tool repair reduces chunk size without replaying diagnostics or accepted text", async () => {
    let sent = 0;
    const reasons = [];
    const diagnostics = [];
    const result = await Duplex.generate(
        body(),
        async request => {
            sent++;
            if (sent === 1) return reply(1, "accepted prefix\n", false);
            if (sent === 2)
                return {
                    candidates: [
                        {
                            content: { parts: [{ text: "NOT_AN_ANSWER" }], role: "model" },
                            finishMessage: "PRIVATE_DIAGNOSTIC",
                            finishReason: "MALFORMED_FUNCTION_CALL",
                        },
                    ],
                    usageMetadata: { totalTokenCount: 10 },
                };
            assert.ok(request.contents.at(-3).parts[0].functionCall.args.text.includes("accepted prefix"));
            assert.match(request.systemInstruction.parts.at(-1).text, /at most 6000 text characters/);
            assert.doesNotMatch(JSON.stringify(request), /PRIVATE_DIAGNOSTIC|NOT_AN_ANSWER/);
            return reply(2, "recovered tail", true);
        },
        reason => reasons.push(reason),
        () => {},
        diagnostic => diagnostics.push(diagnostic)
    );
    assert.equal(sent, 3);
    assert.deepEqual(reasons, ["continue", "repair"]);
    assert.deepEqual(diagnostics, [{ issue: "malformed tool arguments", segments: 1, type: "repair" }]);
    assert.equal(textOf(result), "accepted prefix\nrecovered tail");
    assert.equal(result.usageMetadata.totalTokenCount, 40);
});

test("exhausted repair returns an acknowledged prefix as incomplete without leaked diagnostics", async () => {
    let sent = 0;
    const diagnostics = [];
    const result = await Duplex.generate(
        body(),
        async () => {
            if (++sent === 1) return reply(1, "valid prefix", false);
            return { candidates: [{ finishMessage: "PRIVATE_DIAGNOSTIC", finishReason: "MALFORMED_FUNCTION_CALL" }] };
        },
        () => {},
        () => {},
        diagnostic => diagnostics.push(diagnostic.type)
    );
    assert.equal(sent, 4);
    assert.equal(textOf(result), "valid prefix");
    assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIAGNOSTIC/);
    assert.deepEqual(diagnostics, ["repair", "repair", "repair_exhausted"]);
});

const duplexClient = require("../scripts/duplex-client");
const parseSse = raw =>
    raw
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
        .map(line => JSON.parse(line.slice(5)));
const duplexReply = (name, args, finishReason = "STOP") => ({
    candidates: [
        {
            content: {
                parts: [{ functionCall: { args, id: "call-1", name }, thoughtSignature: "opaque-signature" }],
                role: "model",
            },
            finishReason,
        },
    ],
    usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 7, totalTokenCount: 10 },
});
const duplexTextReplies = texts => [
    ...texts.map((text, i) => duplexReply("append_output", { seq: i + 1, text })),
    duplexReply("finish_output", { last_seq: texts.length }),
];

async function runDuplex(replies, input = body()) {
    const requests = [],
        published = [];
    const result = await Duplex.generate(
        input,
        async request => {
            requests.push(JSON.parse(JSON.stringify(request)));
            const response = replies[requests.length - 1];
            assert.ok(response, "unexpected additional upstream request");
            return response;
        },
        () => {},
        segment => published.push(segment)
    );
    return { published, requests, result };
}

test("duplex preserves original conversation and signed output acknowledgements without an input round", async () => {
    const input = body();
    input.systemInstruction = { parts: [{ text: "System instruction stays at system priority." }] };
    const snapshot = JSON.stringify(input);
    const { result, requests, published } = await runDuplex(
        [
            duplexReply("append_output", { seq: 1, text: "你好🙂\n" }),
            duplexReply("append_output", { seq: 2, text: "完整结尾" }),
            duplexReply("finish_output", { last_seq: 2 }),
        ],
        input
    );
    assert.deepEqual(requests[0].contents, input.contents);
    assert.ok(!JSON.stringify(requests[0]).includes("read_input"));
    assert.equal(requests[0].systemInstruction.parts[0].text, input.systemInstruction.parts[0].text);
    const acknowledgement = requests[1].contents.find(turn => turn.parts[0].functionResponse).parts[0].functionResponse;
    assert.deepEqual(acknowledgement.response, { next_seq: 2, received: 1 });
    assert.equal(acknowledgement.id, "call-1");
    assert.equal(requests[1].contents[1].parts[0].thoughtSignature, "opaque-signature");
    assert.deepEqual(published, [
        { seq: 1, text: "你好🙂\n" },
        { seq: 2, text: "完整结尾" },
    ]);
    assert.equal(result.candidates[0].content.parts[0].text, "你好🙂\n完整结尾");
    assert.equal(result.candidates[0].finishReason, "STOP");
    assert.equal(result.usageMetadata.totalTokenCount, 30);
    assert.equal(JSON.stringify(input), snapshot);
});

test("duplex duplicate acknowledgements do not duplicate text; conflicting and missing sequences are repaired", async () => {
    for (const invalid of [
        { seq: 1, text: "A" },
        { seq: 1, text: "changed" },
        { seq: 3, text: "gap" },
    ]) {
        const { result, published } = await runDuplex([
            duplexReply("append_output", { seq: 1, text: "A" }),
            duplexReply("append_output", invalid),
            duplexReply("append_output", { seq: 2, text: "B" }),
            duplexReply("finish_output", { last_seq: 2 }),
        ]);
        assert.equal(result.candidates[0].content.parts[0].text, "AB");
        assert.equal(published.length, 2);
    }
});

test("direct input preserves multi-turn roles and adds only a user terminator when needed", async () => {
    for (const endWithModel of [false, true]) {
        const input = {
            contents: [
                { parts: [{ text: "first question" }], role: "user" },
                { parts: [{ text: "previous answer" }], role: "model" },
                ...(!endWithModel ? [{ parts: [{ text: "follow-up" }], role: "user" }] : []),
            ],
            systemInstruction: { parts: [{ text: "Keep this instruction." }] },
        };
        const snapshot = JSON.stringify(input);
        const { requests, result } = await runDuplex(
            [duplexReply("append_output", { done: true, seq: 1, text: "answer" })],
            input
        );
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].contents.slice(0, input.contents.length), input.contents);
        assert.equal(requests[0].contents.length, input.contents.length + Number(endWithModel));
        assert.equal(requests[0].contents.at(-1).role, "user");
        assert.equal(requests[0].systemInstruction.parts[0].text, "Keep this instruction.");
        assert.deepEqual(requests[0].toolConfig.functionCallingConfig.allowedFunctionNames, [
            "append_output",
            "finish_output",
        ]);
        assert.equal(result.candidates[0].finishReason, "STOP");
        assert.equal(JSON.stringify(input), snapshot);
    }
});

test("direct output handles empty completion and immediate blocking without follow-up calls", async () => {
    for (const [response, reason] of [
        [duplexReply("finish_output", { last_seq: 0 }), "STOP"],
        [{ promptFeedback: { blockReason: "SAFETY" } }, "SAFETY"],
        [duplexReply("append_output", { done: true, seq: 1, text: "blocked" }, "SAFETY"), "SAFETY"],
    ]) {
        const { result, requests, published } = await runDuplex([response]);
        assert.equal(requests.length, 1);
        assert.equal(result.candidates[0].finishReason, reason);
        assert.equal(result.candidates[0].content.parts[0].text, "");
        assert.deepEqual(published, []);
    }
});

test("duplex final segments confirm completion without a separate upstream round", async () => {
    const text = '中文🙂\n```json\n{"quoted":"value"}\n```\n<EN';
    const { result, requests, published } = await runDuplex(
        [duplexReply("append_output", { done: true, seq: 1, text })],
        { ...body(), generationConfig: { stopSequences: ["<END>"] } }
    );
    assert.equal(requests.length, 1);
    assert.equal(result.usageMetadata.totalTokenCount, 10);
    assert.equal(result.candidates[0].finishReason, "STOP");
    assert.equal(result.candidates[0].content.parts[0].text, text);
    assert.equal(published.map(segment => segment.text).join(""), text);
    const multi = await runDuplex([
        duplexReply("append_output", { done: false, seq: 1, text: "A" }),
        duplexReply("append_output", { done: false, seq: 2, text: "B" }),
        duplexReply("append_output", { done: true, seq: 3, text: "C" }),
    ]);
    assert.equal(multi.result.candidates[0].finishReason, "STOP");
    assert.equal(multi.result.candidates[0].content.parts[0].text, "ABC");
});

test("duplex completion flags cannot hide token limits or conflicting duplicate calls", async () => {
    const limited = await runDuplex([
        duplexReply("append_output", { done: true, seq: 1, text: "A" }, "MAX_TOKENS"),
        duplexReply("append_output", { done: true, seq: 2, text: "B" }),
    ]);
    assert.equal(limited.requests.length, 2);
    assert.equal(limited.result.candidates[0].content.parts[0].text, "AB");
    for (const invalid of [
        duplexReply("append_output", { done: "true", seq: 2, text: "invalid" }),
        duplexReply("append_output", { done: true, seq: 1, text: "changed" }),
        duplexReply("append_output", { done: true, seq: 2, text: "" }, "MAX_TOKENS"),
        { candidates: [{ content: { parts: [null] }, finishReason: "STOP" }] },
    ]) {
        const { result, published, requests } = await runDuplex([
            duplexReply("append_output", { seq: 1, text: "A" }),
            invalid,
            duplexReply("append_output", { done: true, seq: 2, text: "B" }),
        ]);
        assert.equal(result.candidates[0].content.parts[0].text, "AB");
        assert.equal(published.map(segment => segment.text).join(""), "AB");
        assert.ok(requests[2].systemInstruction.parts.at(-1).text.includes("Transport validation failed"));
    }
});

test("duplex stop detection preserves earliest matches across multiple segments", async () => {
    const { result, published } = await runDuplex(
        [
            duplexReply("append_output", { seq: 1, text: "prefix<" }),
            duplexReply("append_output", { seq: 2, text: "EN" }),
            duplexReply("append_output", { done: true, seq: 3, text: "D>hiddenSTOP" }),
        ],
        { ...body(), generationConfig: { stopSequences: ["STOP", "<END>"] } }
    );
    assert.equal(result.candidates[0].content.parts[0].text, "prefix");
    assert.equal(published.map(segment => segment.text).join(""), "prefix");
    assert.equal(result.candidates[0].finishReason, "STOP");
});

test("duplex rejects obsolete input tools and unknown tools with bounded repair", async () => {
    for (const response of [
        duplexReply("read_input", { task_id: "another-task" }),
        duplexReply("unknown_tool", { text: "unaccepted" }),
    ]) {
        let calls = 0;
        await assert.rejects(
            Duplex.generate(body(), async request => {
                calls++;
                assert.deepEqual(request.contents, body().contents);
                return response;
            }),
            /repair exhausted/
        );
        assert.equal(calls, 3);
    }
});

test("duplex validates completion, caps rounds and retains text on failed repair", async () => {
    const { result, requests } = await runDuplex([
        duplexReply("append_output", { seq: 1, text: "retained" }),
        ...Array.from({ length: 3 }, () => duplexReply("finish_output", { last_seq: 2 })),
    ]);
    assert.equal(requests.length, 4);
    assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
    assert.equal(result.candidates[0].content.parts[0].text, "retained");
});

test("duplex stop handling never streams a stop prefix and preserves surrogate pairs", async () => {
    const { result, published } = await runDuplex(
        [
            duplexReply("append_output", { seq: 1, text: "正文<EN" }),
            duplexReply("append_output", { seq: 2, text: "D>hidden" }),
        ],
        { ...body(), generationConfig: { stopSequences: ["<END>"] } }
    );
    assert.equal(result.candidates[0].content.parts[0].text, "正文");
    assert.equal(published.map(s => s.text).join(""), "正文");
    const emoji = await runDuplex([
        duplexReply("append_output", { seq: 1, text: "\ud83d" }),
        duplexReply("append_output", { seq: 2, text: "\ude42" }),
        duplexReply("finish_output", { last_seq: 2 }),
    ]);
    assert.equal(emoji.published.map(s => Buffer.from(s.text).toString()).join(""), "🙂");
});

test("accepted prefixes survive when a later round is blocked, without retrying the block", async () => {
    for (const blocked of [
        duplexReply("append_output", { seq: 2, text: "unaccepted" }, "SAFETY"),
        { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } },
    ]) {
        const duplex = await runDuplex([duplexReply("append_output", { seq: 1, text: "accepted" }), blocked]);
        assert.equal(duplex.result.candidates[0].content.parts[0].text, "accepted");
        assert.equal(duplex.result.candidates[0].finishReason, "SAFETY");
        assert.equal(duplex.requests.length, 2);
    }
});

test("duplex rejects unsupported multimodal and client tool input before network usage", async () => {
    for (const input of [
        { ...body(), tools: [{ googleSearch: {} }] },
        { contents: [{ parts: [{ inlineData: {} }], role: "user" }] },
    ]) {
        await assert.rejects(
            Duplex.generate(input, () => assert.fail("must not send")),
            error => error.status === 400
        );
    }
});

test("duplex HTTP route works with all aliases, text/tools output and normal/SSE clients", async t => {
    for (const base of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"])
        for (const stream of [false, true])
            for (const output of ["text", "tools"]) {
                await t.test(`${base} ${stream} ${output}`, async () => {
                    const expected = '中文🙂\n"引号"\\路径\r\nXML=<item>完整</item>';
                    const h = requestHarness([
                        duplexReply("append_output", { seq: 1, text: expected }),
                        duplexReply("finish_output", { last_seq: 1 }),
                    ]);
                    const req = apiRequest("openai", `${base}-抗截断`, stream);
                    req.headers = output === "tools" ? { "x-anti-truncation-output": "tools" } : {};
                    const res = new FakeResponse();
                    await h.handler.processOpenAIRequest(req, res);
                    assert.equal(res.statusCode, 200, res.output);
                    assert.equal(h.registry.messageQueues.size, 0);
                    assert.equal(h.sent.length, 2);
                    let decoded = new Response(res.output, {
                        headers: { ...res.headers, "content-type": stream ? "text/event-stream" : "application/json" },
                    });
                    if (output === "tools") {
                        assert.ok(!res.output.includes('"content":"中文'));
                        decoded = await duplexClient.decodeResponse(decoded);
                    }
                    const raw = await decoded.text();
                    const actual = stream
                        ? parseSse(raw)
                              .map(event => event.choices?.[0]?.delta?.content || "")
                              .join("")
                        : JSON.parse(raw).choices[0].message.content;
                    assert.equal(actual, expected);
                    assert.ok(!raw.includes('"tool_calls"'));
                });
            }
});

test("transport headers cannot activate duplex on original or other models", async () => {
    for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.8-pro"]) {
        const h = requestHarness([
            { candidates: [{ content: { parts: [{ text: "ordinary" }], role: "model" }, finishReason: "STOP" }] },
        ]);
        const req = apiRequest("openai", model, false);
        req.headers = { "x-anti-truncation-mode": "duplex", "x-anti-truncation-output": "tools" };
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 200, res.output);
        assert.equal(h.sent.length, 1);
        assert.equal(JSON.parse(h.sent[0].body).tools, undefined);
        assert.equal(h.sent[0].anti_truncation_mode, undefined);
        assert.equal(JSON.parse(res.output).choices[0].message.content, "ordinary");
    }
});

test("final-segment completion works through every public API and optional OpenAI tool decoding", async t => {
    for (const [api, method] of Object.entries(processors)) {
        for (const stream of [false, true]) {
            for (const output of api === "openai" ? ["text", "tools"] : ["text"]) {
                await t.test(`${api} stream=${stream} output=${output}`, async () => {
                    const text = "完整正文🙂\n";
                    const h = requestHarness([duplexReply("append_output", { done: true, seq: 1, text })]);
                    const req = apiRequest(api, "gemini-3.8-flash-抗截断", stream);
                    if (output === "tools") req.headers = { "x-anti-truncation-output": "tools" };
                    const res = new FakeResponse();
                    await h.handler[method](req, res);
                    assert.equal(res.statusCode, 200, res.output);
                    assert.equal(h.sent.length, 1);
                    assert.equal(h.registry.messageQueues.size, 0);
                    if (output === "tools") {
                        const decoded = await duplexClient.decodeResponse(
                            new Response(res.output, {
                                headers: {
                                    ...res.headers,
                                    "content-type": stream ? "text/event-stream" : "application/json",
                                },
                            })
                        );
                        res.output = await decoded.text();
                    }
                    assert.equal(visibleText(res, api, stream), text);
                });
            }
        }
    }
});

test("duplex disconnect cancels active child and removes parent/child queues", async () => {
    const h = requestHarness([null]);
    const req = apiRequest("openai", "gemini-3.8-flash-抗截断", true);
    const res = new FakeResponse();
    const pending = h.handler.processOpenAIRequest(req, res);
    await new Promise(resolve => setImmediate(resolve));
    res.destroyed = true;
    res.emit("close");
    await pending;
    assert.equal(h.registry.messageQueues.size, 0);
});

test("duplex client decodes fragmented UTF-8, JSON escapes and trailing SSE frames exactly", async () => {
    const text = '中🙂\n"引号"\\路径\r\n'.repeat(1000);
    const frames = [
        {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            { function: { arguments: JSON.stringify({ seq: 1, text }), name: "append_output" } },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
        {
            choices: [
                {
                    delta: { tool_calls: [{ function: { arguments: '{"last_seq":1}', name: "finish_output" } }] },
                    finish_reason: null,
                },
            ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const wire = frames.map(frame => "data:" + JSON.stringify(frame) + "\r\n\r\n").join("") + "data: [DONE]";
    const bytes = Buffer.from(wire.replaceAll("中", "\\u4e2d"));
    let offset = 0;
    const response = new Response(
        new ReadableStream({
            pull(controller) {
                if (offset === bytes.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.subarray(offset, offset + 17));
                offset = Math.min(offset + 17, bytes.length);
            },
        }),
        { headers: { "content-type": "text/event-stream", "x-anti-truncation-output": "tools" } }
    );
    const decoded = await duplexClient.decodeResponse(response);
    const events = parseSse(await decoded.text());
    assert.equal(events.map(event => event.choices[0].delta.content || "").join(""), text);
    assert.equal(events.at(-1).choices[0].finish_reason, "stop");
});

test("duplex decoder rejects missing sequence and missing completion but preserves blocked prefixes", async () => {
    for (const [seq, finish, reason, fails] of [
        [2, true, "tool_calls", true],
        [1, false, "tool_calls", true],
        [1, false, "content_filter", false],
    ]) {
        const calls = [{ function: { arguments: JSON.stringify({ seq, text: "accepted" }), name: "append_output" } }];
        if (finish) calls.push({ function: { arguments: JSON.stringify({ last_seq: seq }), name: "finish_output" } });
        const response = new Response(
            JSON.stringify({ choices: [{ finish_reason: reason, message: { tool_calls: calls } }] }),
            { headers: { "content-type": "application/json", "x-anti-truncation-output": "tools" } }
        );
        if (fails) await assert.rejects(duplexClient.decodeResponse(response));
        else {
            const result = await (await duplexClient.decodeResponse(response)).json();
            assert.equal(result.choices[0].message.content, "accepted");
            assert.equal(result.choices[0].finish_reason, "content_filter");
        }
    }
});

test("duplex adapter preserves Request overrides and only opts in exact aliases", async () => {
    const received = [];
    const fetch = duplexClient.createFetch(async request => {
        received.push(request);
        return new Response("upstream error", { status: 400 });
    });
    for (const model of ["gemini-3.8-flash-抗截断", "gemini-3.8-flash", "gemini-4-argon-抗截断", "gemini-4-argon"]) {
        const controller = new AbortController();
        const original = new Request("https://example.invalid/v1/chat/completions", { body: "{}", method: "POST" });
        await fetch(original, {
            body: JSON.stringify({ messages: [{ content: "override", role: "user" }], model }),
            headers: { Authorization: "test-secret" },
            signal: controller.signal,
        });
        const request = received.at(-1);
        assert.equal((await request.json()).messages[0].content, "override");
        assert.equal(request.headers.get("authorization"), "test-secret");
        assert.equal(request.headers.get("x-anti-truncation-mode"), null);
        assert.equal(request.headers.get("x-anti-truncation-output"), model.endsWith("-抗截断") ? "tools" : null);
        controller.abort();
        assert.equal(request.signal.aborted, true);
    }
});

test("duplex upstream failure keeps its SSE code, or returns delivered output as incomplete without restarting", async () => {
    for (const partial of [false, true]) {
        const responses = partial
            ? [
                  duplexReply("append_output", { seq: 1, text: "accepted" }),
                  { event_type: "error", message: "upstream rate limit", status: 429 },
              ]
            : [{ event_type: "error", message: "upstream rate limit", status: 429 }];
        const h = requestHarness(responses);
        const req = apiRequest("openai", "gemini-3.8-flash-抗截断", true);
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 200);
        if (partial) {
            assert.equal(visibleText(res, "openai", true), "accepted");
            assert.ok(res.output.includes('"finish_reason":"length"'));
            assert.ok(!res.output.includes('"code":429'));
        } else assert.ok(res.output.includes('"code":429'));
        assert.equal(h.sent.length, responses.length + 2);
        assert.deepEqual(h.sentAccounts, partial ? [0, 0, 1, 2] : [0, 1, 2]);
        assert.equal(h.registry.messageQueues.size, 0);
    }
});

test("duplex cannot silently fall back when a proxy drops opt-in headers", async () => {
    const fetch = duplexClient.createFetch(async () => new Response("ordinary response"));
    await assert.rejects(
        fetch("https://example.invalid/v1/chat/completions", {
            body: JSON.stringify({ model: "gemini-3.8-flash-抗截断" }),
            method: "POST",
        }),
        /did not enable/
    );
});

test("duplex appends are bounded and empty or malformed arguments cannot produce a fake successful finish", async () => {
    let calls = 0;
    const result = await Duplex.generate(body(), async () => {
        calls++;
        return duplexReply("append_output", { seq: calls, text: String(calls) });
    });
    assert.equal(calls, AntiTruncation.MAX_SEGMENTS + 1);
    assert.equal(textOf(result), "12345678");
    assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
    let count = 0;
    await assert.rejects(
        Duplex.generate(body(), async () => {
            count++;
            return duplexReply("append_output", { seq: 1, text: "" });
        }),
        /repair exhausted/
    );
    assert.equal(count, 3);
});

test("duplex streams a first segment while the model is still generating later segments", async () => {
    const h = requestHarness([duplexReply("append_output", { seq: 1, text: "visible-before-completion" }), null]);
    h.handler.config.streamingMode = "fake"; // Ordinary streams must not buffer duplex segments.
    const req = apiRequest("openai", "gemini-3.8-flash-抗截断", true);
    const res = new FakeResponse();
    const pending = h.handler.processOpenAIRequest(req, res);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(res.output.includes("visible-before-completion"));
    assert.equal(res.writableEnded, false);
    res.destroyed = true;
    res.emit("close");
    await pending;
    assert.equal(h.registry.messageQueues.size, 0);
});

test("fake mode buffers anti-truncation segments, then visibly streams the complete text", async () => {
    const tail = "中🙂".repeat(150);
    const h = requestHarness([duplexReply("append_output", { seq: 1, text: "前半" }), null]);
    h.handler.config.antiTruncationStreamingMode = "fake";
    const res = new FakeResponse();
    const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", true), res);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.__proxyResponseStreamMode, "fake");
    assert.ok(!res.output.includes("前半"));
    assert.equal(res.writableEnded, false);
    const child = h.registry.messageQueues.get(h.sent[1].request_id).queue;
    child.enqueue({
        data: JSON.stringify(duplexReply("append_output", { done: true, seq: 2, text: tail })),
        event_type: "chunk",
    });
    child.enqueue({ type: "STREAM_END" });
    await pending;
    const chunks = parseSse(res.output)
        .map(event => event.choices?.[0]?.delta?.content)
        .filter(Boolean);
    assert.equal(chunks.join(""), `前半${tail}`);
    assert.ok(chunks.length > 1);
    assert.equal(h.registry.messageQueues.size, 0);
});

test("streams open immediately before browser readiness or model output", async () => {
    for (const mode of ["fake", "real"]) {
        const h = requestHarness([duplexReply("append_output", { done: true, seq: 1, text: "ready" })]);
        h.handler.config.antiTruncationStreamingMode = mode;
        let release;
        const ready = new Promise(resolve => {
            release = resolve;
        });
        h.handler._ensureBrowserBackedRequestReady = () => ready;
        const res = new FakeResponse();
        let flushed = false;
        res.flushHeaders = () => {
            flushed = true;
            res.headersSent = true;
        };
        const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", true), res);
        try {
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(flushed, true);
            assert.equal(res.get("Content-Type"), "text/event-stream");
            assert.equal(res.get("X-Accel-Buffering"), "no");
            assert.deepEqual(parseSse(res.output)[0].choices[0].delta, { content: "", role: "assistant" });
            assert.equal(h.sent.length, 0);
            assert.equal(res.writableEnded, false);
        } finally {
            release(true);
            await pending;
        }
        assert.equal(visibleText(res, "openai", true), "ready");
    }
});

test("opening frames cross a relay that buffers one event while fake-stream text stays buffered", async () => {
    const h = requestHarness([duplexReply("append_output", { seq: 1, text: "buffered prefix" }), null]);
    h.handler.config.antiTruncationStreamingMode = "fake";
    const res = new FakeResponse();
    let held = "";
    let downstream = "";
    const write = res.write.bind(res);
    res.write = value => {
        if (value.startsWith("data:")) {
            downstream += held;
            held = value === "data: [DONE]\n\n" ? "" : value;
            if (!held) downstream += value;
        }
        return write(value);
    };
    const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", true), res);
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(parseSse(downstream)[0].choices[0].delta.role, "assistant");
        assert.equal(h.sent.length, 2);
        assert.ok(!downstream.includes("buffered prefix"));
        assert.ok(!res.output.includes("buffered prefix"));
        assert.equal(res.writableEnded, false);
        const child = h.registry.messageQueues.get(h.sent[1].request_id).queue;
        child.enqueue({
            data: JSON.stringify(duplexReply("append_output", { done: true, seq: 2, text: " tail" })),
            event_type: "chunk",
        });
        child.enqueue({ type: "STREAM_END" });
        await pending;
        assert.equal(
            parseSse(downstream)
                .map(event => event.choices[0].delta.content || "")
                .join(""),
            "buffered prefix tail"
        );
        assert.ok(downstream.endsWith("data: [DONE]\n\n"));
    } finally {
        if (!res.writableEnded) {
            res.destroyed = true;
            res.emit("close");
        }
        await pending;
    }
});

test("disconnect during readiness ends the stream without dispatching generation later", async () => {
    const h = requestHarness([null]);
    let release;
    const ready = new Promise(resolve => {
        release = resolve;
    });
    h.handler._ensureBrowserBackedRequestReady = () => ready;
    const res = new FakeResponse();
    const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", true), res);
    await new Promise(resolve => setImmediate(resolve));
    res.destroyed = true;
    res.emit("close");
    await pending;
    release(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.sent.length, 0);
    assert.equal(h.registry.messageQueues.size, 0);
    assert.equal(res.__usageTrackingClientAborted, true);
    assert.equal(res.listenerCount("close"), 0);
});

test("readiness failure closes an already opened stream with an SSE error", async () => {
    for (const stream of [true, false]) {
        const h = requestHarness([null]);
        h.handler._ensureBrowserBackedRequestReady = async res => {
            h.handler._sendErrorResponse(res, 503, "Browser unavailable");
            h.handler._markTrackedEarlyExitIfNeeded(res, "Browser unavailable", 503);
            return false;
        };
        const res = new FakeResponse();
        await h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", stream), res);
        assert.equal(res.statusCode, stream ? 200 : 503);
        const error = stream ? parseSse(res.output).find(event => event.error).error : JSON.parse(res.output).error;
        assert.equal(error.code, 503);
        assert.equal(error.message, "Browser unavailable");
        if (stream) assert.ok(res.output.endsWith("data: [DONE]\n\n"));
        assert.equal(res.writableEnded, true);
        assert.equal(h.sent.length, 0);
    }
});

test("invalid streaming requests still return HTTP errors before opening SSE", async () => {
    const h = requestHarness([null]);
    const req = apiRequest("openai", "gemini-3.8-flash-抗截断", true);
    req.headers = { "x-anti-truncation-output": "invalid" };
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.output).error.code, 400);
    assert.equal(h.sent.length, 0);
});

test("fake mode preserves optional tool output for the client decoder", async () => {
    const h = requestHarness([duplexReply("append_output", { done: true, seq: 1, text: "正文🙂" })]);
    h.handler.config.antiTruncationStreamingMode = "fake";
    const req = apiRequest("openai", "gemini-3.8-flash-抗截断", true);
    req.headers = { "x-anti-truncation-output": "tools" };
    const res = new FakeResponse();
    await h.handler.processOpenAIRequest(req, res);
    const decoded = await duplexClient.decodeResponse(
        new Response(res.output, { headers: { ...res.headers, "content-type": "text/event-stream" } })
    );
    assert.equal(
        parseSse(await decoded.text())
            .map(event => event.choices[0].delta.content || "")
            .join(""),
        "正文🙂"
    );
    assert.equal(h.registry.messageQueues.size, 0);
});

test("fake mode sends data heartbeats while waiting for upstream", async () => {
    const DuplexOpenAI = require("../src/core/DuplexOpenAI");
    const original = DuplexOpenAI.HEARTBEAT_INTERVAL_MS;
    DuplexOpenAI.HEARTBEAT_INTERVAL_MS = 10;
    const h = requestHarness([null]);
    h.handler.config.antiTruncationStreamingMode = "fake";
    const res = new FakeResponse();
    const pending = h.handler.processOpenAIRequest(apiRequest("openai", "gemini-3.8-flash-抗截断", true), res);
    try {
        for (let i = 0; i < 50 && !res.output.includes(": keep-alive"); i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const events = parseSse(res.output);
        assert.ok(events.some(event => event.choices?.[0]?.delta?.role === "assistant"));
        assert.ok(events.some(event => event.choices?.[0]?.delta?.content === ""));
        assert.ok(res.output.includes(": keep-alive"));
    } finally {
        res.destroyed = true;
        res.emit("close");
        try {
            await pending;
        } finally {
            DuplexOpenAI.HEARTBEAT_INTERVAL_MS = original;
        }
    }
    assert.equal(h.registry.messageQueues.size, 0);
});

test("original models remain ordinary across every public API despite old mode headers", async t => {
    for (const [api, method] of Object.entries(processors)) {
        for (const model of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
            await t.test(`${api} ${model}`, async () => {
                const h = requestHarness([
                    {
                        candidates: [
                            {
                                content: { parts: [{ text: "ordinary response" }], role: "model" },
                                finishReason: "STOP",
                            },
                        ],
                    },
                ]);
                const req = apiRequest(api, model, false);
                req.headers = { "x-anti-truncation-mode": "duplex", "x-anti-truncation-output": "tools" };
                const res = new FakeResponse();
                await h.handler[method](req, res);
                assert.equal(res.statusCode, 200, res.output);
                assert.equal(visibleText(res, api, false), "ordinary response");
                assert.equal(h.sent.length, 1);
                assert.equal(JSON.parse(h.sent[0].body).tools, undefined);
                assert.equal(h.sent[0].anti_truncation, undefined);
            });
        }
    }
});

test("native alias requests without an explicit role automatically use duplex", async () => {
    const h = requestHarness(duplexTextReplies(["native result"]));
    const req = apiRequest("gemini", "gemini-3.8-flash-抗截断", false);
    delete req.body.contents[0].role;
    const res = new FakeResponse();
    await h.handler.processRequest(req, res);
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(visibleText(res, "gemini", false), "native result");
    const input = JSON.parse(h.sent[0].body).contents;
    assert.equal(input[0].role, "user");
    assert.equal(req.body.contents[0].role, undefined);
});

test("Argon converters preserve assistant history and add exactly one trailing user turn", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    for (const model of ["gemini-4-argon", "gemini-4-argon-抗截断", "gemini-4-argon-high-fake-search-code"]) {
        const messages = [
            { content: "Hi", role: "user" },
            { content: "Existing answer", role: "assistant" },
        ];
        const results = await Promise.all([
            converter.translateOpenAIToGoogle({ messages, model }),
            converter.translateOpenAIResponseToGoogle({ input: messages, model }),
            converter.translateClaudeToGoogle({ max_tokens: 100, messages, model }),
        ]);
        for (const { googleRequest, cleanModelName, modelStreamingMode } of results) {
            assert.deepEqual(googleRequest.contents.slice(-2), [
                { parts: [{ text: "Existing answer" }], role: "model" },
                { parts: [{ text: "\n" }], role: "user" },
            ]);
            converter._applyTrailingUserTurnGuard(googleRequest, cleanModelName);
            assert.equal(googleRequest.contents.length, 3);
            if (model.endsWith("-code")) {
                assert.equal(cleanModelName, "gemini-4-argon");
                assert.equal(modelStreamingMode, "fake");
                assert.equal(googleRequest.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
                assert.ok(googleRequest.tools.some(tool => tool.googleSearch));
                assert.ok(googleRequest.tools.some(tool => tool.codeExecution));
            }
        }
    }
});

test("Argon trailing turn guard preserves user text and tool results", () => {
    const converter = new FormatConverter(logger, { config: {} });
    const toolResult = { parts: [{ functionResponse: { name: "lookup", response: { result: "ok" } } }], role: "user" };
    const request = { contents: [toolResult] };
    converter._applyTrailingUserTurnGuard(request, "gemini-4-argon");
    assert.equal(request.contents[0], toolResult);
    assert.deepEqual(request.contents[1], { parts: [{ text: "\n" }], role: "user" });
    const ordinary = body();
    const snapshot = JSON.stringify(ordinary);
    converter._applyTrailingUserTurnGuard(ordinary, "gemini-4-argon");
    assert.equal(JSON.stringify(ordinary), snapshot);
    const older = { contents: [{ parts: [{ text: "done" }], role: "model" }] };
    converter._applyTrailingUserTurnGuard(older, "gemini-2.5-pro");
    assert.equal(older.contents.length, 1);
});

test("Argon native suffix routing and encoded alias token counting strip only gateway suffixes", () => {
    const handler = requestHarness([]).handler;
    const spec = handler._buildProxyRequest(
        {
            body: body(),
            headers: {},
            method: "POST",
            path: "/v1beta/models/gemini-4-argon-high-fake-search-code:streamGenerateContent",
            query: {},
        },
        "argon-suffix"
    );
    assert.equal(spec.path, "/v1beta/models/gemini-4-argon:streamGenerateContent");
    assert.equal(spec.streaming_mode, "fake");
    const payload = JSON.parse(spec.body);
    assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert.ok(payload.tools.some(tool => tool.googleSearch));
    assert.ok(payload.tools.some(tool => tool.codeExecution));
    const counter = {
        body: JSON.stringify({ generateContentRequest: { model: "models/gemini-4-argon-抗截断", ...body() } }),
        path: `/v1beta/models/${encodeURIComponent("gemini-4-argon-抗截断")}:countTokens`,
        request_id: "argon-count",
    };
    handler._initializeProxyRequestAttempt(counter);
    assert.equal(counter.path, "/v1beta/models/gemini-4-argon:countTokens");
    assert.equal(JSON.parse(counter.body).generateContentRequest.model, "models/gemini-4-argon");
    assert.equal(counter.anti_truncation, undefined);
});

test("a mid-answer upstream failure returns accepted text as incomplete; before any text it still throws", async () => {
    for (const failure of [
        Object.assign(new Error("Internal error"), { status: 500 }),
        Object.assign(new Error("Anti-truncation upstream round timed out."), { status: 504 }),
        AntiTruncation.protocolError("upstream returned incomplete or invalid JSON."),
        { error: { code: 500, message: "envelope error" } },
    ]) {
        let sent = 0;
        const published = [];
        const diagnostics = [];
        const result = await Duplex.generate(
            body(),
            async () => {
                if (++sent === 1) return reply(1, "第一段正文", false);
                if (failure instanceof Error) throw failure;
                return failure;
            },
            () => {},
            segment => published.push(segment),
            diagnostic => diagnostics.push(diagnostic)
        );
        assert.equal(sent, 2);
        assert.equal(textOf(result), "第一段正文");
        assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
        assert.deepEqual(published, [{ seq: 1, text: "第一段正文" }]);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].type, "interrupted");
        assert.equal(diagnostics[0].segments, 1);
        assert.equal(diagnostics[0].status, failure.status ?? failure.error?.code);
    }
    await assert.rejects(
        Duplex.generate(body(), async () => {
            throw Object.assign(new Error("Internal error"), { status: 500 });
        }),
        error => error.status === 500
    );
    let sent = 0;
    await assert.rejects(
        Duplex.generate(body(), async () => {
            if (++sent === 1) return reply(1, "accepted", false);
            throw Object.assign(new Error("Anti-truncation request cancelled."), { cancelled: true });
        }),
        error => error.cancelled === true
    );
});

test("buffered public APIs keep accepted text after a non-switching continuation error and never replay", async t => {
    for (const [api, method] of Object.entries(processors)) {
        for (const stream of [false, true]) {
            await t.test(`${api} stream=${stream}`, async () => {
                const h = requestHarness([
                    duplexReply("append_output", { seq: 1, text: "accepted" }),
                    { event_type: "error", message: "Internal error", status: 500 },
                ]);
                const res = new FakeResponse();
                await h.handler[method](apiRequest(api, "gemini-3.8-flash-抗截断", stream), res);
                assert.equal(res.statusCode, 200, res.output);
                assert.equal(visibleText(res, api, stream), "accepted");
                assert.equal(h.sent.length, 2);
                assert.deepEqual(h.switched, []);
                assert.ok(!res.output.includes("Internal error"));
                assert.equal(h.registry.messageQueues.size, 0);
            });
        }
    }
});

test("a hanging continuation times out only its own round and keeps the accepted prefix", async () => {
    let round = 0;
    const h = harness(queue => {
        if (++round > 1) return; // Never answers.
        queue.enqueue({ data: JSON.stringify(reply(1, "accepted", false)), event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    });
    const warnings = [];
    h.handler.logger = { info() {}, warn: message => warnings.push(message) };
    h.handler.timeouts.FAKE_STREAM = 30;
    await AntiTruncation.forward(h.handler, h.spec, 0);
    assert.equal((await h.parent.dequeue()).status, 200);
    const response = JSON.parse((await h.parent.dequeue()).data);
    assert.equal(textOf(response), "accepted");
    assert.equal(response.candidates[0].finishReason, "MAX_TOKENS");
    assert.equal((await h.parent.dequeue()).type, "STREAM_END");
    assert.deepEqual(h.cancelled, ["child-2"]);
    assert.equal(h.parent.closed, false);
    assert.equal(h.parent.listenerCount("close"), 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /parent: upstream round failed after 1 accepted segment\(s\) \(status 504/);
});

test("forwarding logs every rejected transport call with its reason", async () => {
    let round = 0;
    const h = harness(queue => {
        round++;
        const response = round === 1 ? duplexReply("append_output", { seq: 3, text: "gap" }) : reply(1, "fixed", true);
        queue.enqueue({ data: JSON.stringify(response), event_type: "chunk" });
        queue.enqueue({ type: "STREAM_END" });
    });
    const infos = [];
    const warnings = [];
    h.handler.logger = { info: message => infos.push(message), warn: message => warnings.push(message) };
    await AntiTruncation.forward(h.handler, h.spec, 0);
    assert.equal((await h.parent.dequeue()).status, 200);
    assert.equal(textOf(JSON.parse((await h.parent.dequeue()).data)), "fixed");
    assert.deepEqual(warnings, [
        "[AntiTruncation] parent: rejected transport call: out-of-order or conflicting output sequence",
    ]);
    assert.deepEqual(infos, ["[AntiTruncation] Retrying rejected transport call for parent"]);
});

test("done=true on an empty next segment or a repeated last segment confirms completion", async () => {
    for (const completion of [
        duplexReply("append_output", { done: true, seq: 2, text: "" }),
        duplexReply("append_output", { done: true, seq: 1, text: "全文" }),
    ]) {
        const { result, requests, published } = await runDuplex([
            duplexReply("append_output", { done: false, seq: 1, text: "全文" }),
            completion,
        ]);
        assert.equal(requests.length, 2);
        assert.equal(result.candidates[0].finishReason, "STOP");
        assert.equal(textOf(result), "全文");
        assert.deepEqual(published, [{ seq: 1, text: "全文" }]);
    }
    const empty = await runDuplex([duplexReply("append_output", { done: true, seq: 1, text: "" })]);
    assert.equal(empty.result.candidates[0].finishReason, "STOP");
    assert.equal(textOf(empty.result), "");
    // Only the last accepted segment can carry a late completion flag.
    const early = await runDuplex([
        duplexReply("append_output", { seq: 1, text: "A" }),
        duplexReply("append_output", { seq: 2, text: "B" }),
        duplexReply("append_output", { done: true, seq: 1, text: "A" }),
        duplexReply("finish_output", { last_seq: 2 }),
    ]);
    assert.equal(early.result.candidates[0].finishReason, "STOP");
    assert.match(early.requests[3].systemInstruction.parts.at(-1).text, /completion may only follow/);
});

test("model reasoning in history is dropped and text signatures are kept instead of rejecting the request", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const { googleRequest } = await converter.translateClaudeToGoogle({
        max_tokens: 100,
        messages: [
            { content: "first", role: "user" },
            {
                content: [
                    { signature: "sig", thinking: "private reasoning", type: "thinking" },
                    { text: "previous answer", type: "text" },
                ],
                role: "assistant",
            },
            { content: "second", role: "user" },
        ],
        model: "gemini-3.8-flash-抗截断",
    });
    const { request } = Duplex.prepare(googleRequest);
    assert.deepEqual(
        request.contents.map(turn => turn.parts.map(part => part.text)),
        [["first"], ["previous answer"], ["second"]]
    );
    const native = {
        contents: [
            { parts: [{ text: "q" }], role: "user" },
            { parts: [{ text: "only thoughts", thought: true }], role: "model" },
            { parts: [{ text: "a", thoughtSignature: "opaque" }], role: "model" },
            { parts: [{ text: "q2" }], role: "user" },
        ],
    };
    const snapshot = JSON.stringify(native);
    const prepared = Duplex.prepare(native).request;
    assert.equal(prepared.contents.length, 3);
    assert.deepEqual(prepared.contents[1].parts, [{ text: "a", thoughtSignature: "opaque" }]);
    assert.equal(JSON.stringify(native), snapshot);
    assert.throws(
        () => Duplex.prepare({ contents: [{ parts: [{ text: "x", thought: true }], role: "model" }] }),
        error => error.status === 400
    );
});

test("Claude multi-turn requests with thinking blocks complete through the public handler", async () => {
    const h = requestHarness(duplexTextReplies(["second answer"]));
    const res = new FakeResponse();
    await h.handler.processClaudeRequest(
        {
            body: {
                max_tokens: 100,
                messages: [
                    { content: "first", role: "user" },
                    {
                        content: [
                            { signature: "sig", thinking: "private reasoning", type: "thinking" },
                            { text: "first answer", type: "text" },
                        ],
                        role: "assistant",
                    },
                    { content: "second", role: "user" },
                ],
                model: "gemini-3.8-flash-抗截断",
                thinking: { budget_tokens: 1024, type: "enabled" },
            },
            headers: {},
            method: "POST",
            path: "/v1/messages",
            query: {},
        },
        res
    );
    assert.equal(res.statusCode, 200, res.output);
    assert.equal(visibleText(res, "claude", false), "second answer");
    assert.deepEqual(
        JSON.parse(h.sent[0].body).contents.map(turn => turn.parts.map(part => part.text)),
        [["first"], ["first answer"], ["second"]]
    );
    assert.equal(h.registry.messageQueues.size, 0);
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
