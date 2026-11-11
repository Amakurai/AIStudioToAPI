/**
 * Request handler views for `pg-` requests. It shares the account pool, format conversion and
 * response handling with Build, with separate quota and failure state:
 * - no rotation (SWITCH_ON_USES) or failure (FAILURE_THRESHOLD) counting;
 * - all channels share a temporary account cooldown; Playground leaves Build counters alone;
 * - retries use ready accounts first, then rotate the shared browser pool to an eligible spare;
 * - dispatch balances Playground requests among themselves, so they never count as Build load;
 * - a cooling account is excluded from both current-account and concurrent dispatch selection.
 */
const bindTo = target => value => (typeof value === "function" ? value.bind(target) : value);

function createPlaygroundScope(handler) {
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
                return [...new Set([...(target.immediateSwitchStatusCodes || []), 401, 403])];
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
        authSource: { value: handler.authSource },
        authSwitcher: { value: authSwitcher },
        config: { value: config },
        connectionRegistry: { value: connectionRegistry },
        dispatchChannel: { value: "playground" },
        formatConverter: { value: formatConverter },
        needsSwitchingAfterRequest: { value: false, writable: true },
    });

    /** Use an eligible ready account, or initialise a spare through the shared pool's bounded switch. */
    scope._preparePlaygroundAccount = async function (excludeIndices, requestIsActive) {
        const canonical = index => this.authSource.getCanonicalIndex?.(index) ?? index;
        const excluded = new Set(excludeIndices.map(canonical));
        const eligible = index =>
            !excluded.has(canonical(index)) && !this.playground.isCoolingDown(this.playgroundModel, index);
        const select = () => this._selectDispatchAuthIndex(excludeIndices, { allowFallback: false });
        if (!requestIsActive()) return -1;
        let next = select();
        if (next >= 0) return next;

        // Both channels honour the same temporary account cooldown.
        const candidates = handler.authSource.getAvailableRotationIndices?.() || [];
        if (!candidates.some(eligible)) return -1;
        if (this.authSwitcher.isSystemBusy) {
            if (!(await this._waitForSystemReady()) || !requestIsActive()) return -1;
            next = select();
            if (next >= 0) return next;
        }
        if (!requestIsActive()) return -1;
        const cooling = (this.authSource.getRotationIndices?.() || []).filter(index => !eligible(index));
        try {
            await this.authSwitcher.switchToNextAuth({
                excludeIndices: [...excludeIndices, ...cooling],
                resetCounters: false,
            });
        } catch (error) {
            this.logger.warn(`[Playground] Failed to prepare a spare account: ${error.message}`);
        }
        return requestIsActive() ? select() : -1;
    };

    // A fresh request can arrive while all resident accounts are cooling down, even though an
    // unused auth file is available. Prepare it before synchronous dispatch rejects the request.
    scope._ensureBrowserBackedRequestReady = async function (res, options) {
        if (!(await handler._ensureBrowserBackedRequestReady.call(this, res, options))) return false;
        if (!this._getReadyAuthIndices().some(index => !this.playground.isCoolingDown(this.playgroundModel, index))) {
            await this._preparePlaygroundAccount([], () => this._isResponseWritable(res));
        }
        return this._isResponseWritable(res);
    };

    /** Retry another account once, preserving the queue if the client disconnects during startup. */
    scope._prepareImmediateStatusRetry = async function (errorDetails, requestId, tracker, sourceAuthIndex) {
        this._getUsageStatsService()?.recordAttemptFailure?.(requestId, sourceAuthIndex, errorDetails);
        if (errorDetails.retryable === false) return false;
        if (
            !errorDetails.coolingDown &&
            !errorDetails.accountBusy &&
            !this.playground.isCoolingDown(this.playgroundModel, sourceAuthIndex)
        )
            this.playground.fail(this.playgroundModel, sourceAuthIndex, Number(errorDetails.status));
        tracker.nextAuthIndex = null;
        if (Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0)
            tracker.attemptedAuthIndices.add(sourceAuthIndex);
        const queue = handler.connectionRegistry.messageQueues.get(requestId)?.queue;
        const requestIsActive = () =>
            queue && !queue.closed && handler.connectionRegistry.messageQueues.get(requestId)?.queue === queue;
        const next = await this._preparePlaygroundAccount([...tracker.attemptedAuthIndices], requestIsActive);
        if (next < 0) {
            this.logger.warn(
                `[Playground] No untried eligible account for request #${requestId}; tried=[${[...tracker.attemptedAuthIndices]}], model=${this.playgroundModel}, upstreamStatus=${errorDetails.upstreamStatus || errorDetails.status}.`
            );
            if (this.authSource.isAccountCoolingDown?.(sourceAuthIndex))
                this.browserManager.rebalanceContextPool?.().catch(error => this.logger.warn(error.message));
            return false;
        }
        if (!handler.connectionRegistry.setMessageQueueAuthIndex(requestId, next, queue)) return false;
        tracker.nextAuthIndex = next;
        tracker.attemptedAuthIndices.add(next);
        this.logger.info(
            `[Playground] Retrying request #${requestId} after upstream ${errorDetails.upstreamStatus || errorDetails.status}: account #${sourceAuthIndex} (${JSON.stringify(this._getAccountNameForIndex(sourceAuthIndex))}) -> #${next} (${JSON.stringify(this._getAccountNameForIndex(next))}).`
        );
        if (
            this.authSource.isAccountCoolingDown?.(sourceAuthIndex) &&
            sourceAuthIndex === this.currentAuthIndex &&
            !this.authSwitcher.isSystemBusy
        ) {
            this.authSwitcher
                .switchToNextAuth({ excludeIndices: [sourceAuthIndex], resetCounters: false })
                .catch(error => this.logger.warn(`[Playground] Failed to replace cooling account: ${error.message}`));
        }
        if (this.authSource.isAccountCoolingDown?.(sourceAuthIndex))
            this.browserManager.rebalanceContextPool?.().catch(error => this.logger.warn(error.message));
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
