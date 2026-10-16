const test = require("node:test");
const assert = require("node:assert/strict");
const AntiTruncation = require("../src/core/AntiTruncation");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("detaching the last busy anti-truncation queue cannot initialize a replacement on a closing browser", async () => {
    const cooling = new Set([0]);
    const source = {
        getAvailableRotationIndices: () => [0, 1].filter(index => !cooling.has(index)),
        getCanonicalIndex: index => index,
        getRotationIndices: () => [0, 1],
        isAccountCoolingDown: index => cooling.has(index),
        isExpired: () => false,
        markAccountCoolingDown: index => cooling.add(index),
    };
    const config = {
        fakeStreamTimeoutMs: 1000,
        immediateSwitchStatusCodes: [429],
        maxContexts: 1,
        switchOnUses: 0,
    };
    const registry = new ConnectionRegistry(logger);
    const pool = new BrowserManager(logger, config, source);
    pool.setConnectionRegistry(registry);
    const handler = new RequestHandler({ config }, registry, logger, pool, config, source);
    pool.setSystemBusyProvider(() => handler.authSwitcher.isSystemBusy);
    // The older request has already caused account 0 to retire, but this request still owns it.
    pool.currentAuthIndex = 0;
    pool.contexts.set(0, { context: { async close() {} }, page: { isClosed: () => false } });
    pool.pendingContextClosures.set(0, "rebalance");
    let finishBrowserClose;
    pool.browser = {
        close: () =>
            new Promise(resolve => {
                finishBrowserClose = resolve;
            }),
    };
    // Avoid page initialization machinery; retain real browser close/switch/queue lifecycle methods.
    const closingInitializations = [];
    pool._initializeContext = async index => {
        try {
            if (pool.isClosingIntentionally) {
                closingInitializations.push(index);
                throw new Error("browser.newContext: Target browser has been closed");
            }
            const contextData = { context: {}, page: { isClosed: () => false } };
            pool.contexts.set(index, contextData);
            return contextData;
        } finally {
            pool.initializingContexts.delete(index);
        }
    };
    pool._activateContext = (context, page, index) => {
        pool.context = context;
        pool.page = page;
        pool.currentAuthIndex = index;
    };
    pool._preloadBackgroundContexts = async () => {};
    handler._waitForSystemAndConnectionIfBusy = async () => true;
    const sent = [];
    handler._forwardRequest = (spec, index) => {
        sent.push(index);
        const queue = registry.messageQueues.get(spec.request_id).queue;
        if (index === 0) queue.enqueue({ event_type: "error", message: "rate limited", status: 429 });
        else {
            queue.enqueue({
                data: JSON.stringify({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        functionCall: {
                                            args: { done: true, seq: 1, text: "recovered" },
                                            name: "append_output",
                                        },
                                    },
                                ],
                                role: "model",
                            },
                            finishReason: "STOP",
                        },
                    ],
                }),
                event_type: "chunk",
            });
            queue.enqueue({ type: "STREAM_END" });
        }
    };
    handler._cancelBrowserRequest = () => {};
    for (const index of [0, 1]) registry.connectionsByAuth.set(index, { readyState: 1 });
    const parent = registry.createMessageQueue("parent", 0);
    try {
        await AntiTruncation.forward(
            handler,
            {
                body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }], role: "user" }] }),
                path: "/v1beta/models/gemini-3.8-flash:generateContent",
                request_id: "parent",
            },
            0
        );
        assert.deepEqual(closingInitializations, [], "replacement initialization raced with browser.close()");
        assert.deepEqual(sent, [0, 1]);
        assert.equal((await parent.dequeue()).status, 200);
    } finally {
        finishBrowserClose?.();
        registry.removeMessageQueue("parent");
        await new Promise(resolve => setImmediate(resolve));
    }
});

test("empty-browser recycling still runs once account switching and detached requests finish", async t => {
    for (const contextExists of [false, true]) {
        for (const protection of ["idle", "switching", "detached request"]) {
            await t.test(`${protection}, contextExists=${contextExists}`, async () => {
                const registry = new ConnectionRegistry(logger);
                const pool = new BrowserManager(logger, { maxContexts: 1 }, {});
                pool.setConnectionRegistry(registry);
                let busy = protection === "switching";
                pool.setSystemBusyProvider(() => busy);
                const browser = {};
                pool.browser = browser;
                if (contextExists) pool.contexts.set(0, { context: { async close() {} } });
                if (protection === "detached request") {
                    const parent = registry.createMessageQueue("parent", 0);
                    registry.setMessageQueueAuthIndex("parent", null, parent);
                }
                let browserCloses = 0;
                pool.closeBrowser = async () => {
                    browserCloses++;
                    pool.browser = null;
                    pool._cleanupAllContexts();
                };
                await pool.closeContext(0);
                assert.equal(pool.contexts.size, 0);
                if (protection !== "idle") {
                    assert.equal(browserCloses, 0);
                    assert.equal(pool.browser, browser);
                    busy = false;
                    registry.removeMessageQueue("parent");
                    await pool.closeContext(0);
                }
                assert.equal(browserCloses, 1);
                assert.equal(pool.browser, null);
            });
        }
    }
});
