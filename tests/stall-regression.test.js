const test = require("node:test");
const assert = require("node:assert/strict");
const Registry = require("../src/core/ConnectionRegistry");
const Session = require("../src/core/Playground/Session");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("cleanup preserves an old active request until its actual consumer deadline", async () => {
    const registry = new Registry(logger);
    const queue = registry.createMessageQueue("long", 1);
    const entry = registry.messageQueues.get("long");
    entry.createdAt = Date.now() - 754000;
    const waiting = queue.dequeue(1800000);
    assert.equal(registry.cleanupStaleQueues(600000), 0);
    assert.equal(queue.closed, false);
    queue.enqueue({ type: "RESULT" });
    assert.deepEqual(await waiting, { type: "RESULT" });
    registry.removeMessageQueue("long", "test_complete");
});

test("cleanup still removes abandoned old queues", () => {
    const registry = new Registry(logger);
    const queue = registry.createMessageQueue("orphan", 1);
    registry.messageQueues.get("orphan").createdAt = Date.now() - 754000;
    assert.equal(registry.cleanupStaleQueues(600000), 1);
    assert.equal(queue.closeReason, "stale_cleanup");
});

test("expired waiters cannot disable stale cleanup", async () => {
    const registry = new Registry(logger);
    const queue = registry.createMessageQueue("expired", 1);
    registry.messageQueues.get("expired").createdAt = Date.now() - 754000;
    const waiting = queue.dequeue(1800000);
    const rejected = assert.rejects(waiting, /stale_cleanup/);
    queue.waitingResolvers[0].deadlineAt = Date.now() - 1;
    assert.equal(registry.cleanupStaleQueues(600000), 1);
    await rejected;
});

function fakePage() {
    let closed = false;
    return {
        async addLocatorHandler() {},
        async close() {
            closed = true;
        },
        getByRole() {
            return {
                async click() {},
                async fill() {},
                async isVisible() {
                    return false;
                },
                async waitFor() {},
            };
        },
        async goto() {},
        isClosed() {
            return closed;
        },
        locator(selector) {
            if (selector === "ms-upgrade-options-dialog")
                return { getByText: () => ({ first: () => ({ isVisible: async () => false }) }) };
            return { first: () => ({}) };
        },
        on() {},
        async route() {},
        url() {
            return "https://aistudio.google.com/prompts/new_chat";
        },
    };
}

test("a UI submission that never dispatches terminates and releases its account lock", async () => {
    const pages = [];
    const session = new Session(
        {
            async newPage() {
                const p = fakePage();
                pages.push(p);
                return p;
            },
        },
        () => {}
    );
    for (let i = 0; i < 2; i++) {
        const stages = [];
        await assert.rejects(
            session.request(
                "gemini-4-argon",
                {
                    contents: [{ parts: [{ text: "OK" }], role: "user" }],
                },
                { onData() {}, onStage: s => stages.push(s), signal: new AbortController().signal, timeoutMs: 20 }
            ),
            error => error.status === 504 && /before inference started/.test(error.message)
        );
        assert.deepEqual(stages, ["queued", "prepare_page", "submit_prompt"]);
        assert.equal(pages[i].isClosed(), true);
        assert.equal(session.capture, null);
    }
});

test("client cancellation interrupts submission without waiting for its deadline", async () => {
    const page = fakePage();
    const session = new Session(
        {
            async newPage() {
                return page;
            },
        },
        () => {}
    );
    const controller = new AbortController();
    const request = session.request(
        "gemini-4-argon",
        {
            contents: [{ parts: [{ text: "OK" }], role: "user" }],
        },
        {
            onData() {},
            onStage(stage) {
                if (stage === "submit_prompt") setImmediate(() => controller.abort());
            },
            signal: controller.signal,
            timeoutMs: 1800000,
        }
    );
    await assert.rejects(request, error => error.status === 499);
    await session.pending;
    assert.equal(page.isClosed(), true);
    assert.equal(session.capture, null);
});
