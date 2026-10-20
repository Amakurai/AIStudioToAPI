/**
 * Request handler views for `pg-` requests. It shares the account pool, format conversion and
 * response handling with Build, but never changes Build's account state:
 * - no rotation (SWITCH_ON_USES) or failure (FAILURE_THRESHOLD) counting;
 * - a Playground 429/503 never cools down, switches or rebalances an account;
 * - dispatch balances Playground requests among themselves, so they never count as Build load;
 * - Build's account cooldowns (Build quota) do not hide accounts from Playground, whose quota differs.
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

    const authSource = new Proxy(handler.authSource, {
        get(target, key) {
            if (key === "isAccountCoolingDown") return () => false;
            if (key === "getAvailableRotationIndices")
                return () => target.getRotationIndices?.() ?? target.getAvailableRotationIndices();
            return bindTo(target)(Reflect.get(target, key, target));
        },
    });

    // Playground run settings replace the global force-tool switches and safety threshold.
    const config = new Proxy(handler.config, {
        get(target, key) {
            const settings = handler.playground.settings.values;
            if (key === "forceWebSearch") return settings.googleSearch;
            if (key === "forceUrlContext") return settings.urlContext;
            if (key === "forceCodeExecution") return settings.codeExecution;
            if (key === "safetySettingsThreshold") return settings.safetyThreshold || target.safetySettingsThreshold;
            return Reflect.get(target, key, target);
        },
    });
    const formatConverter = Object.create(handler.formatConverter, {
        serverSystem: { value: Object.create(handler.serverSystem, { config: { value: config } }) },
    });

    const scope = Object.create(handler, {
        _dispatchCursor: {
            get: () => handler._dispatchCursor,
            set: value => {
                handler._dispatchCursor = value;
            },
        },
        authSource: { value: authSource },
        authSwitcher: { value: authSwitcher },
        config: { value: config },
        connectionRegistry: { value: connectionRegistry },
        dispatchChannel: { value: "playground" },
        formatConverter: { value: formatConverter },
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

    /**
     * Prefer accounts whose Playground channel is not cooling down for this request's model, so a
     * request does not spend a hop on an account known to be denied or rate limited.
     */
    scope._selectDispatchAuthIndex = function (excludeIndices = [], options = {}) {
        const select = Object.getPrototypeOf(scope)._selectDispatchAuthIndex;
        const model = this.playgroundModel;
        if (!model) return select.call(this, excludeIndices, options);
        const cooling = this._getReadyAuthIndices().filter(index => this.playground.isCoolingDown(model, index));
        const preferred = select.call(this, [...excludeIndices, ...cooling], { ...options, allowFallback: false });
        // Every untried account is cooling: let the transport report the cooldown quickly.
        return preferred >= 0 ? preferred : select.call(this, excludeIndices, options);
    };

    return scope;
}

/** The shared Playground view, specialised with the upstream model of one request. */
function playgroundRequestScope(handler, model) {
    handler._playgroundScope ||= createPlaygroundScope(handler);
    return Object.create(handler._playgroundScope, { playgroundModel: { value: model } });
}

module.exports = playgroundRequestScope;
