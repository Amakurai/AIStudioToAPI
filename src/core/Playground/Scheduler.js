/** One serial generation lane per account, selected by daily model-specific weights. */
class PlaygroundScheduler {
    constructor(handler) {
        this.handler = handler;
        this.reservations = new Map();
        this.lastSelected = new Map();
        this.sequence = 0;
    }

    release(requestId) {
        this.reservations.delete(requestId);
    }

    select(scope, excluded, isActive, requestId) {
        // Selection and reservation are synchronous until this account needs preparation.
        // A slow startup must not hold a global lock over other accounts' ready slots.
        return this._select(scope, excluded, isActive, requestId);
    }

    async _select(scope, excluded, isActive, requestId) {
        const handler = this.handler;
        const source = scope.authSource;
        const canonical = index => source.getCanonicalIndex?.(index) ?? index;
        const omitted = new Set(excluded.map(canonical));
        const available = () =>
            (source.getAvailableRotationIndices?.() || scope._getReadyAuthIndices()).filter(
                index =>
                    !omitted.has(canonical(index)) && !handler.playground.isCoolingDown(scope.playgroundModel, index)
            );
        const load = index => {
            let count = 0;
            for (const [id, entry] of handler.connectionRegistry.messageQueues) {
                if (
                    id !== requestId &&
                    !entry.queue.closed &&
                    entry.channel === "playground" &&
                    canonical(entry.authIndex) === canonical(index)
                )
                    count++;
            }
            for (const [id, reserved] of this.reservations) {
                if (id !== requestId && canonical(reserved) === canonical(index)) count++;
            }
            return count;
        };
        while (isActive()) {
            let candidates = available();
            if (!candidates.length) return -1;
            const ready = scope._getReadyAuthIndices();
            const contexts = handler.browserManager.contexts;
            const max = handler.config.maxContexts;
            // Do not grow the browser pool merely to avoid a queue. A failed attempt may
            // drain during a replacement, as handled by BrowserManager's existing bound.
            const busyCount = contexts ? [...contexts.keys()].filter(index => load(index) > 0).length : 0;
            if (max > 0 && busyCount >= max) candidates = candidates.filter(index => ready.includes(index));
            if (!candidates.length) return -1;
            const minLoad = Math.min(...candidates.map(load));
            candidates = candidates.filter(index => load(index) === minLoad);
            const ranks = new Map(
                handler.playground.weights.rank(scope.playgroundModel, candidates).map(row => [row.index, row])
            );
            candidates.sort(
                (a, b) =>
                    ranks.get(b).priority - ranks.get(a).priority ||
                    Number(!ready.includes(a)) - Number(!ready.includes(b)) ||
                    (this.lastSelected.get(canonical(a)) || 0) - (this.lastSelected.get(canonical(b)) || 0) ||
                    a - b
            );
            const selected = candidates[0];
            if (!ready.includes(selected)) {
                if (requestId) this.reservations.set(requestId, selected);
                try {
                    if (handler.authSwitcher.isSystemBusy) {
                        if (!(await scope._waitForSystemReady())) return -1;
                        continue;
                    }
                    const result = handler.browserManager.ensurePlaygroundContext
                        ? await handler.browserManager.ensurePlaygroundContext(selected)
                        : await handler.authSwitcher.switchToNextAuth({
                              excludeIndices: (source.getRotationIndices?.() || []).filter(
                                  index => canonical(index) !== canonical(selected)
                              ),
                              resetCounters: false,
                          });
                    if (!isActive()) return -1;
                    if (!result?.success || !scope._getReadyAuthIndices().includes(selected)) {
                        omitted.add(canonical(selected));
                        continue;
                    }
                } finally {
                    if (this.reservations.get(requestId) === selected) this.release(requestId);
                }
            }
            // Recheck after startup; another in-flight request may have exhausted this model.
            if (!available().includes(selected)) continue;
            handler.playground.weights.commit(scope.playgroundModel, candidates, selected);
            handler.browserManager._cancelPendingContextClosure?.(selected, "playground_dispatch");
            this.lastSelected.set(canonical(selected), ++this.sequence);
            if (requestId) {
                const existing = handler.connectionRegistry.messageQueues.get(requestId);
                if (existing) {
                    if (!handler.connectionRegistry.setMessageQueueAuthIndex(requestId, selected, existing.queue))
                        return -1;
                } else this.reservations.set(requestId, selected);
            }
            return selected;
        }
        return -1;
    }
}

module.exports = PlaygroundScheduler;
