const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PlaygroundQuota, quotaSignal } = require("../src/core/Playground/Quota");

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-quota-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const handler = {
        authSource: {
            accountNameMap: new Map([
                [1, "one@example.com"],
                [2, "two@example.com"],
                [3, "ONE@example.com"],
            ]),
        },
        config: { playgroundQuotaPath: path.join(dir, "quota.json") },
        logger: { warn() {} },
    };
    return { handler, quota: new PlaygroundQuota(handler) };
}

test("only a timed 429 or explicit exhausted quota starts a model cooldown", () => {
    for (const error of [
        { status: 403, message: "The caller does not have permission" },
        { status: 403, retryAfter: "60", message: "Access verification required" },
        { status: 429, message: "RESOURCE_EXHAUSTED" },
        { status: 503, message: "Busy" },
        { status: 504, message: "Prompt submission timed out" },
    ])
        assert.equal(quotaSignal(error), null);
    for (const error of [
        { status: 429, retryAfter: "12.5" },
        { status: 429, retryAfter: new Date(13500).toUTCString() },
        { status: 429, message: "Please retry in 12.5s." },
        { status: 429, message: '{"details":[{"retryDelay":"12.5s"}]}' },
    ])
        assert.ok(quotaSignal(error, 60000, 1000).until >= 13000);
    const exhausted = quotaSignal(
        { status: 429, message: "Quota exceeded for metric: requests, limit: 0" },
        3000,
        1000
    );
    assert.equal(exhausted.until, 4000);
    assert.equal(exhausted.resetKnown, false);
    assert.equal(exhausted.exhausted, true);
});

test("quota is isolated by model and account, while duplicate logins share it and restart preserves it", t => {
    const { quota, handler } = fixture(t);
    quota.fail("flash", 1, { status: 429, retryAfterMs: 60000 });
    assert.ok(quota.cooldowns.has(quota.key("flash", 1)));
    assert.equal(quota.key("flash", 1), quota.key("flash", 3));
    assert.equal(quota.cooldowns.has(quota.key("argon", 1)), false);
    assert.equal(quota.cooldowns.has(quota.key("flash", 2)), false);
    quota.fail("flash", 1, { status: 403, message: "Permission denied" });
    const restored = new PlaygroundQuota(handler);
    assert.equal(
        restored.cooldowns.get(restored.key("flash", 1)).until,
        quota.cooldowns.get(quota.key("flash", 1)).until
    );
    const contents = fs.readFileSync(handler.config.playgroundQuotaPath, "utf8");
    assert.equal(contents.includes("example.com"), false);
});

test("usage observations persist and exhaustion samples never become an invented remaining balance", t => {
    const { quota, handler } = fixture(t);
    for (let i = 0; i < 3; i++) {
        quota.start("flash", 1);
        quota.success("flash", 1, { totalTokenCount: 25 });
    }
    quota.fail("flash", 1, { status: 429, message: "quota exhausted" });
    const row = new PlaygroundQuota(handler).snapshot(1)[0];
    assert.equal(row.requests24h, 3);
    assert.equal(row.tokens24h, 75);
    assert.equal(row.observedBeforeLimit, 3);
    assert.equal(row.cooldown.resetKnown, false);
    assert.equal(row.remaining, undefined);
    assert.equal(row.attempts, 3);
    assert.equal(row.failures, 1);
});

test("only matching Playground history contributes to initial usage observations, once", t => {
    const { handler } = fixture(t);
    handler.serverSystem = {
        usageStatsService: {
            records: [
                {
                    model: "pg-flash-预设",
                    finalAuthIndex: 1,
                    outcome: "success",
                    finishedAt: new Date().toISOString(),
                    attempts: [{ accountKey: "1:one@example.com" }],
                    generation: { response: { usage: { totalTokenCount: 19 } } },
                },
                {
                    model: "build-flash",
                    finalAuthIndex: 1,
                    outcome: "success",
                    finishedAt: new Date().toISOString(),
                    attempts: [],
                },
            ],
        },
    };
    const quota = new PlaygroundQuota(handler);
    assert.equal(quota.snapshot(1)[0].requests24h, 1);
    assert.equal(quota.snapshot(1)[0].model, "flash");
    assert.equal(new PlaygroundQuota(handler).snapshot(1)[0].tokens24h, 19);
});
