/**
 * Request handler view for `pg-` requests. It shares the account pool, format conversion and
 * response handling with Build, but never changes Build's account state:
 * - no rotation (SWITCH_ON_USES) or failure (FAILURE_THRESHOLD) counting;
 * - a Playground 429/503 never cools down, switches or rebalances an account;
 * - dispatch balances Playground requests among themselves, so they never count as Build load.
 * Playground keeps its own per-account/model cooldown in PlaygroundTransport.
 */
const bindTo = target => value => (typeof value === "function" ? value.bind(target) : value);

function createPlaygroundScope(handler) {
    const authSwitcher = new Proxy(handler.authSwitcher, {
        get(target, key) {
            if (key === "incrementUsageCount") return () => 0;
            if (key === "shouldSwitchByUsage") return () => false;
            if (key === "handleRequestFailureAndSwitch") return async () => {};
            return bindTo(target)(Reflect.get(target, key, target));
        },
        set(target, key, value) {
            // Handlers reset or bump these after each attempt; they belong to Build.
            if (key === "failureCount" || key === "usageCount") return true;
            return Reflect.set(target, key, value, target);
        },
    });
    const connectionRegistry = new Proxy(handler.connectionRegistry, {
        get(target, key) {
            if (key === "createMessageQueue")
                return (requestId, ...rest) => {
                    const queue = target.createMessageQueue(requestId, ...rest);
                    target.messageQueues.get(requestId).channel = "playground";
                    return queue;
                };
            return bindTo(target)(Reflect.get(target, key, target));
        },
    });

    const scope = Object.create(handler, {
        _dispatchCursor: {
            get: () => handler._dispatchCursor,
            set: value => {
                handler._dispatchCursor = value;
            },
        },
        authSwitcher: { value: authSwitcher },
        connectionRegistry: { value: connectionRegistry },
        dispatchChannel: { value: "playground" },
        needsSwitchingAfterRequest: { value: false, writable: true },
    });

    /** Retry on another ready account this request has not tried, without touching account state. */
    scope._prepareImmediateStatusRetry = async function (errorDetails, requestId, tracker, sourceAuthIndex) {
        if (errorDetails.retryable === false) return false;
        tracker.nextAuthIndex = null;
        if (Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0)
            tracker.attemptedAuthIndices.add(sourceAuthIndex);
        const queue = handler.connectionRegistry.messageQueues.get(requestId)?.queue;
        if (!queue || queue.closed) return false;
        const next = this._selectDispatchAuthIndex([...tracker.attemptedAuthIndices], { allowFallback: false });
        if (next < 0) {
            this.logger.warn(`[Playground] No untried account is ready for request #${requestId}; stopping retries.`);
            return false;
        }
        if (!handler.connectionRegistry.setMessageQueueAuthIndex(requestId, next, queue)) return false;
        tracker.nextAuthIndex = next;
        tracker.attemptedAuthIndices.add(next);
        this.logger.info(
            `[Playground] Retrying request #${requestId} after ${errorDetails.status}: account #${sourceAuthIndex} -> #${next}.`
        );
        return true;
    };

    return scope;
}

module.exports = createPlaygroundScope;
