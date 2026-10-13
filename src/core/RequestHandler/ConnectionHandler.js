/**
 * File: src/core/RequestHandler/ConnectionHandler.js
 * Description: Authentication switching, connection readiness, and browser recovery.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const ErrorHandler = require("./ErrorHandler");
const { WS_RECONNECT_WAIT_MS, WS_CONNECTION_READY_TIMEOUT_MS } = require("./constants");

class ConnectionHandler extends ErrorHandler {
    _cleanupRequestResources(requestId, res, { switchAccountIfNeeded = false } = {}) {
        this.connectionRegistry.removeMessageQueue(requestId, "request_complete");

        if (switchAccountIfNeeded && this.needsSwitchingAfterRequest) {
            this.logger.info(
                `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
            );
            this.authSwitcher.switchToNextAuth().catch(err => {
                this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
            });
            this.needsSwitchingAfterRequest = false;
        }

        if (!res.writableEnded) res.end();
    }

    // Delegate methods to AuthSwitcher
    async _switchToNextAuth() {
        return this.authSwitcher.switchToNextAuth();
    }

    async _switchToSpecificAuth(targetIndex) {
        return this.authSwitcher.switchToSpecificAuth(targetIndex);
    }

    async _waitForGraceReconnect(timeoutMs = WS_RECONNECT_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!this.connectionRegistry.isInGracePeriod() && !this.connectionRegistry.isReconnectingInProgress()) {
                return await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return !!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
    }

    /**
     * Wait for WebSocket connection to be established for current account
     * @param {number} timeoutMs - Maximum time to wait in milliseconds
     * @returns {Promise<boolean>} true if connection established, false if timeout
     */
    async _waitForConnection(timeoutMs = 10000) {
        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            const connection = this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
            // Check both existence and readyState (1 = OPEN)
            if (connection && connection.readyState === 1) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(
            `[Request] Timeout waiting for WebSocket connection for account #${this.currentAuthIndex}. Closing unresponsive context...`
        );
        // Proactively close the unresponsive context so subsequent attempts re-initialize it
        if (this.browserManager) {
            try {
                await this.browserManager.closeContext(this.currentAuthIndex);
            } catch (e) {
                this.logger.warn(
                    `[System] Failed to close unresponsive context for account #${this.currentAuthIndex}: ${e.message}`
                );
            }
        }
        return false;
    }

    /**
     * Wait for system to become ready (not busy with switching/recovery)
     * @param {number} timeoutMs - Maximum time to wait in milliseconds (default 120s, same as browser launch timeout)
     * @returns {Promise<boolean>} true if system becomes ready, false if timeout
     */
    async _waitForSystemReady(timeoutMs = 120000) {
        if (!this.authSwitcher.isSystemBusy) {
            return true;
        }

        this.logger.info(`[System] System is busy (switching/recovering), waiting up to ${timeoutMs / 1000}s...`);

        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            if (!this.authSwitcher.isSystemBusy) {
                this.logger.info(`[System] System ready after ${Date.now() - startTime}ms.`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(`[System] Timeout waiting for system after ${timeoutMs}ms.`);
        return false;
    }

    async _waitForSystemAndConnectionIfBusy(res = null, options = {}) {
        const {
            busyMessage = "Server undergoing internal maintenance (account switching/recovery), please try again later.",
            connectionMessage = "Service temporarily unavailable: Connection not established after switching.",
            connectionTimeoutMs = WS_CONNECTION_READY_TIMEOUT_MS,
            onConnectionTimeout,
            sendError = res ? (status, message) => this._sendErrorResponse(res, status, message) : () => {},
            // When true, any ready pool account satisfies the connection check (multi-account dispatch)
            allowAnyReadyAccount = false,
        } = options;

        const ready = await this._waitForSystemReady();
        if (!ready) {
            sendError(503, busyMessage);
            return false;
        }

        const currentConnectionReady =
            !this.authSource.isAccountCoolingDown?.(this.currentAuthIndex) &&
            this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex, false)?.readyState === 1;
        const hasConnection = allowAnyReadyAccount
            ? currentConnectionReady || this._getReadyAuthIndices().length > 0
            : currentConnectionReady;

        if (!hasConnection) {
            const connectionReady = allowAnyReadyAccount
                ? await this._waitForAnyReadyAccount(connectionTimeoutMs)
                : await this._waitForConnection(connectionTimeoutMs);
            if (!connectionReady) {
                if (typeof onConnectionTimeout === "function") {
                    try {
                        onConnectionTimeout();
                    } catch (e) {
                        this.logger.debug(`[System] onConnectionTimeout handler failed: ${e.message}`);
                    }
                }
                sendError(503, connectionMessage);
                return false;
            }
        }

        return true;
    }

    async _ensureBrowserBackedRequestReady(res, options = {}) {
        const { logPrefix = "Request", waitErrorType = null, waitOptions } = options;

        if (
            this.authSource.getRotationIndices?.().length > 0 &&
            this.authSource.getAvailableRotationIndices?.().length === 0
        ) {
            const message = "All accounts are temporarily rate limited. Please try again later.";
            if (res.headersSent) this._handleRequestError({ message, status: 429 }, res);
            else this._sendErrorResponse(res, 429, message);
            return false;
        }

        // Fast path: current account's browser connection exists.
        // Otherwise, any ready pool account is enough to serve the request (multi-account dispatch);
        // only fall back to the recovery flow when no account is ready at all.
        if (
            (!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex) ||
                this.authSource.isAccountCoolingDown?.(this.currentAuthIndex)) &&
            this._getReadyAuthIndices().length === 0
        ) {
            this.logger.warn(
                `[${logPrefix}] No ready account available (current account #${this.currentAuthIndex} has no connection)`
            );
            const recovered = await this._handleBrowserRecovery(res);
            if (!recovered) {
                this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: Browser recovery failed.");
                return false;
            }
        }

        // Wait for system to become ready if it's busy
        const effectiveWaitOptions =
            waitOptions === undefined && waitErrorType
                ? {
                      sendError: (status, message) => this._sendErrorResponse(res, status, message, waitErrorType),
                  }
                : waitOptions;
        const ready = await this._waitForSystemAndConnectionIfBusy(res, {
            allowAnyReadyAccount: true,
            ...effectiveWaitOptions,
        });
        if (!ready) {
            this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: System not ready.");
            return false;
        }

        if (this.browserManager) {
            this.browserManager.notifyUserActivity();
        }

        return true;
    }

    /**
     * Handle browser recovery when connection is lost
     *
     * Important: isSystemBusy flag management strategy:
     * - Direct recovery (recoveryAuthIndex >= 0): We manually set and reset isSystemBusy
     * - Switch to next account (recoveryAuthIndex = -1): Let switchToNextAuth() manage isSystemBusy internally
     * - This prevents the bug where isSystemBusy is set here, then switchToNextAuth() checks it and returns "already in progress"
     *
     * @returns {Promise<boolean>} true if recovery successful, false otherwise
     */
    async _handleBrowserRecovery(res) {
        // If within grace period or lightweight reconnect is running, wait up to 130s for WebSocket reconnection
        if (
            !this.authSource.isAccountCoolingDown?.(this.currentAuthIndex) &&
            (this.connectionRegistry.isInGracePeriod() || this.connectionRegistry.isReconnectingInProgress())
        ) {
            this.logger.info(
                "[System] Waiting up to 130s for WebSocket reconnection (grace/reconnect in progress) before full recovery..."
            );
            const reconnected = await this._waitForGraceReconnect(WS_RECONNECT_WAIT_MS);
            if (reconnected) {
                this.logger.info("[System] Connection restored, skipping recovery.");
                return true;
            }
            this.logger.warn("[System] Reconnection wait expired, proceeding to recovery workflow.");
        }

        // Wait for system to become ready if it's busy (someone else is starting/switching browser)
        if (this.authSwitcher.isSystemBusy) {
            return await this._waitForSystemAndConnectionIfBusy(res, {
                allowAnyReadyAccount: true,
                connectionMessage: "Service temporarily unavailable: Browser failed to start. Please try again.",
                onConnectionTimeout: () => {
                    this.logger.error(
                        `[System] WebSocket connection not established for account #${this.currentAuthIndex} after system ready, browser startup may have failed.`
                    );
                },
            });
        }

        // Determine if this is first-time startup or actual crash recovery
        const recoveryAuthIndex = this.authSource.isAccountCoolingDown?.(this.currentAuthIndex)
            ? -1
            : this.currentAuthIndex;
        const isFirstTimeStartup = recoveryAuthIndex < 0 && !this.browserManager.browser;

        if (isFirstTimeStartup) {
            this.logger.info(
                "🚀 [System] Browser not yet started. Initializing browser with first available account..."
            );
        } else {
            this.logger.error(
                "❌ [System] Browser WebSocket connection disconnected! Possible process crash. Attempting recovery..."
            );
        }

        let wasDirectRecovery = false;
        let recoverySuccess = false;

        try {
            if (recoveryAuthIndex >= 0) {
                // Direct recovery: we manage isSystemBusy ourselves
                wasDirectRecovery = true;
                this.authSwitcher.isSystemBusy = true;
                this.logger.info(`[System] Set isSystemBusy=true for direct recovery to account #${recoveryAuthIndex}`);

                await this.browserManager.preCleanupForSwitch(recoveryAuthIndex);
                await this.browserManager.launchOrSwitchContext(recoveryAuthIndex);
                this.logger.info(`✅ [System] Browser successfully recovered to account #${recoveryAuthIndex}!`);

                // Wait for WebSocket connection to be established
                this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                if (!connectionReady) {
                    throw new Error("WebSocket connection not established within timeout period");
                }
                this.logger.info("✅ [System] WebSocket connection is ready!");
                recoverySuccess = true;
            } else if (this.authSource.getRotationIndices().length > 0) {
                // Don't set isSystemBusy here - let switchToNextAuth manage it
                const result = await this.authSwitcher.switchToNextAuth();
                if (!result.success) {
                    this.logger.error(`❌ [System] Failed to switch to available account: ${result.reason}`);
                    this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                    recoverySuccess = false;
                } else {
                    this.logger.info(`✅ [System] Successfully recovered to account #${result.newIndex}!`);

                    // Wait for WebSocket connection to be established
                    this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                    const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                    if (!connectionReady) {
                        throw new Error("WebSocket connection not established within timeout period");
                    }
                    this.logger.info("✅ [System] WebSocket connection is ready!");
                    recoverySuccess = true;
                }
            } else {
                this.logger.error("❌ [System] No available accounts for recovery.");
                this._sendErrorResponse(res, 503, "Service temporarily unavailable: No available accounts.");
                recoverySuccess = false;
            }
        } catch (error) {
            this.logger.error(`❌ [System] Recovery failed: ${error.message}`);

            if (wasDirectRecovery && this.authSource.getRotationIndices().length > 1) {
                this.logger.warn("⚠️ [System] Attempting to switch to alternative account...");
                // Reset isSystemBusy before calling switchToNextAuth to avoid "already in progress" rejection
                this.authSwitcher.isSystemBusy = false;
                wasDirectRecovery = false; // Prevent finally block from resetting again
                try {
                    const result = await this.authSwitcher.switchToNextAuth();
                    if (!result.success) {
                        this.logger.error(`❌ [System] Failed to switch to alternative account: ${result.reason}`);
                        this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                        recoverySuccess = false;
                    } else {
                        this.logger.info(
                            `✅ [System] Successfully switched to alternative account #${result.newIndex}!`
                        );

                        // Wait for WebSocket connection to be established
                        this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                        const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                        if (!connectionReady) {
                            throw new Error("WebSocket connection not established within timeout period");
                        }
                        this.logger.info("✅ [System] WebSocket connection is ready!");
                        recoverySuccess = true;
                    }
                } catch (switchError) {
                    this.logger.error(`❌ [System] All accounts failed: ${switchError.message}`);
                    this._sendErrorResponse(res, 503, "Service temporarily unavailable: All accounts failed.");
                    recoverySuccess = false;
                }
            } else {
                this._sendErrorResponse(
                    res,
                    503,
                    "Service temporarily unavailable: Browser crashed and cannot auto-recover."
                );
                recoverySuccess = false;
            }
        } finally {
            // Only reset if we set it (for direct recovery attempt)
            if (wasDirectRecovery) {
                this.logger.info("[System] Resetting isSystemBusy=false in recovery finally block");
                this.authSwitcher.isSystemBusy = false;
            }
        }

        return recoverySuccess;
    }

    _markTrackedEarlyExitIfNeeded(res, message = "Service temporarily unavailable.", statusCode = 503) {
        if (!res || res.__usageTrackingClientAborted || res.__usageTrackingOutcome) return;
        if (!this._isResponseWritable(res)) {
            this._markTrackedClientAbort(res, message);
            return;
        }
        this._markTrackedResponseError(res, message, statusCode);
    }
    async _waitForAnyReadyAccount(timeoutMs = 10000) {
        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            const connection = this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex, false);
            // Fast path: current account connection is OPEN
            if (
                connection &&
                connection.readyState === 1 &&
                !this.authSource.isAccountCoolingDown?.(this.currentAuthIndex)
            ) {
                return true;
            }
            if (this._getReadyAuthIndices().length > 0) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn("[Request] Timeout waiting for any ready account.");
        return false;
    }

    _selectDispatchAuthIndex(excludeIndices = [], { allowFallback = true } = {}) {
        const canonical = index => this.authSource.getCanonicalIndex?.(index) ?? index;
        const excluded = new Set(excludeIndices.map(canonical));
        const eligible = index => !excluded.has(canonical(index)) && !this.authSource.isAccountCoolingDown?.(index);
        const candidates = this._getReadyAuthIndices().filter(eligible);

        if (candidates.length === 0) {
            return allowFallback && eligible(this.currentAuthIndex) ? this.currentAuthIndex : -1;
        }
        if (candidates.length === 1) {
            return candidates[0];
        }

        // Keep the ascending order from _getReadyAuthIndices so the round-robin
        // cursor walks accounts deterministically
        let minQueueCount = Infinity;
        for (const authIndex of candidates) {
            minQueueCount = Math.min(minQueueCount, this.connectionRegistry.getQueueCountForAuth(authIndex));
        }
        const leastLoaded = candidates.filter(
            authIndex => this.connectionRegistry.getQueueCountForAuth(authIndex) === minQueueCount
        );

        // Round-robin among the least-loaded accounts
        const selected = leastLoaded[this._dispatchCursor % leastLoaded.length];
        this._dispatchCursor = (this._dispatchCursor + 1) % Number.MAX_SAFE_INTEGER;
        return selected;
    }

    _getReadyAuthIndices() {
        const readyIndices = [];
        if (!this.browserManager?.contexts) {
            return readyIndices;
        }
        for (const [authIndex, contextData] of this.browserManager.contexts.entries()) {
            if (this.authSource.isAccountCoolingDown?.(authIndex)) continue;
            if (this.browserManager.initializingContexts.has(authIndex)) {
                continue;
            }
            if (!contextData || !contextData.page || contextData.page.isClosed()) {
                continue;
            }
            const connection = this.connectionRegistry.getConnectionByAuth(authIndex, false);
            if (!connection || connection.readyState !== 1) {
                continue;
            }
            readyIndices.push(authIndex);
        }
        return readyIndices.sort((a, b) => a - b);
    }
}

module.exports = ConnectionHandler;
