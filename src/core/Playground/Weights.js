const HALF_LIFE_MS = 5 * 60 * 1000;

/** Daily observations deliberately never read or write the persisted quota/history files. */
class PlaygroundWeights {
    constructor(source, timeZone = "Asia/Singapore") {
        this.source = source;
        this.timeZone = timeZone;
        this.calendar = new Intl.DateTimeFormat("en-CA", {
            day: "2-digit",
            month: "2-digit",
            timeZone,
            year: "numeric",
        });
        this.records = new Map();
        this.day = null;
    }

    _rollover() {
        const day = this.calendar.format(Date.now());
        if (day !== this.day) {
            this.records.clear();
            this.day = day;
        }
    }

    _record(model, index) {
        this._rollover();
        const canonical = this.source?.getCanonicalIndex?.(index) ?? index;
        const name = this.source?.accountNameMap?.get(index);
        const identity = name?.includes("@") ? name.trim().toLowerCase() : canonical;
        const key = JSON.stringify([identity, model]);
        if (!this.records.has(key))
            this.records.set(key, {
                attempts: 0,
                credit: 0,
                failures: 0,
                penalty: 0,
                penaltyAt: Date.now(),
                successes: 0,
                tokens: 0,
            });
        return this.records.get(key);
    }

    _penalty(record) {
        return record.penalty * 2 ** (-Math.max(0, Date.now() - record.penaltyAt) / HALF_LIFE_MS);
    }

    start(model, index) {
        this._record(model, index).attempts++;
    }

    success(model, index, usage = {}) {
        const record = this._record(model, index);
        record.successes++;
        record.tokens += Math.max(0, Number(usage.totalTokenCount) || 0);
        record.penalty = this._penalty(record) * 0.5;
        record.penaltyAt = Date.now();
        record.lastStatus = 200;
    }

    fail(model, index, error) {
        const status = Number(error?.upstreamStatus || error?.status) || 502;
        // Invalid requests and content/tool validation errors do not measure account health.
        if (![401, 403, 408, 429, 500, 502, 503, 504].includes(status) || error?.invalidToolResponse) return;
        const record = this._record(model, index);
        const severity = status === 401 || error?.accessDenied ? 6 : status === 403 ? 3 : status === 429 ? 2 : 1;
        record.failures++;
        record.penalty = Math.min(20, this._penalty(record) + severity);
        record.penaltyAt = Date.now();
        record.lastStatus = status;
        // Old scheduling credit must not keep a newly failing account at the front.
        record.credit = 0;
    }

    snapshot(model, index) {
        const record = this._record(model, index);
        const reliability = (record.successes + 4) / (record.successes + record.failures + 4);
        const usage = Math.sqrt(1 + record.attempts / 20 + record.tokens / 200000);
        const weight = Math.max(
            5,
            Math.min(100, Math.round((100 * reliability) / (usage * (1 + this._penalty(record)))))
        );
        return {
            attemptsToday: record.attempts,
            day: this.day,
            failuresToday: record.failures,
            lastStatus: record.lastStatus,
            successesToday: record.successes,
            timeZone: this.timeZone,
            tokensToday: record.tokens,
            weight,
        };
    }

    /** Smooth weighted round robin: best score leads, small weights still get recovery probes. */
    rank(model, indices) {
        return indices.map(index => {
            const weight = this.snapshot(model, index).weight;
            return { index, priority: this._record(model, index).credit + weight, weight };
        });
    }

    commit(model, indices, selected) {
        const ranked = this.rank(model, indices);
        for (const { index, weight } of ranked) this._record(model, index).credit += weight;
        this._record(model, selected).credit -= ranked.reduce((sum, row) => sum + row.weight, 0);
    }
}

module.exports = PlaygroundWeights;
