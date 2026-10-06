const test = require("node:test");
const assert = require("node:assert/strict");
const AuthSource = require("../src/auth/AuthSource");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

function makePool(count = 6, maxContexts = 4) {
    class MemoryAuthSource extends AuthSource {
        _discoverAvailableIndices() {
            this.initialIndices = Array.from({ length: count }, (_, index) => index);
        }
        _getAuthContent(index) {
            return JSON.stringify({ accountName: `account${index}@example.com` });
        }
    }
    const source = new MemoryAuthSource(logger);
    const pool = new BrowserManager(logger, { maxContexts }, source);
    pool.browser = {};
    return { pool, source };
}

test("concurrent pool refills keep a single tracked initializer and abort waits for it", async () => {
    const { pool } = makePool();
    const releases = [];
    let active = 0;
    let maxActive = 0;
    pool._initializeContext = async index => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
            await new Promise(resolve => releases.push(resolve));
            pool._throwIfContextInitAborted(index, true);
            pool.contexts.set(index, {});
        } finally {
            active--;
            pool.initializingContexts.delete(index);
        }
    };

    const starts = [pool._preloadBackgroundContexts([1], 4), pool._preloadBackgroundContexts([2], 4)];
    await flush();
    const stopped = pool.abortBackgroundPreload();
    for (const release of releases) release();
    await Promise.all([...starts, stopped]);
    await flush();

    assert.equal(maxActive, 1, "overlapping refills must not orphan an initializer");
    assert.equal(pool.initializingContexts.size, 0);
    assert.equal(active, 0);
});

test("foreground cancellation also invalidates pool refills that have not started yet", async () => {
    const { pool } = makePool();
    const initialized = [];
    pool._initializeContext = async index => {
        initialized.push(index);
        pool.initializingContexts.delete(index);
    };

    const scheduled = pool._preloadBackgroundContexts([1], 4);
    await pool.abortBackgroundPreload();
    await scheduled;
    await pool._backgroundPreloadTask;
    assert.deepEqual(initialized, [], "a cancelled pending refill must not restart behind foreground cleanup");
});

test("429 retry reserves the selected fallback context before a rebalance can retire it", async () => {
    const { pool, source } = makePool();
    const registry = new ConnectionRegistry(logger);
    pool.connectionRegistry = registry;
    pool.currentAuthIndex = 2;
    for (const index of [0, 1, 2, 3]) {
        pool.contexts.set(index, { page: { isClosed: () => false } });
        registry.connectionsByAuth.set(index, { readyState: 1 });
    }
    const closed = [];
    pool.closeContext = async index => {
        assert.equal(registry.hasMessageQueueForAuth(index), false);
        closed.push(index);
        pool.contexts.delete(index);
    };
    // No browser startup is needed to exercise the real pool retirement policy.
    pool._preloadBackgroundContexts = async () => {};
    const config = { immediateSwitchStatusCodes: [429], maxRetries: 1 };
    const handler = new RequestHandler({ config }, registry, logger, pool, config, source);
    const queue = registry.createMessageQueue("pool-retry", 0);
    const tracker = handler._createImmediateSwitchTracker(0);

    try {
        const prepared = await handler._prepareImmediateStatusRetry({ status: 429 }, "pool-retry", tracker, 0);
        await flush();
        assert.equal(prepared, true);
        assert.equal(tracker.nextAuthIndex, 1);
        assert.equal(pool.contexts.has(1), true, "the chosen retry account must survive pool rotation");
        assert.equal(registry.getQueueCountForAuth(1), 1);
        assert.equal(pool.pendingContextClosures.has(1), true);
        assert.deepEqual(closed, [0]);
        assert.equal(queue.closed, false);
    } finally {
        registry.removeMessageQueue("pool-retry");
    }
});
