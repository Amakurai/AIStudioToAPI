const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AntiTruncation = require("../src/core/AntiTruncation");
const ReasoningSplitter = require("../src/core/ReasoningSplitter");
const MessageQueue = require("../src/utils/MessageQueue");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

// The reported SillyTavern leak: the model quotes the output format inside its own thinking.
const LEAKED = [
    "<thinking>",
    "Phase 1: 规划输出",
    "1. `<thinking>...</thinking>` 工作日志（开头）",
    "2. `<content>...</content>` 正文（包含时间框）",
    "Phase: 思考结束",
    "我已思考完毕。——宣誓人YU",
    "</thinking>",
    "",
    "〖2026.05.27 周三 17:16p.m〗",
    "红底金线的和服领口松开了小半寸。",
].join("\n");

// Joins streamed pieces by kind, as a client would show them.
const joined = pieces => ({
    answer: pieces
        .filter(piece => !piece.thought)
        .map(piece => piece.text)
        .join(""),
    reasoning: pieces
        .filter(piece => piece.thought)
        .map(piece => piece.text)
        .join(""),
});

test("a closing tag quoted inside the thinking does not end the reasoning block", () => {
    const split = ReasoningSplitter.split(LEAKED);
    assert.equal(split.answer, "〖2026.05.27 周三 17:16p.m〗\n红底金线的和服领口松开了小半寸。");
    assert.ok(split.reasoning.startsWith("Phase 1: 规划输出\n"));
    assert.ok(split.reasoning.includes("`<thinking>...</thinking>` 工作日志（开头）"));
    assert.ok(split.reasoning.endsWith("——宣誓人YU\n"));
    assert.doesNotMatch(split.answer, /thinking|宣誓人/);
});

test("quoted mentions are recognised by a same-line opening tag or a preceding backtick", () => {
    for (const [text, reasoning, answer] of [
        // A tag pair on one line, without backticks.
        [
            "<thinking>格式：<thinking>思考</thinking>后接正文\n结束</thinking>正文",
            "格式：<thinking>思考</thinking>后接正文\n结束",
            "正文",
        ],
        // A closing tag quoted on its own.
        ["<thinking>用`</thinking>`结束思考\n好</thinking>\n\n正文", "用`</thinking>`结束思考\n好", "正文"],
        // An opening tag mentioned on an earlier line does not swallow the real close.
        ["<thinking>先写<thinking>标签\n想好了\n</thinking>\n正文", "先写<thinking>标签\n想好了\n", "正文"],
        // The <think> spelling, on the same line as the block itself.
        ["  \n<think>短思考</think>答案</thinking>", "短思考", "答案</thinking>"],
        // Only the leading block is reasoning; later tags are answer text.
        ["<thinking>a</thinking>\n正文里提到<thinking>标签", "a", "正文里提到<thinking>标签"],
    ]) {
        assert.deepEqual(ReasoningSplitter.split(text), { answer, reasoning }, text);
    }
});

test("replies without a leading block stay byte-for-byte; an unclosed block is all reasoning", () => {
    for (const text of ["\n  正文<thinking>x</thinking>", "<thinkingx>正文", "正文", "", "  ", "<thi"]) {
        assert.equal(ReasoningSplitter.split(text), null, text);
        const splitter = new ReasoningSplitter();
        assert.equal(
            [...splitter.push(text.slice(0, 2)), ...splitter.push(text.slice(2), true)].map(p => p.text).join(""),
            text
        );
    }
    assert.deepEqual(ReasoningSplitter.split("<thinking>\n还没想完"), { answer: "", reasoning: "还没想完" });
});

test("streamed pieces match the complete split for every chunk boundary", () => {
    const texts = [
        LEAKED,
        "<think>想</think>答",
        "<thinking>用`</thinking>`结束\n</thinking>\n\n 正文 🙂",
        "<thinking>未闭合</thi",
        "plain 🙂 text",
    ];
    for (const text of texts) {
        const expected = ReasoningSplitter.split(text) ?? { answer: text, reasoning: "" };
        for (let a = 0; a <= text.length; a++) {
            for (const b of [a, Math.min(text.length, a + 1), Math.min(text.length, a + 7)]) {
                const splitter = new ReasoningSplitter();
                const pieces = [
                    ...splitter.push(text.slice(0, a)),
                    ...splitter.push(text.slice(a, b)),
                    ...splitter.push(text.slice(b), true),
                ];
                assert.deepEqual(joined(pieces), expected, `${JSON.stringify(text)} split at ${a}/${b}`);
                // Reasoning never follows answer text.
                const firstAnswer = pieces.findIndex(piece => !piece.thought);
                assert.ok(firstAnswer < 0 || pieces.slice(firstAnswer).every(piece => !piece.thought));
            }
        }
    }
});

test("a partial closing tag is held back until it can be decided", () => {
    const splitter = new ReasoningSplitter();
    assert.deepEqual(splitter.push("<thinking>想法</thi"), [{ text: "想法", thought: true }]);
    assert.deepEqual(splitter.push("nking>正文"), [{ text: "正文" }]);
    const pending = new ReasoningSplitter();
    assert.deepEqual(pending.push(" <thin"), []);
    assert.deepEqual(pending.push("king>"), []);
    assert.deepEqual(pending.push("想"), [{ text: "想", thought: true }]);
});

// One signed append_output turn per text, then completion.
const segmentReply = (seq, text, done) => ({
    candidates: [
        {
            content: {
                parts: [{ functionCall: { args: { done, seq, text }, name: "append_output" }, thoughtSignature: "s" }],
                role: "model",
            },
            finishReason: "STOP",
        },
    ],
    usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 7, totalTokenCount: 10 },
});
const segmentReplies = texts => texts.map((text, i) => segmentReply(i + 1, text, i === texts.length - 1));
// The leaked reply, delivered across segments that cut through the quoted and the real closing tag.
const LEAKED_SEGMENTS = [
    LEAKED.slice(0, LEAKED.indexOf("</thinking>`") + 4),
    LEAKED.slice(LEAKED.indexOf("</thinking>`") + 4, LEAKED.indexOf("\n</thinking>") + 5),
    LEAKED.slice(LEAKED.indexOf("\n</thinking>") + 5),
];

function forwardHarness(responses, spec = {}, config) {
    const parent = new MessageQueue();
    const entries = new Map([["parent", { authIndex: 0, queue: parent }]]);
    let round = 0;
    const infos = [];
    const handler = {
        _cancelBrowserRequest() {},
        _createImmediateSwitchTracker: authIndex => ({ attemptedAuthIndices: new Set([authIndex]) }),
        _forwardRequest(child) {
            const queue = entries.get(child.request_id).queue;
            queue.enqueue({ data: JSON.stringify(responses[round++]), event_type: "chunk" });
            queue.enqueue({ type: "STREAM_END" });
        },
        _generateRequestAttemptId: id => `${id}-attempt`,
        _generateRequestId: () => `child-${round}`,
        _getUsageStatsService: () => null,
        authSwitcher: { incrementUsageCount() {}, shouldSwitchByUsage: () => false },
        config,
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
        logger: { info: message => infos.push(message), warn() {} },
        timeouts: { FAKE_STREAM: 1000 },
    };
    return {
        handler,
        infos,
        parent,
        spec: {
            anti_truncation: true,
            body: JSON.stringify({ contents: [{ parts: [{ text: "继续" }], role: "user" }] }),
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
            request_id: "parent",
            ...spec,
        },
    };
}

async function drain(queue) {
    const events = [];
    for (;;) {
        const event = await queue.dequeue(1000);
        events.push(event);
        if (event.type === "STREAM_END" || event.event_type === "error") return events;
    }
}

test("forwarding streams reasoning segments first and returns the block as a thought part", async () => {
    const h = forwardHarness(segmentReplies(LEAKED_SEGMENTS), { anti_truncation_segments: true });
    await AntiTruncation.forward(h.handler, h.spec, 0);
    const events = await drain(h.parent);
    const segments = events.filter(event => event.event_type === "tool_output");
    assert.deepEqual(
        segments.map(segment => segment.seq),
        segments.map((_, i) => i + 1)
    );
    const expected = ReasoningSplitter.split(LEAKED);
    assert.deepEqual(joined(segments), expected);
    const response = JSON.parse(events.find(event => event.event_type === "chunk").data);
    assert.deepEqual(response.candidates[0].content.parts, [
        { text: expected.reasoning, thought: true },
        { text: expected.answer },
    ]);
    assert.equal(response.candidates[0].finishReason, "STOP");
    assert.ok(h.infos.some(message => message.includes("leading thinking block as reasoning")));
});

test("tool output and ANTI_TRUNCATION_SPLIT_THINKING=false keep the block in the reply text", async () => {
    for (const [spec, config] of [
        [{ anti_truncation_output: "tools", anti_truncation_segments: true }, undefined],
        [{ anti_truncation_segments: true }, { antiTruncationSplitThinking: false }],
    ]) {
        const h = forwardHarness(segmentReplies(LEAKED_SEGMENTS), spec, config);
        await AntiTruncation.forward(h.handler, h.spec, 0);
        const events = await drain(h.parent);
        const segments = events.filter(event => event.event_type === "tool_output");
        assert.ok(segments.every(segment => !segment.thought));
        assert.equal(segments.map(segment => segment.text).join(""), LEAKED);
        const response = JSON.parse(events.find(event => event.event_type === "chunk").data);
        assert.deepEqual(response.candidates[0].content.parts, [{ text: LEAKED }]);
    }
    const previous = process.env.ANTI_TRUNCATION_SPLIT_THINKING;
    try {
        const ConfigLoader = require("../src/utils/ConfigLoader");
        process.env.ANTI_TRUNCATION_SPLIT_THINKING = "false";
        assert.equal(new ConfigLoader(logger).loadConfiguration().antiTruncationSplitThinking, false);
        delete process.env.ANTI_TRUNCATION_SPLIT_THINKING;
        assert.equal(new ConfigLoader(logger).loadConfiguration().antiTruncationSplitThinking, true);
    } finally {
        if (previous === undefined) delete process.env.ANTI_TRUNCATION_SPLIT_THINKING;
        else process.env.ANTI_TRUNCATION_SPLIT_THINKING = previous;
    }
});

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

function handlerFor(responses, extraConfig = {}) {
    const registry = new ConnectionRegistry(logger);
    const config = {
        fakeStreamTimeoutMs: 1000,
        immediateSwitchStatusCodes: [429],
        maxRetries: 3,
        retryDelay: 1,
        streamingMode: "real",
        switchOnUses: 0,
        ...extraConfig,
    };
    const handler = new RequestHandler({ config }, registry, logger, { currentAuthIndex: 0 }, config, {});
    handler._ensureBrowserBackedRequestReady = async () => true;
    handler._selectDispatchAuthIndex = () => 0;
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    let sent = 0;
    registry.connectionsByAuth.set(0, {
        send(data) {
            const spec = JSON.parse(data);
            if (spec.event_type === "cancel_request") return;
            const queue = registry.messageQueues.get(spec.request_id).queue;
            queue.enqueue({ event_type: "response_headers", status: 200 });
            queue.enqueue({ data: JSON.stringify(responses[sent++]), event_type: "chunk" });
            queue.enqueue({ type: "STREAM_END" });
        },
    });
    return handler;
}

const chatRequest = (model, stream) => ({
    body: { max_tokens: 4096, messages: [{ content: "继续", role: "user" }], model, stream },
    headers: {},
    method: "POST",
    path: "/v1/chat/completions",
    query: {},
});
const sseEvents = output =>
    output
        .split("\n")
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)));

test("OpenAI clients receive the thinking block as reasoning_content in every output mode", async t => {
    const expected = ReasoningSplitter.split(LEAKED);
    for (const [label, stream, mode] of [
        ["non-stream", false, "real"],
        ["real stream", true, "real"],
        ["fake stream", true, "fake"],
    ]) {
        await t.test(label, async () => {
            const handler = handlerFor(segmentReplies(LEAKED_SEGMENTS), { antiTruncationStreamingMode: mode });
            const res = new FakeResponse();
            await handler.processOpenAIRequest(chatRequest("gemini-3.8-flash-抗截断", stream), res);
            assert.equal(res.statusCode, 200, res.output);
            if (!stream) {
                const message = JSON.parse(res.output).choices[0].message;
                assert.equal(message.content, expected.answer);
                assert.equal(message.reasoning_content, expected.reasoning);
                return;
            }
            const deltas = sseEvents(res.output).map(event => event.choices?.[0]?.delta || {});
            assert.equal(deltas.map(delta => delta.reasoning_content || "").join(""), expected.reasoning);
            assert.equal(deltas.map(delta => delta.content || "").join(""), expected.answer);
            const lastReasoning = deltas.findLastIndex(delta => delta.reasoning_content);
            const firstAnswer = deltas.findIndex(delta => delta.content);
            assert.ok(lastReasoning < firstAnswer, "reasoning streams before the answer");
        });
    }
});

test("Claude clients receive the thinking block as a thinking content block", async () => {
    const expected = ReasoningSplitter.split(LEAKED);
    const handler = handlerFor(segmentReplies(LEAKED_SEGMENTS));
    const res = new FakeResponse();
    await handler.processClaudeRequest(
        {
            body: { max_tokens: 4096, messages: [{ content: "继续", role: "user" }], model: "gemini-3.8-flash-抗截断" },
            headers: {},
            method: "POST",
            path: "/v1/messages",
            query: {},
        },
        res
    );
    assert.equal(res.statusCode, 200, res.output);
    const content = JSON.parse(res.output).content;
    assert.equal(content.find(block => block.type === "thinking").thinking, expected.reasoning);
    assert.equal(content.find(block => block.type === "text").text, expected.answer);
});
