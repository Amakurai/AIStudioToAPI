const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Handler = require("../src/core/RequestHandler/ChatCompletionsHandler");
const FormatConverter = require("../src/core/FormatConverter");
const MessageQueue = require("../src/utils/MessageQueue");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
const frames = output =>
    output
        .split("\n\n")
        .filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map(line => JSON.parse(line.slice(6)));
class Response extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.output = "";
        this.headersSent = false;
        this.writableEnded = false;
        this.statusCode = 200;
        this.socket = { destroyed: false, writable: true };
    }
    status(code) {
        this.statusCode = code;
        return this;
    }
    set(headers) {
        Object.assign(this.headers, headers);
        return this;
    }
    type(type) {
        this.headers["Content-Type"] = type;
        return this;
    }
    write(text) {
        this.headersSent = true;
        this.output += text;
        return true;
    }
    end() {
        this.writableEnded = true;
    }
    send(text) {
        this.write(text);
        this.end();
        return this;
    }
}
function harness() {
    const queue = new MessageQueue(120000);
    const response = new Response();
    let release;
    const firstMessage = new Promise(resolve => {
        release = resolve;
    });
    const handler = Object.assign(Object.create(Handler.prototype), {
        _ensureBrowserBackedRequestReady: async () => true,
        _executeRequestWithRetries: () => firstMessage,
        _finalizeTrackedRequest() {},
        _generateRequestId: () => "heartbeat-test",
        _handleFinalFailureAccountSwitch() {},
        _initializeProxyRequestAttempt() {},
        _logFinalRequestFailure() {},
        _markTrackedResponseError(_res, message, status) {
            response.error = { message, status };
        },
        _selectDispatchAuthIndex: () => 1,
        _sendErrorResponse(res, status, message) {
            res.status(status).send(JSON.stringify({ error: { message } }));
        },
        _setResponseApiFormat(res) {
            res.__responseApiFormat = "openai";
        },
        _setupClientDisconnectHandler() {},
        _startTrackedRequest() {},
        _updateTrackedRequest() {},
        authSwitcher: { failureCount: 0, incrementUsageCount: () => 0 },
        config: { streamingMode: "fake" },
        connectionRegistry: { createMessageQueue: () => queue, removeMessageQueue: () => queue.close() },
        formatConverter: new FormatConverter(logger, { config: {} }),
        logger,
        timeouts: { FAKE_STREAM: 120000 },
    });
    const run = (stream = true) =>
        handler.processOpenAIRequest(
            {
                body: {
                    messages: [{ content: "Hi", role: "user" }],
                    model: "gemini-4-argon",
                    stream,
                },
            },
            response
        );
    const complete = (text = "Hello") => {
        queue.enqueue({
            data: JSON.stringify({
                candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }],
                usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 3, totalTokenCount: 5 },
            }),
            event_type: "chunk",
        });
        queue.enqueue({ type: "STREAM_END" });
    };
    return { complete, handler, queue, release, response, run };
}

test("fake streaming survives a data-only relay while waiting for headers and the full body", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const task = h.run();
    await settle();
    assert.equal(h.response.headersSent, false, "quick failures must still use their HTTP status");
    t.mock.timers.tick(18000);
    const opening = frames(h.response.output);
    assert.equal(opening.length, 2);
    // Model New API's data-only, one-frame-delayed relay: the second frame releases the first.
    const relayed = opening.slice(0, -1);
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0].choices[0].delta.content, "");
    assert.equal(relayed[0].choices[0].finish_reason, null);
    assert.equal(relayed[0].usage, undefined);
    assert.equal(h.response.headers["X-Accel-Buffering"], "no");
    h.release({ queue: h.queue, success: true });
    await settle();
    t.mock.timers.tick(18000);
    assert.ok(frames(h.response.output).length >= 4, "heartbeats stopped after upstream headers");
    // The full response may take longer than a common 60-second outer gateway timeout.
    t.mock.timers.tick(36000);
    h.complete();
    await task;
    const events = frames(h.response.output);
    assert.equal(new Set(events.map(frame => frame.id)).size, 1);
    assert.equal(events.map(frame => frame.choices[0].delta.content || "").join(""), "Hello");
    assert.equal(events.at(-1).choices[0].finish_reason, "stop");
    assert.equal(events.at(-1).usage.total_tokens, 5);
    assert.ok(h.response.output.endsWith("data: [DONE]\n\n"));
    const before = h.response.output;
    t.mock.timers.tick(18000);
    assert.equal(h.response.output, before, "a heartbeat was sent after completion");
});

test("quick fake-stream errors retain HTTP status and never emit successful data", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const task = h.run();
    h.release({ error: { message: "invalid schema", status: 400 }, success: false });
    await task;
    assert.equal(h.response.statusCode, 400);
    assert.equal(frames(h.response.output).length, 0);
    const before = h.response.output;
    t.mock.timers.tick(18000);
    assert.equal(h.response.output, before);
});

test("a late upstream failure keeps its error code after heartbeat data", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const task = h.run();
    h.release({ queue: h.queue, success: true });
    await settle();
    t.mock.timers.tick(18000);
    h.queue.enqueue({ event_type: "error", message: "upstream deadline", status: 504 });
    await task;
    assert.equal(frames(h.response.output).at(-1).error.code, 504);
    assert.equal(h.response.error.status, 504);
    assert.ok(!h.response.output.includes('"finish_reason":"stop"'));
});

test("non-stream requests stay silent while waiting and return ordinary JSON", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    const task = h.run(false);
    h.release({ queue: h.queue, success: true });
    await settle();
    t.mock.timers.tick(72000);
    assert.equal(h.response.output, "");
    h.complete();
    await task;
    assert.equal(JSON.parse(h.response.output).choices[0].message.content, "Hello");
});

test("paced fake output preserves HTML, Unicode, reasoning, tool arguments and final usage", async () => {
    const h = harness();
    const text = "```html\n<div>你好💙</div>\n".repeat(25) + "```";
    const data = {
        candidates: [
            {
                content: {
                    parts: [
                        { text: "brief reasoning", thought: true },
                        { text },
                        { functionCall: { args: { text: 'quote \\" and newline\n💙' }, id: "call-1", name: "lookup" } },
                    ],
                },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 3, totalTokenCount: 5 },
    };
    const converted = h.handler.formatConverter.translateGoogleToOpenAIStream(
        JSON.stringify(data),
        "gemini-4-argon",
        {}
    );
    assert.equal(await h.handler._writeOpenAIFakeStreamChunks(h.response, converted), true);
    const events = frames(h.response.output);
    assert.equal(events.map(f => f.choices[0].delta.content || "").join(""), text);
    assert.equal(events.map(f => f.choices[0].delta.reasoning_content || "").join(""), "brief reasoning");
    assert.ok(events.filter(f => f.choices[0].delta.content).length > 1);
    assert.ok(events.every(f => Array.from(f.choices[0].delta.content || "").length <= 128));
    const call = events.flatMap(f => f.choices[0].delta.tool_calls || []);
    assert.equal(call.length, 1);
    assert.equal(call[0].function.arguments, JSON.stringify(data.candidates[0].content.parts[2].functionCall.args));
    assert.equal(events.at(-1).choices[0].finish_reason, "tool_calls");
    assert.equal(events.at(-1).usage.total_tokens, 5);
});

test("disconnect during paced output stops subsequent frames", async () => {
    const h = harness();
    const converted = h.handler.formatConverter.translateGoogleToOpenAIStream(
        JSON.stringify({
            candidates: [{ content: { parts: [{ text: "x".repeat(400) }] }, finishReason: "STOP" }],
        }),
        "gemini-4-argon",
        {}
    );
    const write = h.response.write.bind(h.response);
    h.response.write = text => {
        write(text);
        h.response.end();
        return true;
    };
    assert.equal(await h.handler._writeOpenAIFakeStreamChunks(h.response, converted), false);
    assert.equal(frames(h.response.output).length, 1);
});
