const test = require("node:test");
const assert = require("node:assert/strict");
const Weights = require("../src/core/Playground/Weights");
const Session = require("../src/core/Playground/Session");
const { EventEmitter } = require("node:events");

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });

test("weights adapt to model-specific errors and usage without creating quota cooldowns", () => {
    const weights = new Weights({});
    weights.start("argon", 1);
    weights.fail("argon", 1, { status: 403 });
    assert.ok(weights.snapshot("argon", 1).weight < weights.snapshot("argon", 2).weight);
    assert.equal(weights.snapshot("flash", 1).weight, 100);
    const failed = weights.snapshot("argon", 1).weight;
    weights.success("argon", 1, { totalTokenCount: 5 });
    assert.ok(weights.snapshot("argon", 1).weight > failed);
    weights.success("flash", 1, { totalTokenCount: 2000000 });
    assert.ok(weights.snapshot("flash", 1).weight < weights.snapshot("flash", 2).weight);
    assert.equal(weights.snapshot("argon", 1).cooldown, undefined);
});

test("weighted rotation prioritizes healthy accounts but keeps retry probes for low weights", () => {
    const weights = new Weights({});
    for (let i = 0; i < 10; i++) weights.fail("argon", 1, { status: 403 });
    const selected = [];
    for (let i = 0; i < 120; i++) {
        const ranked = weights.rank("argon", [1, 2]).sort((a, b) => b.priority - a.priority);
        selected.push(ranked[0].index);
        weights.commit("argon", [1, 2], ranked[0].index);
    }
    assert.equal(selected[0], 2);
    assert.ok(selected.filter(index => index === 2).length > 100);
    assert.ok(selected.includes(1), "the low-weight account can recover without a restart");
});

test("weights and scheduling credits reset at local midnight and restart, independent of persisted history", t => {
    let now = Date.parse("2026-11-12T15:59:59Z");
    t.mock.method(Date, "now", () => now);
    const source = {
        accountNameMap: new Map([
            [1, "same@example.com"],
            [2, "SAME@example.com"],
        ]),
    };
    const weights = new Weights(source, "Asia/Singapore");
    weights.start("argon", 1);
    weights.fail("argon", 1, { status: 403 });
    weights.commit("argon", [1], 1);
    assert.deepEqual(weights.snapshot("argon", 1), weights.snapshot("argon", 2));
    assert.equal(new Weights(source).snapshot("argon", 1).weight, 100);
    const oldDay = weights.snapshot("argon", 1).day;
    now += 1000;
    assert.equal(weights.snapshot("argon", 1).weight, 100);
    assert.equal(weights.snapshot("argon", 1).attemptsToday, 0);
    assert.notEqual(weights.snapshot("argon", 1).day, oldDay);
    assert.equal(weights.rank("argon", [1])[0].priority, 100);
});

test("temporary errors decay and invalid requests do not penalize account weights", t => {
    let now = Date.parse("2026-11-12T01:00:00Z");
    t.mock.method(Date, "now", () => now);
    const weights = new Weights({});
    weights.fail("flash", 1, { status: 400 });
    weights.fail("flash", 1, { status: 499 });
    weights.fail("flash", 1, { status: 502, invalidToolResponse: true });
    assert.equal(weights.snapshot("flash", 1).weight, 100);
    weights.fail("flash", 1, { status: 503 });
    const previous = weights.snapshot("flash", 1).weight;
    now += 300000;
    assert.ok(weights.snapshot("flash", 1).weight > previous);
});

test("idle generation pages close while account contexts remain reusable", async () => {
    const context = new EventEmitter();
    const session = new Session(context, () => {}, { idleMs: 15 });
    let pages = 0;
    let closed = 0;
    session._request = async () => {
        if (!session.page) {
            pages++;
            session.page = { isClosed: () => false, close: async () => closed++ };
        }
    };
    await session.request("flash", {}, options());
    await tick(30);
    assert.equal(closed, 1);
    assert.equal(session.page, null);
    await session.request("flash", {}, options());
    assert.equal(pages, 2);
    context.emit("close");
    await tick(30);
    assert.equal(closed, 1, "context shutdown cancels the idle timer");
});

test("idle cleanup cannot close an active or queued operation, including cancelled waiters", async () => {
    const context = new EventEmitter();
    const session = new Session(context, () => {}, { idleMs: 10 });
    let finish;
    let closed = 0;
    let operations = 0;
    session.page = { isClosed: () => false, close: async () => closed++ };
    session._request = () => {
        operations++;
        return new Promise(resolve => {
            finish = resolve;
        });
    };
    const first = session.request("flash", {}, options());
    await tick(0);
    const controller = new AbortController();
    const second = session.request("flash", {}, { ...options(), signal: controller.signal });
    const rejected = assert.rejects(second, /cancelled/);
    controller.abort();
    await rejected;
    await tick(30);
    assert.equal(closed, 0);
    finish();
    await first;
    await tick(30);
    assert.equal(operations, 1);
    assert.equal(closed, 1);
    context.emit("close");
});
