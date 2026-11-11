const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AuthSource = require("../src/auth/AuthSource");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const RequestHandler = require("../src/core/RequestHandler");
const BrowserManager = require("../src/core/BrowserManager");
const StatusRoutes = require("../src/routes/StatusRoutes");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

function harness(t, names = ["a@example.com", "b@example.com"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-cooldown-selection-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    class MemorySource extends AuthSource {
        _discoverAvailableIndices() {
            this.initialIndices = names.map((_, index) => index);
        }
        _getAuthContent(index) {
            return JSON.stringify({ accountName: names[index] });
        }
    }
    const source = new MemorySource(logger);
    const registry = new ConnectionRegistry(logger);
    const sent = [];
    const config = {
        failureThreshold: 3,
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 1,
        playgroundCatalogPath: path.join(dir, "models.json"),
        playgroundEnabled: true,
        playgroundSettingsPath: path.join(dir, "settings.json"),
        streamingMode: "fake",
        switchOnUses: 0,
    };
    const browser = {
        contexts: new Map(names.map((_, index) => [index, { context: {}, page: { isClosed: () => false } }])),
        currentAuthIndex: 0,
        initializingContexts: new Set(),
        pendingContextClosures: new Map(),
    };
    for (const index of source.availableIndices) {
        registry.connectionsByAuth.set(index, { readyState: 1, send: data => sent.push(JSON.parse(data)) });
    }
    const server = { authSource: source, browserManager: browser, config, connectionRegistry: registry, logger };
    const handler = new RequestHandler(server, registry, logger, browser, config, source);
    server.requestHandler = handler;
    return { browser, handler, registry, sent, server, source };
}

test("Playground cooldown excludes an account from both channels and every model, including duplicate logins", t => {
    const h = harness(t, ["a@example.com", "b@example.com", "A@example.com"]);
    h.handler.playground.fail("gemini-4-argon", 0, 403);
    for (const index of [0, 2]) {
        const cooldown = h.source.getAccountCooldown(index);
        assert.equal(cooldown.status, 403);
        assert.equal(cooldown.channel, "playground");
        assert.equal(cooldown.model, "gemini-4-argon");
        assert.ok(cooldown.remainingMs <= 60000 && cooldown.remainingMs > 0);
    }
    assert.deepEqual(h.source.expiredIndices, []);
    assert.deepEqual(h.handler._getReadyAuthIndices(), [1]);
    const pg = h.handler.forRequest({ body: { model: "pg-gemini-other" }, path: "/v1/chat/completions" });
    for (let i = 0; i < 12; i++) {
        assert.equal(h.handler._selectDispatchAuthIndex(), 1);
        assert.equal(pg._selectDispatchAuthIndex(), 1);
    }
});

test("cooldown expiry makes the account eligible again without marking authentication expired", t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const h = harness(t);
    h.handler.playground.fail("gemini-4-argon", 0, 403);
    assert.deepEqual(h.handler._getReadyAuthIndices(), [1]);
    now += 59999;
    assert.equal(h.source.getAccountCooldown(0).remainingMs, 1);
    now++;
    assert.equal(h.source.getAccountCooldown(0), null);
    assert.deepEqual(h.handler._getReadyAuthIndices(), [0, 1]);
    assert.equal(h.source.isExpired(0), false);
});

test("manual switching cannot bypass cooldown, including a cooldown entered during preparation", async t => {
    const h = harness(t);
    const switched = [];
    h.browser.preCleanupForSwitch = async () => {};
    h.browser.switchAccount = async index => switched.push(index);
    h.source.markAccountCoolingDown(1, 60000, 403);
    const result = await h.handler.authSwitcher.switchToSpecificAuth(1);
    assert.equal(result.success, false);
    assert.equal(result.cooldown.status, 403);
    assert.deepEqual(switched, []);
    h.browser.preCleanupForSwitch = async index => h.source.markAccountCoolingDown(index, 60000, 429);
    assert.equal((await h.handler.authSwitcher.switchToSpecificAuth(0)).success, false);
    assert.deepEqual(switched, []);
});

test("a browser context cannot become the current account after it starts cooling down", t => {
    const h = harness(t);
    const browser = new BrowserManager(logger, {}, h.source);
    browser.currentAuthIndex = 1;
    h.source.markAccountCoolingDown(0, 60000, 403);
    assert.throws(() => browser._activateContext({}, {}, 0), /cooling down/);
    assert.equal(browser.currentAuthIndex, 1);
    assert.equal(browser.page, null);
});

test("Playground recovery preserves Build counters when the current account is cooling", async t => {
    const h = harness(t);
    h.source.markAccountCoolingDown(0, 60000, 403);
    h.handler.authSwitcher.usageCount = 9;
    h.handler.authSwitcher.failureCount = 2;
    h.browser.preCleanupForSwitch = async () => {};
    h.browser.switchAccount = async index => {
        h.browser.currentAuthIndex = index;
    };
    h.browser.rebalanceContextPool = async () => {};
    const pg = h.handler.forRequest({ body: { model: "pg-gemini-4-argon" }, path: "/v1/chat/completions" });
    const result = await pg.authSwitcher.switchToNextAuth();
    assert.equal(result.success, true);
    assert.equal(h.browser.currentAuthIndex, 1);
    assert.equal(h.handler.authSwitcher.usageCount, 9);
    assert.equal(h.handler.authSwitcher.failureCount, 2);
});

test("an account cooled after concurrent selection is blocked immediately before forwarding", async t => {
    for (const channel of ["build", "playground"]) {
        for (const antiTruncation of [false, true]) {
            await t.test(`${channel} antiTruncation=${antiTruncation}`, async t => {
                const h = harness(t);
                let pgSent = 0;
                h.handler.playground.forward = () => pgSent++;
                const spec = {
                    anti_truncation: antiTruncation,
                    channel,
                    request_attempt_id: "a1",
                    request_id: "reserved",
                };
                const selected = h.handler._selectDispatchAuthIndex();
                const queue = h.registry.createMessageQueue(spec.request_id, selected, spec.request_attempt_id);
                h.source.markAccountCoolingDown(selected, 60000, 403);
                const until = h.source.getAccountCooldown(selected).until;
                h.handler._forwardRequest(spec, selected);
                const error = await queue.dequeue(100);
                assert.equal(error.coolingDown, true);
                assert.equal(error.status, 403);
                assert.deepEqual(h.sent, []);
                assert.equal(pgSent, 0);
                assert.equal(h.source.getAccountCooldown(selected).until, until);
                assert.notEqual(h.handler._selectDispatchAuthIndex(), selected);
                h.registry.removeMessageQueue(spec.request_id);
            });
        }
    }
});

test("queued Playground work rechecks a global cooldown before inference, without extending it", async t => {
    const h = harness(t);
    let release;
    let queued;
    const waiting = new Promise(resolve => {
        release = resolve;
    });
    const entered = new Promise(resolve => {
        queued = resolve;
    });
    let inferences = 0;
    h.handler.playground.sessions.set(h.browser.contexts.get(0).context, {
        async request(_model, _body, { beforeStart }) {
            queued();
            await waiting;
            beforeStart();
            inferences++;
        },
    });
    const spec = {
        body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }], role: "user" }] }),
        path: "/v1beta/models/gemini-other:generateContent",
        request_attempt_id: "a1",
        request_id: "queued",
        streaming_mode: "fake",
    };
    const queue = h.registry.createMessageQueue(spec.request_id, 0, spec.request_attempt_id);
    h.handler.playground.forward(spec, 0);
    await entered;
    h.source.markAccountCoolingDown(0, 60000, 403, { channel: "playground", model: "gemini-4-argon" });
    const until = h.source.getAccountCooldown(0).until;
    release();
    const error = await queue.dequeue(1000);
    assert.equal(error.status, 403);
    assert.equal(error.coolingDown, true);
    assert.equal(inferences, 0);
    assert.equal(h.source.getAccountCooldown(0).until, until);
    h.registry.removeMessageQueue(spec.request_id);
});

test("status reports cooldown deadlines and never labels a cooling account current or dispatchable", t => {
    const h = harness(t);
    h.handler.playground.fail("gemini-4-argon", 0, 403);
    h.handler.channelModels = () => ({ build: [], playground: [] });
    const routes = new StatusRoutes(h.server);
    const result = routes._getStatusData();
    const cooling = result.status.accountDetails.find(account => account.index === 0);
    assert.equal(result.status.currentAuthIndex, -1);
    assert.equal(cooling.isReady, false);
    assert.equal(cooling.cooldown.status, 403);
    assert.ok(cooling.cooldown.until > result.serverTime);
    assert.equal(result.status.accountDetails.find(account => account.index === 1).isReady, true);
});
