const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Scheduler = require("../src/core/Playground/Scheduler");
const Weights = require("../src/core/Playground/Weights");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { firefox } = require("playwright");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("parallel account preparation shares a single browser launch and can recover from launch failure", async t => {
    const pool = new BrowserManager(logger, { maxContexts: 0, playgroundEnabled: true }, {});
    pool._getBrowserExecutablePath = () => process.execPath;
    const browser = new EventEmitter();
    let launches = 0;
    const releases = [];
    const finish = () => releases.splice(0).forEach(resolve => resolve());
    let fail = false;
    t.mock.method(firefox, "launch", async () => {
        launches++;
        await new Promise(resolve => {
            releases.push(resolve);
        });
        if (fail) throw new Error("launch failed");
        return browser;
    });
    const first = pool._ensureBrowser();
    const second = pool._ensureBrowser();
    finish();
    await Promise.all([first, second]);
    assert.equal(launches, 1, "concurrent accounts must share the browser process");
    assert.equal(browser.listenerCount("disconnected"), 1);
    pool.browser = null;
    fail = true;
    const failed = pool._ensureBrowser();
    const failedAgain = pool._ensureBrowser();
    finish();
    await Promise.all([assert.rejects(failed, /launch failed/), assert.rejects(failedAgain, /launch failed/)]);
    fail = false;
    const recovered = pool._ensureBrowser();
    finish();
    await recovered;
    assert.equal(launches, 3, "a failed launch does not permanently block recovery");
});

test("shutdown waits for a pending browser launch instead of leaving an orphan process", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pool = new BrowserManager(logger, {}, {});
    let finish;
    let closes = 0;
    pool._launchBrowser = async () => {
        await new Promise(resolve => {
            finish = resolve;
        });
        pool.browser = {
            close: async () => {
                closes++;
            },
        };
    };
    const launched = pool._ensureBrowser();
    const closed = pool.closeBrowser();
    finish();
    await Promise.all([launched, closed]);
    assert.equal(closes, 1);
    assert.equal(pool.browser, null);
    assert.equal(pool.isClosingIntentionally, false);
});

test("a slow account startup cannot block dispatch to another ready account", async () => {
    const ready = new Set([1]);
    const source = { getAvailableRotationIndices: () => [0, 1], getCanonicalIndex: index => index };
    let finishStartup;
    const startup = new Promise(resolve => {
        finishStartup = resolve;
    });
    const handler = {
        authSwitcher: { isSystemBusy: false },
        browserManager: {
            contexts: new Map([[1, {}]]),
            ensurePlaygroundContext: async index => {
                await startup;
                ready.add(index);
                return { success: true };
            },
        },
        config: { maxContexts: 0 },
        connectionRegistry: new ConnectionRegistry(logger),
        playground: { isCoolingDown: () => false, weights: new Weights(source) },
    };
    const scheduler = new Scheduler(handler);
    const scope = { _getReadyAuthIndices: () => [...ready], authSource: source, playgroundModel: "flash" };
    const cold = scheduler.select(scope, [1], () => true, "cold");
    await flush();
    let dispatched;
    const warm = scheduler
        .select(scope, [], () => true, "warm")
        .then(index => {
            dispatched = index;
            return index;
        });
    await flush();
    try {
        assert.equal(dispatched, 1, "a healthy slot must dispatch before the slow startup finishes");
    } finally {
        finishStartup();
        await Promise.all([cold, warm]);
    }
    assert.equal(scheduler.reservations.get("cold"), 0);
    assert.equal(scheduler.reservations.get("warm"), 1);
});

test("Build reconnects preserve active Playground queues; closing an account still cancels both", async t => {
    for (const event of ["reconnect", "grace_timeout", "page_closed"]) {
        await t.test(event, async t => {
            const registry = new ConnectionRegistry(logger);
            const build = registry.createMessageQueue("build", 0);
            const playground = registry.createMessageQueue("pg", 0);
            registry.messageQueues.get("pg").channel = "playground";
            const socket = new EventEmitter();
            socket._authIndex = 0;
            if (event === "reconnect") registry.addConnection(socket, { address: "test", authIndex: 0 });
            else if (event === "grace_timeout") {
                t.mock.timers.enable({ apis: ["setTimeout"] });
                registry._removeConnection(socket);
                t.mock.timers.tick(10000);
            } else {
                registry.browserManager = { contexts: new Map([[0, { page: { isClosed: () => true } }]]) };
                registry._removeConnection(socket);
            }
            assert.equal(build.closed, true);
            assert.equal(playground.closed, false, "a separate generation page does not depend on the Build socket");
            playground.enqueue({ data: "still generating" });
            assert.equal((await playground.dequeue()).data, "still generating");
            registry.closeMessageQueuesForAuth(0, "context_closed");
            assert.equal(playground.closed, true, "closing the shared account context must still cancel generation");
            assert.equal(registry.messageQueues.size, 0);
        });
    }
});

test("Playground recreates a closed idle login window, but preserves an account still serving a request", async () => {
    const source = { getRotationIndices: () => [0, 1] };
    const pool = new BrowserManager(logger, { maxContexts: 0, playgroundEnabled: true }, source);
    const registry = new ConnectionRegistry(logger);
    pool.connectionRegistry = registry;
    pool.browser = {};
    let closed = 0;
    let initialized = 0;
    const dead = {
        context: {
            close: async () => {
                closed++;
            },
        },
        page: { isClosed: () => true },
    };
    pool.contexts.set(0, dead);
    pool.contexts.set(1, { page: { isClosed: () => false } });
    pool._ensureBrowser = async () => {};
    pool._initializeContext = async index => {
        initialized++;
        pool.contexts.set(index, { page: { isClosed: () => false } });
    };
    const active = registry.createMessageQueue("still-active", 0);
    registry.messageQueues.get("still-active").channel = "playground";
    assert.equal((await pool.ensurePlaygroundContext(0)).success, false);
    assert.equal(active.closed, false);
    assert.equal(initialized, 0);
    registry.removeMessageQueue("still-active");
    assert.equal((await pool.ensurePlaygroundContext(0)).success, true);
    assert.equal(closed, 1);
    assert.equal(initialized, 1);
    assert.equal(pool.contexts.get(0).page.isClosed(), false);
    assert.equal(pool.initializingContexts.size, 0);
});
