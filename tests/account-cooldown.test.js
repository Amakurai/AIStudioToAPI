const test = require("node:test");
const assert = require("node:assert/strict");
const AuthSource = require("../src/auth/AuthSource");
const AuthSwitcher = require("../src/auth/AuthSwitcher");
const BrowserManager = require("../src/core/BrowserManager");
const ConfigLoader = require("../src/utils/ConfigLoader");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function makeSource(records = [{ accountName: "a@example.com" }, { accountName: "b@example.com" }]) {
    // Exercise real auth validation and deduplication without reading production credentials.
    class MemoryAuthSource extends AuthSource {
        _discoverAvailableIndices() {
            this.initialIndices = records.map((_, index) => index);
        }
        _getAuthContent(index) {
            return JSON.stringify(records[index]);
        }
    }
    return new MemoryAuthSource(logger);
}

function makeSwitcher(source, currentAuthIndex) {
    const calls = [];
    const browser = {
        currentAuthIndex,
        async launchOrSwitchContext(index) {
            calls.push(["restart", index]);
            this.currentAuthIndex = index;
        },
        async preCleanupForSwitch(index) {
            calls.push(["cleanup", index]);
        },
        async rebalanceContextPool() {},
        async switchAccount(index) {
            calls.push(["switch", index]);
            this.currentAuthIndex = index;
        },
    };
    return { calls, switcher: new AuthSwitcher(logger, {}, source, browser) };
}

function makePool(source, indices, maxContexts) {
    const pool = new BrowserManager(logger, { maxContexts }, source);
    const busy = new Set();
    const closed = [];
    const initialized = [];
    pool.browser = {};
    pool.currentAuthIndex = indices[0] ?? -1;
    pool.contexts = new Map(indices.map(index => [index, {}]));
    pool.connectionRegistry = { hasMessageQueueForAuth: index => busy.has(index) };
    pool.closeContext = async index => {
        assert.ok(!busy.has(index), "active request must not be interrupted");
        closed.push(index);
        pool.pendingContextClosures.delete(index);
        pool.contexts.delete(index);
        if (pool.currentAuthIndex === index) pool.currentAuthIndex = -1;
    };
    pool._initializeContext = async index => {
        initialized.push(index);
        pool.contexts.set(index, {});
        pool.initializingContexts.delete(index);
        return {};
    };
    // Keep rebalancing deterministic while preserving the actual preload selection and capacity logic.
    pool._preloadBackgroundContexts = async (indices, cap) => {
        pool._backgroundPreloadTask = pool._executePreloadTask(indices, cap);
    };
    return { busy, closed, initialized, pool };
}

test("429 cooldown is shared by duplicate email files, survives reload, and expires", t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const source = makeSource([
        { accountName: " A@Example.com " },
        { accountName: "a@example.com" },
        { accountName: "b@example.com" },
    ]);
    assert.deepEqual(source.getRotationIndices(), [1, 2]);
    assert.equal(source.markAccountCoolingDown(0, 60000), true);
    source.reloadAuthSources(true);
    assert.equal(source.isAccountCoolingDown(1), true);
    assert.deepEqual(source.getAvailableRotationIndices(), [2]);
    assert.deepEqual(source.getRotationIndices(), [1, 2], "cooldown must not mark valid credentials as expired");
    assert.equal(source.markAccountCoolingDown(-1, 60000), false);
    now += 60000;
    assert.deepEqual(source.getAvailableRotationIndices(), [1, 2]);
    assert.deepEqual(source.expiredIndices, []);
});

test("a shorter concurrent cooldown cannot shorten an existing cooldown", t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const source = makeSource();
    source.markAccountCoolingDown(0, 60000);
    source.markAccountCoolingDown(0, 1000);
    now += 1001;
    assert.equal(source.isAccountCoolingDown(0), true);
});

test("a zero cooldown cannot immediately return a failed account to dispatch", () => {
    const source = makeSource();
    source.markAccountCoolingDown(0, 0);
    assert.equal(source.isAccountCoolingDown(0), true);
    assert.deepEqual(source.getAvailableRotationIndices(), [1]);
});

test("automatic switch uses the sole remaining account and does not restart a limited account", async () => {
    const source = makeSource();
    source.markAccountCoolingDown(0);
    const { calls, switcher } = makeSwitcher(source, 0);
    assert.equal((await switcher.switchToNextAuth({ excludeIndices: new Set([0]) })).newIndex, 1);
    assert.deepEqual(calls, [
        ["cleanup", 1],
        ["switch", 1],
    ]);
    source.markAccountCoolingDown(1);
    assert.equal((await switcher.switchToNextAuth()).success, false);
    assert.equal(calls.length, 2);
});

test("request exclusions cover duplicate auth files and never fall back to an excluded account", async () => {
    const source = makeSource([
        { accountName: "a@example.com" },
        { accountName: "a@example.com" },
        { accountName: "b@example.com" },
    ]);
    const { calls, switcher } = makeSwitcher(source, 2);
    assert.equal((await switcher.switchToNextAuth({ excludeIndices: [0, 2] })).success, false);
    assert.deepEqual(calls, []);
});

test("rebalancing replaces a limited non-current account with a spare", async () => {
    const source = makeSource([
        { accountName: "a@example.com" },
        { accountName: "b@example.com" },
        { accountName: "c@example.com" },
    ]);
    const { closed, initialized, pool } = makePool(source, [0, 1], 2);
    source.markAccountCoolingDown(1);
    await pool.rebalanceContextPool();
    await pool._backgroundPreloadTask;
    assert.deepEqual(closed, [1]);
    assert.deepEqual(initialized, [2]);
    assert.deepEqual([...pool.contexts.keys()], [0, 2]);
});

test("a busy limited account drains safely while its replacement loads", async () => {
    const source = makeSource([
        { accountName: "a@example.com" },
        { accountName: "b@example.com" },
        { accountName: "c@example.com" },
    ]);
    const { busy, closed, initialized, pool } = makePool(source, [0, 1], 2);
    busy.add(1);
    source.markAccountCoolingDown(1);
    await pool.rebalanceContextPool();
    await pool._backgroundPreloadTask;
    assert.deepEqual(closed, []);
    assert.deepEqual(initialized, [2]);
    assert.equal(pool.pendingContextClosures.has(1), true);
    busy.delete(1);
    await pool._closePendingContextIfIdle(1);
    assert.deepEqual(closed, [1]);
    assert.deepEqual([...pool.contexts.keys()], [0, 2]);
});

test("a limited current account cannot block pool replacement if switching did not complete", async () => {
    const source = makeSource();
    const { busy, closed, initialized, pool } = makePool(source, [0], 1);
    busy.add(0);
    source.markAccountCoolingDown(0);
    await pool.rebalanceContextPool();
    await pool._backgroundPreloadTask;
    assert.deepEqual(initialized, [1]);
    assert.deepEqual(closed, []);
    busy.delete(0);
    await pool._closePendingContextIfIdle(0);
    assert.deepEqual(closed, [0]);
    assert.deepEqual([...pool.contexts.keys()], [1]);
});

test("a sole limited current account releases its context and becomes eligible again after expiry", async t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const source = makeSource([{ accountName: "a@example.com" }]);
    const { closed, initialized, pool } = makePool(source, [0], 1);
    source.markAccountCoolingDown(0, 60000);
    await pool.rebalanceContextPool();
    assert.deepEqual(closed, [0]);
    assert.equal(pool.currentAuthIndex, -1);
    assert.deepEqual(initialized, []);
    now += 60000;
    await pool.rebalanceContextPool();
    await pool._backgroundPreloadTask;
    assert.deepEqual(initialized, [0]);
});

test("draining replacements cannot grow the pool past twice its configured size", async () => {
    const source = makeSource(Array.from({ length: 6 }, (_, index) => ({ accountName: `a${index}@example.com` })));
    const { busy, initialized, pool } = makePool(source, [0, 1, 2, 3], 2);
    for (const index of [1, 2, 3]) {
        source.markAccountCoolingDown(index);
        busy.add(index);
    }
    await pool.rebalanceContextPool();
    await pool._backgroundPreloadTask;
    assert.deepEqual(initialized, []);
    busy.add(0);
    await assert.rejects(pool.preCleanupForSwitch(4), /waiting for in-flight requests/);
    assert.equal(pool.contexts.size, 4);
});

test("background preloading and startup skip accounts that enter cooldown", async () => {
    const source = makeSource();
    const { initialized, pool } = makePool(source, [], 1);
    source.markAccountCoolingDown(0);
    const result = await pool.preloadContextPool([0, 1], 1);
    assert.equal(result.firstReady, 1);
    assert.deepEqual(initialized, [1]);
    const otherPool = makePool(source, [], 0);
    await otherPool.pool._executePreloadTask([0, 1], 0);
    assert.deepEqual(otherPool.initialized, [1]);
    assert.throws(() => pool._throwIfContextInitAborted(0, true), /cooling down/);
});

test("a cooldown during the final auth update aborts background initialization before readiness", async () => {
    const source = makeSource();
    const pool = new BrowserManager(logger, { maxContexts: 1 }, source);
    let closed = false;
    const page = { isClosed: () => closed, on() {} };
    const context = {
        async addInitScript() {},
        async close() {
            closed = true;
        },
        async newPage() {
            return page;
        },
    };
    pool.browser = {
        async newContext() {
            return context;
        },
    };
    pool.stickyProxyManager.getProxyForAuth = () => null;
    pool._navigateAndWakeUpPage = async () => {
        pool._wsInitState.get(0).success = true;
    };
    pool._checkPageStatusAndErrors = async () => {};
    pool._startHealthMonitor = () => {};
    pool._startBackgroundWakeup = async () => {};
    pool._updateAuthFile = async () => source.markAccountCoolingDown(0);
    pool.initializingContexts.add(0);
    await assert.rejects(pool._initializeContext(0, true), /cooling down/);
    assert.equal(closed, true);
    assert.equal(pool.contexts.has(0), false);
    assert.equal(pool.initializingContexts.has(0), false);
});

test("unlimited pool does not retain any duplicate context of a limited email", async () => {
    const source = makeSource([
        { accountName: "a@example.com" },
        { accountName: "b@example.com" },
        { accountName: "b@example.com" },
    ]);
    const { closed, pool } = makePool(source, [0, 1, 2], 0);
    source.markAccountCoolingDown(1);
    await pool.rebalanceContextPool();
    assert.deepEqual(closed, [1, 2]);
});

test("cooldown configuration defaults to one minute and accepts an override", t => {
    const original = process.env.RATE_LIMIT_COOLDOWN_MS;
    t.after(() => {
        if (original === undefined) delete process.env.RATE_LIMIT_COOLDOWN_MS;
        else process.env.RATE_LIMIT_COOLDOWN_MS = original;
    });
    delete process.env.RATE_LIMIT_COOLDOWN_MS;
    assert.equal(new ConfigLoader(logger).loadConfiguration().rateLimitCooldownMs, 60000);
    process.env.RATE_LIMIT_COOLDOWN_MS = "120000";
    assert.equal(new ConfigLoader(logger).loadConfiguration().rateLimitCooldownMs, 120000);
    for (const value of ["0", "-1", "invalid"]) {
        process.env.RATE_LIMIT_COOLDOWN_MS = value;
        assert.equal(new ConfigLoader(logger).loadConfiguration().rateLimitCooldownMs, 60000);
    }
});
