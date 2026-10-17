const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const AuthSource = require("../src/auth/AuthSource");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const limited = () => ({ event_type: "error", message: "Quota exhausted", status: 429 });
const success = () => ({
    candidates: [{ content: { parts: [{ text: "recovered" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
});

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.headersSent = false;
        this.output = "";
        this.statusCode = 200;
        this.writableEnded = false;
        this.socket = { destroyed: false, writable: true };
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
        this.set(headers || {});
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

function harness({ available = [0, 1, 2], current = 0, ready = available, respond = () => success() } = {}) {
    // Avoid loading real credential files while exercising AuthSource's actual availability rules.
    const authSource = Object.assign(Object.create(AuthSource.prototype), {
        accountCooldowns: new Map(),
        accountNameMap: new Map(),
        availableIndices: available,
        canonicalIndexMap: new Map(available.map(index => [index, index])),
        rotationIndices: available,
    });
    const registry = new ConnectionRegistry(logger);
    const sent = [];
    const cancelled = [];
    const switched = [];
    const browser = {
        contexts: new Map(),
        currentAuthIndex: current,
        initializingContexts: new Set(),
        async launchOrSwitchContext(index) {
            await this.switchAccount(index);
        },
        notifyUserActivity() {},
        async preCleanupForSwitch() {},
        async rebalanceContextPool() {},
        async switchAccount(index) {
            switched.push(index);
            this.currentAuthIndex = index;
            addReadyAccount(index);
        },
    };
    function addReadyAccount(index) {
        browser.contexts.set(index, { page: { isClosed: () => false } });
        registry.connectionsByAuth.set(index, {
            readyState: 1,
            send(data) {
                const spec = JSON.parse(data);
                if (spec.event_type === "cancel_request") {
                    cancelled.push({ index, spec });
                    return;
                }
                sent.push({ index, spec });
                const queue = registry.messageQueues.get(spec.request_id).queue;
                // Fail deterministically if a regression loops back through attempted accounts forever.
                const response =
                    sent.length > available.length + 1
                        ? { event_type: "error", message: "retry loop", status: 400 }
                        : respond(index, spec, sent.length);
                if (response.event_type === "error") {
                    queue.enqueue(response);
                    return;
                }
                queue.enqueue({ event_type: "response_headers", headers: {}, status: 200 });
                const json = JSON.stringify(response);
                const streamed = spec.path.includes(":streamGenerateContent") && spec.streaming_mode === "real";
                queue.enqueue({ data: streamed ? `data: ${json}\n\n` : json, event_type: "chunk" });
                queue.enqueue({ type: "STREAM_END" });
            },
        });
    }
    for (const index of ready) addReadyAccount(index);
    const config = {
        fakeStreamTimeoutMs: 100,
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 1,
        retryDelay: 1,
        streamingMode: "real",
        switchOnUses: 0,
    };
    const handler = new RequestHandler({ config }, registry, logger, browser, config, authSource);
    return { authSource, browser, cancelled, handler, registry, sent, switched };
}

function rawRequest(h, sourceIndex) {
    const spec = {
        body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] }),
        is_generative: true,
        path: "/v1beta/models/gemini-3.8-flash:generateContent",
        request_id: `test-${h.sent.length}`,
        streaming_mode: "fake",
    };
    h.handler._initializeProxyRequestAttempt(spec);
    const queue = h.registry.createMessageQueue(spec.request_id, sourceIndex, spec.request_attempt_id);
    return { queue, spec };
}


test("ordinary requests honor retryable=false without repeating inference", async () => {
    const h = harness({respond:()=>({event_type:"error",message:"request cannot be retried",retryable:false,status:400})});
    h.handler.config.maxRetries=3;
    const {queue,spec}=rawRequest(h,0);
    try {
        const result=await h.handler._executeRequestWithRetries(spec,queue);
        assert.equal(result.success,false);
        assert.equal(result.error.status,400);
        assert.equal(h.sent.length,1,"a non-retryable request was dispatched again");
        assert.equal(result.error.skipAccountSwitch,true);
    } finally {h.registry.removeMessageQueue(spec.request_id);}
});

test("disconnect during retry backoff cannot dispatch another inference", async () => {
    const h = harness({respond:()=>({event_type:"error",message:"temporary upstream failure",status:502})});
    h.handler.config.maxRetries=3;
    h.handler.config.retryDelay=40;
    const {queue,spec}=rawRequest(h,0);
    const original=h.handler._advanceProxyRequestAttempt.bind(h.handler);
    let cancelled;
    h.handler._advanceProxyRequestAttempt=request=>{
        original(request);
        cancelled=setTimeout(()=>h.registry.removeMessageQueue(spec.request_id,"client_disconnect"),5);
    };
    try {
        const result=await h.handler._executeRequestWithRetries(spec,queue);
        assert.equal(result.success,false);
        assert.equal(h.sent.length,1,"the cancelled retry still reached the upstream transport");
        assert.equal(h.registry.messageQueues.size,0);
    } finally {clearTimeout(cancelled);h.registry.removeMessageQueue(spec.request_id);}
});

test("OpenAI stream preserves a late upstream error status",async()=>{
    const h=harness();
    const res=new FakeResponse();
    res.__responseApiFormat="openai";
    res.set("Content-Type","text/event-stream");
    const queue=h.registry.createMessageQueue("late-stream",0);
    queue.enqueue({event_type:"error",status:429,message:"upstream quota exhausted"});
    try {
        await h.handler._streamOpenAIResponse(queue,res,"gemini-3.8-flash","late-stream");
        assert.match(res.output,/"code":429/);
        assert.equal(res.__usageTrackingErrorStatus,429);
    }finally{h.registry.removeMessageQueue("late-stream");}
});

test("OpenAI nonstream preserves a late upstream error status",async()=>{
    const h=harness();
    const res=new FakeResponse();
    const queue=h.registry.createMessageQueue("late-nonstream",0);
    queue.enqueue({event_type:"error",status:504,message:"upstream timed out"});
    try {
        await h.handler._sendOpenAINonStreamResponse(queue,res,"gemini-3.8-flash","late-nonstream");
        assert.equal(res.statusCode,504);
        assert.equal(res.__usageTrackingErrorStatus,504);
    }finally{h.registry.removeMessageQueue("late-nonstream");}
});

test("real streaming honors a non-retryable 503 without switching accounts",async()=>{
    const h=harness({respond:()=>({event_type:"error",message:"do not retry",retryable:false,status:503})});
    const res=new FakeResponse();
    await h.handler.processOpenAIRequest({headers:{},method:"POST",path:"/v1/chat/completions",body:{
        model:"gemini-3.8-flash",messages:[{role:"user",content:"Hi"}],stream:true,
    }},res);
    assert.equal(res.statusCode,503);
    assert.equal(h.sent.length,1);
    assert.equal(h.switched.length,0);
    assert.equal(h.registry.messageQueues.size,0);
});

test("disconnect during recovery of an already-closed account queue cannot create a replacement",async()=>{
    const h=harness({current:1});
    h.handler.config.maxRetries=3;
    const {queue,spec}=rawRequest(h,0);
    const res=new FakeResponse();
    let calls=0;
    h.handler._forwardRequest=()=>{calls++;queue.close("context_closed");};
    h.handler._waitForSystemAndConnectionIfBusy=async()=>{res.destroyed=true;return true;};
    try {
        const result=await h.handler._executeRequestWithRetries(spec,queue,res);
        assert.equal(result.success,false);
        assert.equal(calls,1);
        assert.equal(h.registry.messageQueues.get(spec.request_id).queue,queue);
    }finally{h.registry.removeMessageQueue(spec.request_id);}
});

test("buffered OpenAI SSE preserves errors after successful response headers",async()=>{
    const h=harness();
    h.handler.config.streamingMode="fake";
    h.handler._forwardRequest=spec=>{
        const queue=h.registry.messageQueues.get(spec.request_id).queue;
        queue.enqueue({event_type:"response_headers",headers:{},status:200});
        queue.enqueue({event_type:"error",status:504,message:"generation timed out"});
    };
    const res=new FakeResponse();
    await h.handler.processOpenAIRequest({headers:{},method:"POST",path:"/v1/chat/completions",body:{
        model:"gemini-3.8-flash",messages:[{role:"user",content:"Hi"}],stream:true,
    }},res);
    assert.match(res.output,/"code":504/);
    assert.equal(res.__usageTrackingErrorStatus,504);
    assert.equal(h.registry.messageQueues.size,0);
});

test("invalid upstream error codes cannot become successful or invalid HTTP responses",async t=>{
    for(const status of [200,0,999,"invalid"]){
        await t.test(String(status),async()=>{
            const h=harness();const res=new FakeResponse();
            const queue=h.registry.createMessageQueue("bad-status",0);
            queue.enqueue({event_type:"error",status,message:"invalid upstream status"});
            try{
                await h.handler._sendOpenAINonStreamResponse(queue,res,"gemini-3.8-flash","bad-status");
                assert.equal(res.statusCode,500);
            }finally{h.registry.removeMessageQueue("bad-status");}
        });
    }
});
