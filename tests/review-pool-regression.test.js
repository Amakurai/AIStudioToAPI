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

test("concurrent rebalance requests are coalesced without overlapping pool mutations", async () => {
    const { pool } = makePool();
    let release;
    let started;
    const running = new Promise(resolve => {
        started = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    pool._rebalanceContextPoolOnce = async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
            started();
            await new Promise(resolve => {
                release = resolve;
            });
        }
        active--;
    };
    const first = pool.rebalanceContextPool();
    await running;
    const others = Array.from({ length: 8 }, () => pool.rebalanceContextPool());
    release();
    await Promise.all([first, ...others]);
    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
});

test("a stale rebalance cannot close accounts needed by a newer rotation", async () => {
    const { pool } = makePool(4, 2);
    pool.currentAuthIndex = 0;
    for (const index of [0, 1, 2, 3]) pool.contexts.set(index, {});
    pool._preloadBackgroundContexts = async () => {};
    let release;
    let started;
    const closing = new Promise(resolve => {
        started = resolve;
    });
    const closed = [];
    pool.closeContext = async index => {
        closed.push(index);
        pool.contexts.delete(index);
        if (pool.currentAuthIndex === index) pool.currentAuthIndex = -1;
        if (index === 2) {
            started();
            await new Promise(resolve => {
                release = resolve;
            });
        }
    };
    const first = pool.rebalanceContextPool();
    await closing;
    pool.currentAuthIndex = 3;
    const second = pool.rebalanceContextPool();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(closed, [2, 1]);
    assert.equal(pool.currentAuthIndex, 3);
    assert.deepEqual([...pool.contexts.keys()].sort(), [0, 3]);
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

test("a background switch cannot close a fallback account already serving a retry", async () => {
    const { pool, source } = makePool(2, 2);
    const registry = new ConnectionRegistry(logger);
    pool.connectionRegistry = registry;
    pool.currentAuthIndex = 0;
    pool.contexts.set(0, { page: { isClosed: () => false } });
    pool.contexts.set(1, {
        page: {
            isClosed: () => false,
            title: async () => {
                throw new Error("temporary page inspection failure");
            },
            url: () => "https://aistudio.google.com/",
        },
    });
    for (const index of [0, 1]) registry.connectionsByAuth.set(index, { readyState: 1 });
    pool._updateAuthFile = async () => {};
    pool.preCleanupForSwitch = async () => {};
    pool.rebalanceContextPool = async () => {};
    pool._initializeContext = async () => {
        throw new Error("unexpected initialization");
    };
    const closed = [];
    pool.closeContext = async index => {
        closed.push(index);
        registry.closeMessageQueuesForAuth(index, "context_closed");
        pool.contexts.delete(index);
    };
    const originalSwitch = pool.switchAccount.bind(pool);
    let finish;
    const finished = new Promise(resolve => {
        finish = resolve;
    });
    pool.switchAccount = async index => {
        try {
            return await originalSwitch(index);
        } finally {
            finish();
        }
    };
    const config = { immediateSwitchStatusCodes: [429], maxRetries: 1 };
    const handler = new RequestHandler({ config }, registry, logger, pool, config, source);
    const queue = registry.createMessageQueue("active-retry", 0);
    const tracker = handler._createImmediateSwitchTracker(0);
    try {
        assert.equal(await handler._prepareImmediateStatusRetry({ status: 429 }, "active-retry", tracker, 0), true);
        await finished;
        assert.equal(queue.closed, false);
        assert.equal(registry.getAuthIndexForRequest("active-retry"), 1);
        assert.equal(pool.contexts.has(1), true);
        assert.deepEqual(closed, []);
    } finally {
        registry.removeMessageQueue("active-retry");
    }
});
