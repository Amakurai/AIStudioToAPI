const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const FormatConverter = require("../FormatConverter");

const HOUR = 3600000;

/** Only explicit upstream evidence may suspend an account/model pair. */
function quotaSignal(error, fallbackMs = 60000, now = Date.now()) {
    const status = Number(error?.upstreamStatus || error?.status);
    const message = String(error?.message || "");
    let delay = Number(error?.retryAfterMs) || 0;
    const header = error?.retryAfter;
    if (header !== undefined && header !== null) {
        const seconds = Number(header);
        delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    }
    if (!(delay > 0)) {
        const text = message.replace(/\\"/g, '"');
        const match = text.match(/(?:retry(?:\s+after|\s+in)|retryDelay["\s:]+)\s*([\d.]+)\s*s(?:econds?)?\b/i);
        if (match) delay = Number(match[1]) * 1000;
    }
    const exhausted =
        /(?:quota\s+(?:has\s+been\s+)?(?:exceeded|exhausted)|exceeded\s+(?:your\s+)?(?:current\s+)?quota|no\s+(?:remaining\s+)?quota|limit:\s*0\b|(?:daily|per.day)\s+(?:request\s+)?limit\s+(?:reached|exceeded)|额度(?:已)?(?:耗尽|用完|不足))/i.test(
            message
        );
    const timed = status === 429 && Number.isFinite(delay) && delay > 0;
    if (!timed && !exhausted) return null;
    return {
        exhausted,
        resetKnown: timed,
        status: status || 429,
        until: now + (timed ? Math.ceil(delay) : fallbackMs),
    };
}

/** Observations, not an invented provider balance. No prompts, cookies or account emails are persisted. */
class PlaygroundQuota {
    constructor(handler) {
        this.handler = handler;
        const settings =
            handler.config.playgroundSettingsPath ||
            handler.config.playgroundCatalogPath ||
            path.join(process.cwd(), "data", "playground-settings.json");
        this.file = handler.config.playgroundQuotaPath || path.join(path.dirname(settings), "playground-quotas.json");
        this.records = new Map();
        this.cooldowns = new Map();
        let restored = false;
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (saved.version === 1) {
                restored = true;
                this.records = new Map(saved.records || []);
                for (const [key, record] of this.records) {
                    if (record.cooldown?.until > Date.now()) this.cooldowns.set(key, record.cooldown);
                }
            }
        } catch (error) {
            if (error.code !== "ENOENT")
                handler.logger.warn(`[Playground] Could not read quota observations: ${error.message}`);
        }
        if (!restored) this.importHistory(handler.serverSystem?.usageStatsService?.records || []);
    }

    importHistory(records) {
        for (const entry of [...records].sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))) {
            if (!entry.model?.startsWith("pg-")) continue;
            const model = FormatConverter.stripModelSuffixes(entry.model)
                .replace(/^pg-/, "")
                .replace(/-抗截断$/, "");
            for (const attempt of entry.attempts || []) {
                const index = Number(String(attempt.accountKey).split(":")[0]);
                if (!Number.isInteger(index) || index < 0) continue;
                const oldName = String(attempt.accountKey).split(":").slice(1).join(":");
                const currentName = this.handler.authSource?.accountNameMap?.get(index);
                if (oldName.includes("@") && currentName && oldName.toLowerCase() !== currentName.toLowerCase())
                    continue;
                const record = this.record(model, index);
                record.attempts++;
                if (attempt.upstreamStatus >= 400) {
                    record.failures++;
                    record.lastStatus = attempt.upstreamStatus;
                    record.lastFailureAt = Date.parse(entry.finishedAt);
                }
            }
            if (entry.outcome !== "success" || !Number.isInteger(entry.finalAuthIndex)) continue;
            const currentName = this.handler.authSource?.accountNameMap?.get(entry.finalAuthIndex);
            if (
                entry.finalAccountName &&
                currentName &&
                entry.finalAccountName.toLowerCase() !== currentName.toLowerCase()
            )
                continue;
            const record = this.record(model, entry.finalAuthIndex);
            record.successes++;
            record.successesSinceLimit++;
            record.lastSuccessAt = Date.parse(entry.finishedAt);
            record.lastStatus = 200;
            this.addUsage(record, record.lastSuccessAt, entry.generation?.response?.usage?.totalTokenCount);
        }
        if (this.records.size) this.save();
    }

    key(model, index) {
        const source = this.handler.authSource;
        const name = source?.accountNameMap?.get(index);
        const identity =
            typeof name === "string" && name.includes("@")
                ? name.trim().toLowerCase()
                : `index:${source?.getCanonicalIndex?.(index) ?? index}`;
        return crypto.createHash("sha256").update(`${identity}\n${model}`).digest("hex");
    }

    record(model, index) {
        const key = this.key(model, index);
        if (!this.records.has(key))
            this.records.set(key, {
                attempts: 0,
                buckets: [],
                failures: 0,
                model,
                observedBeforeLimit: null,
                successes: 0,
                successesSinceLimit: 0,
            });
        return this.records.get(key);
    }

    start(model, index) {
        const record = this.record(model, index);
        record.attempts++;
        record.lastAttemptAt = Date.now();
    }

    success(model, index, usage = {}) {
        const record = this.record(model, index);
        record.successes++;
        record.successesSinceLimit++;
        record.lastSuccessAt = Date.now();
        record.lastStatus = 200;
        if (!this.cooldowns.has(this.key(model, index))) record.cooldown = null;
        this.addUsage(record, Date.now(), usage.totalTokenCount);
        this.save();
    }

    addUsage(record, at, tokens) {
        const hour = Math.floor(at / HOUR);
        if (!Number.isFinite(hour) || hour <= Math.floor(Date.now() / HOUR) - 24) return;
        record.buckets = record.buckets.filter(bucket => bucket.hour > hour - 24);
        let bucket = record.buckets.find(item => item.hour === hour);
        if (!bucket) record.buckets.push((bucket = { hour, requests: 0, tokens: 0 }));
        bucket.requests++;
        bucket.tokens += Math.max(0, Number(tokens) || 0);
    }

    fail(model, index, error) {
        const record = this.record(model, index);
        record.failures++;
        record.lastStatus = Number(error?.upstreamStatus || error?.status) || 502;
        record.lastFailureAt = Date.now();
        const signal = quotaSignal(error, this.handler.config.rateLimitCooldownMs || 60000);
        if (signal) {
            const key = this.key(model, index);
            const previous = this.cooldowns.get(key);
            if (!previous || signal.until > previous.until) {
                this.cooldowns.set(key, signal);
                record.cooldown = signal;
            }
            if (signal.exhausted && !(previous?.until > Date.now())) {
                record.observedBeforeLimit = record.successesSinceLimit;
                record.lastLimitAt = Date.now();
                record.successesSinceLimit = 0;
            }
        }
        this.save();
        return signal;
    }

    snapshot(index, models = []) {
        const hour = Math.floor(Date.now() / HOUR);
        return [...new Set([...models, ...[...this.records.values()].map(record => record.model)])]
            .sort()
            .map(model => {
                const key = this.key(model, index);
                const record = this.records.get(key);
                if (!record)
                    return { attempts: 0, failures: 0, model, observedBeforeLimit: null, requests24h: 0, tokens24h: 0 };
                const recent = record.buckets.filter(bucket => bucket.hour > hour - 24);
                const cooldown = this.cooldowns.get(key);
                return {
                    attempts: record.attempts,
                    cooldown: cooldown?.until > Date.now() ? cooldown : null,
                    failures: record.failures,
                    lastFailureAt: record.lastFailureAt,
                    lastStatus: record.lastStatus,
                    lastSuccessAt: record.lastSuccessAt,
                    model,
                    observedBeforeLimit: record.observedBeforeLimit,
                    requests24h: recent.reduce((sum, bucket) => sum + bucket.requests, 0),
                    successes: record.successes,
                    tokens24h: recent.reduce((sum, bucket) => sum + bucket.tokens, 0),
                };
            });
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ records: [...this.records], version: 1 }));
            fs.renameSync(`${this.file}.tmp`, this.file);
        } catch (error) {
            this.handler.logger.warn(`[Playground] Could not persist quota observations: ${error.message}`);
        }
    }
}

module.exports = { PlaygroundQuota, quotaSignal };
