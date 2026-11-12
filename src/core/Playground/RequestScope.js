/**
 * Request handler views for `pg-` requests. It shares the account pool, format conversion and
 * response handling with Build, with separate quota and failure state:
 * - no rotation (SWITCH_ON_USES) or failure (FAILURE_THRESHOLD) counting;
 * - quota cooldowns affect only the account/model confirmed by the upstream;
 * - retries rotate the whole pool and use bounded backoff before revisiting accounts;
 * - dispatch balances Playground requests among themselves, so they never count as Build load;
 * - current and concurrent accounts follow the same fair scheduler.
 */
const bindTo = target => value => (typeof value === "function" ? value.bind(target) : value);

function createPlaygroundScope(handler) {
    // Build's legacy account limits must never disable a different Playground model.
    const authSource = new Proxy(handler.authSource, {
        get(target, key) {
            if (key === "getAvailableRotationIndices" && target.getRotationIndices)
                return () => target.getRotationIndices();
            if (key === "isAccountCoolingDown") return () => false;
            if (key === "getAccountCooldown" || key === "getAccountCooldownStatus") return () => null;
            return bindTo(target)(Reflect.get(target, key, target));
        },
    });
    const authSwitcher = new Proxy(handler.authSwitcher, {
        get(target, key) {
            if (key === "incrementUsageCount") return () => 0;
            if (key === "shouldSwitchByUsage") return () => false;
            if (key === "handleRequestFailureAndSwitch") return async () => {};
            if (key === "switchToNextAuth")
                return (options = {}) => target.switchToNextAuth({ ...options, resetCounters: false });
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
                    handler.playground.scheduler.release(requestId);
                    const queue = target.createMessageQueue(requestId, ...rest);
                    target.messageQueues.get(requestId).channel = "playground";
                    return queue;
                };
            return bindTo(target)(Reflect.get(target, key, target));
        },
    });

    // Playground run settings replace the global force-tool switches and safety threshold.
    const config = new Proxy(handler.config, {
        get(target, key) {
            if (key === "immediateSwitchStatusCodes")
                return [
                    ...new Set([...(target.immediateSwitchStatusCodes || []), 401, 403, 408, 429, 500, 502, 503, 504]),
                ];
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
        _playgroundDispatchCursor: {
            get: () => handler._playgroundDispatchCursor,
            set: value => {
                handler._playgroundDispatchCursor = value;
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

    scope._accountCooldownError = function (index) {
        return this.playground.coolingDownError(this.playgroundModel, index);
    };

    const waitWhileActive = async (ms, isActive) => {
        const until = Date.now() + ms;
        while (isActive() && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, Math.min(100, until - Date.now())));
        }
        return isActive();
    };
    const remainingCooldown = (model, indices) => {
        const times = indices.map(index => handler.playground.cooldownUntil(model, index) - Date.now());
        return times.length && times.every(ms => ms > 0) ? Math.min(...times) : 0;
    };

    scope._preparePlaygroundAccount = function (excluded, isActive, requestId) {
        return handler.playground.scheduler.select(this, excluded, isActive, requestId);
    };

    scope._acquireDispatchAuthIndex = async function (requestId, res) {
        if (!authSource.getAvailableRotationIndices) return this._selectDispatchAuthIndex();
        let disconnected = false;
        const onClose = () => {
            disconnected = true;
            handler.playground.scheduler.release(requestId);
        };
        res?.once("close", onClose);
        const isActive = () => !disconnected && (!res || this._isResponseWritable(res));
        const deadline = Date.now() + (this.config.playgroundRetryBudgetMs || 180000);
        try {
            while (isActive()) {
                const next = await this._preparePlaygroundAccount([], isActive, requestId);
                if (next >= 0) return next;
                const indices = authSource.getAvailableRotationIndices();
                const delay = remainingCooldown(this.playgroundModel, indices);
                if (!(delay > 0 && Date.now() + delay < deadline)) {
                    const error = indices
                        .map(index => this.playground.coolingDownError(this.playgroundModel, index))
                        .find(Boolean);
                    if (error && res && !res.headersSent)
                        res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
                    throw (
                        error ||
                        Object.assign(new Error("No available Playground account for this model."), { status: 503 })
                    );
                }
                if (!(await waitWhileActive(delay, isActive))) break;
            }
            throw Object.assign(new Error("Playground request cancelled"), { retryable: false, status: 499 });
        } finally {
            res?.removeListener("close", onClose);
            if (!isActive()) handler.playground.scheduler.release(requestId);
        }
    };

    scope._createImmediateSwitchTracker = function (index) {
        return {
            attemptedAuthIndices: new Set(Number.isInteger(index) && index >= 0 ? [index] : []),
            blockedAuthIndices: new Set(),
            round: 1,
            startedAt: Date.now(),
        };
    };

    scope._prepareImmediateStatusRetry = async function (error, requestId, tracker, sourceAuthIndex) {
        this._getUsageStatsService()?.recordAttemptFailure?.(requestId, sourceAuthIndex, error);
        if (error.retryable === false) return false;
        if (!error.quotaRecorded && !error.coolingDown && !error.accountBusy) {
            this.playground.fail(this.playgroundModel, sourceAuthIndex, error);
        }
        tracker.nextAuthIndex = null;
        tracker.startedAt ??= Date.now();
        tracker.round ??= 1;
        tracker.blockedAuthIndices ||= new Set();
        const canonical = index => this.authSource.getCanonicalIndex?.(index) ?? index;
        tracker.attemptedAuthIndices.add(canonical(sourceAuthIndex));
        // An expired login or an explicit access dialog requires user/account action.
        // Exclude it for this request only; neither is evidence of exhausted quota.
        if (Number(error.status) === 401 || error.accessDenied)
            tracker.blockedAuthIndices.add(canonical(sourceAuthIndex));
        const queue = handler.connectionRegistry.messageQueues.get(requestId)?.queue;
        const isActive = () =>
            queue && !queue.closed && handler.connectionRegistry.messageQueues.get(requestId)?.queue === queue;
        const deadline = tracker.startedAt + (this.config.playgroundRetryBudgetMs || 180000);
        if (!isActive() || Date.now() >= deadline) return false;
        let next = await this._preparePlaygroundAccount([...tracker.attemptedAuthIndices], isActive, requestId);
        if (next < 0) {
            if (tracker.round >= (this.config.playgroundRetryRounds || 3)) return false;
            const indices = (this.authSource.getAvailableRotationIndices?.() || this._getReadyAuthIndices()).filter(
                index => !tracker.blockedAuthIndices.has(canonical(index))
            );
            if (!indices.length) return false;
            const backoff = Math.min(10000, (this.config.retryDelay || 2000) * 2 ** (tracker.round - 1));
            const delay = Math.max(
                backoff + Math.floor(Math.random() * backoff * 0.2),
                remainingCooldown(this.playgroundModel, indices)
            );
            if (Date.now() + delay >= deadline) return false;
            this.logger.info(
                `[Playground] Retrying request #${requestId}, round ${tracker.round + 1}, waiting ${delay}ms.`
            );
            if (!(await waitWhileActive(delay, isActive))) return false;
            tracker.round++;
            tracker.attemptedAuthIndices = new Set(tracker.blockedAuthIndices);
            next = await this._preparePlaygroundAccount([...tracker.attemptedAuthIndices], isActive, requestId);
        }
        if (next < 0 || !isActive() || Date.now() >= deadline) return false;
        if (!handler.connectionRegistry.setMessageQueueAuthIndex(requestId, next, queue)) return false;
        tracker.nextAuthIndex = next;
        tracker.attemptedAuthIndices.add(canonical(next));
        this.logger.info(
            `[Playground] Retrying request #${requestId} after upstream ${error.upstreamStatus || error.status}: account #${sourceAuthIndex} -> #${next}, round ${tracker.round}.`
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
        if (preferred >= 0) return preferred;
        if (options.allowFallback === false) return -1;
        const fallback = select.call(this, excludeIndices, options);
        if (fallback >= 0 && this.playground.isCoolingDown(model, fallback)) {
            throw this.playground.coolingDownError(model, fallback);
        }
        return fallback;
    };

    return scope;
}

/** The shared Playground view, specialised with the upstream model of one request. */
function playgroundRequestScope(handler, model) {
    handler._playgroundScope ||= createPlaygroundScope(handler);
    return Object.create(handler._playgroundScope, { playgroundModel: { value: model } });
}

module.exports = playgroundRequestScope;
