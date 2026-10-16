/** Request validation and forwarding for the opt-in anti-truncation model aliases. */
class AntiTruncation {
    // Same segment count for every budget, so a larger output budget never lowers total capacity.
    static MAX_SEGMENTS = 8;
    static MAX_TOOL_REPAIRS = 2;
    static MAX_CHUNK_CHARACTERS = 12000;
    static BLOCKED_FINISH_REASONS = [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "IMAGE_RECITATION",
    ];

    static invalidRequest(message) {
        return Object.assign(new Error(`Anti-truncation: ${message}`), { status: 400 });
    }

    static protocolError(message) {
        // Retrying malformed payloads from scratch can discard a valid prefix and multiply usage.
        return Object.assign(new Error(`Anti-truncation: ${message}`), { retryable: false, status: 502 });
    }

    static normalizeStops(value) {
        if (value === undefined || value === null) return [];
        const stops = typeof value === "string" ? [value] : value;
        if (!Array.isArray(stops) || stops.some(stop => typeof stop !== "string" || !stop.length)) {
            throw this.invalidRequest("stop must be a non-empty string or an array of non-empty strings.");
        }
        return stops;
    }

    static textChunkLimit(maxOutputTokens, thinkingBudget) {
        if (!maxOutputTokens) return this.MAX_CHUNK_CHARACTERS;
        // Thinking shares the output budget, and JSON escaping costs tokens. Leave headroom for both;
        // malformed or cut-off calls still halve the limit through bounded repair.
        const reserved = Number.isInteger(thinkingBudget) && thinkingBudget > 0 ? thinkingBudget : 0;
        const available = Math.max(0, maxOutputTokens - reserved);
        return Math.min(this.MAX_CHUNK_CHARACTERS, Math.max(64, Math.floor(available * 0.75)));
    }

    static maxWaitMs(perCallTimeout) {
        // One upstream call per segment, an optional finish_output call and bounded repairs.
        return perCallTimeout * (this.MAX_SEGMENTS + 1 + this.MAX_TOOL_REPAIRS) + 1000;
    }

    static baseModel(model) {
        if (typeof model !== "string") return null;
        let decoded;
        try {
            decoded = decodeURIComponent(model);
        } catch {
            return null;
        }
        const match = decoded.match(/^(gemini-3\.[78]-flash|gemini-4-argon)-抗截断$/);
        return match ? match[1] : null;
    }

    static normalizeRequest(body) {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw this.invalidRequest("request body must be an object.");
        }
        const request = JSON.parse(JSON.stringify(body));
        // Google accepts both protobuf field spellings. Do not leave duplicate transport settings.
        const normalizeKeys = (object, pairs) => {
            for (const [snake, camel] of pairs) {
                if (object[snake] !== undefined) {
                    if (object[camel] !== undefined)
                        throw this.invalidRequest(`use either ${snake} or ${camel}, not both.`);
                    object[camel] = object[snake];
                    delete object[snake];
                }
            }
        };
        normalizeKeys(request, [
            ["generation_config", "generationConfig"],
            ["system_instruction", "systemInstruction"],
            ["tool_config", "toolConfig"],
            ["cached_content", "cachedContent"],
        ]);
        const generation = request.generationConfig ?? {};
        if (typeof generation !== "object" || Array.isArray(generation)) {
            throw this.invalidRequest("generationConfig must be an object.");
        }
        normalizeKeys(generation, [
            ["max_output_tokens", "maxOutputTokens"],
            ["thinking_config", "thinkingConfig"],
            ["stop_sequences", "stopSequences"],
            ["candidate_count", "candidateCount"],
            ["response_schema", "responseSchema"],
            ["response_json_schema", "responseJsonSchema"],
            ["response_mime_type", "responseMimeType"],
            ["response_modalities", "responseModalities"],
        ]);
        if (generation.thinkingConfig != null) {
            if (typeof generation.thinkingConfig !== "object" || Array.isArray(generation.thinkingConfig)) {
                throw this.invalidRequest("thinkingConfig must be an object.");
            }
            normalizeKeys(generation.thinkingConfig, [
                ["include_thoughts", "includeThoughts"],
                ["thinking_budget", "thinkingBudget"],
                ["thinking_level", "thinkingLevel"],
            ]);
        }
        generation.stopSequences = this.normalizeStops(generation.stopSequences);
        request.generationConfig = generation;
        return request;
    }

    static validateRequest(request) {
        if (!Array.isArray(request.contents) || !request.contents.length) {
            throw this.invalidRequest("requires a non-empty conversation.");
        }
        if (
            request.contents.some(
                content =>
                    !content ||
                    !Array.isArray(content.parts) ||
                    !content.parts.length ||
                    content.parts.some(part => !part || typeof part !== "object" || Array.isArray(part))
            )
        ) {
            throw this.invalidRequest("each conversation turn must contain valid parts.");
        }
        if (request.tools != null && !Array.isArray(request.tools)) {
            throw this.invalidRequest("tools must be an array.");
        }
        if (request.tools?.length || request.toolConfig || request.cachedContent) {
            throw Object.assign(
                new Error(
                    "Anti-truncation aliases do not support client tools, forced built-in tools or cachedContent; use the original model for these requests."
                ),
                { status: 400 }
            );
        }
        const generation = request.generationConfig;
        if (
            generation.maxOutputTokens !== undefined &&
            (!Number.isInteger(generation.maxOutputTokens) || generation.maxOutputTokens <= 0)
        ) {
            throw this.invalidRequest("maxOutputTokens must be a positive integer.");
        }
        if (
            (generation.candidateCount ?? 1) !== 1 ||
            generation.responseSchema ||
            generation.responseJsonSchema ||
            (generation.responseMimeType && generation.responseMimeType !== "text/plain") ||
            (generation.responseModalities != null &&
                (!Array.isArray(generation.responseModalities) ||
                    generation.responseModalities.some(mode => mode !== "TEXT")))
        ) {
            throw Object.assign(
                new Error(
                    "Anti-truncation aliases support one text candidate only; use the original model for structured or multimodal output."
                ),
                { status: 400 }
            );
        }
        if (
            request.systemInstruction != null &&
            (typeof request.systemInstruction !== "object" || !Array.isArray(request.systemInstruction.parts))
        ) {
            throw this.invalidRequest("systemInstruction must contain a parts array.");
        }
    }

    static async forward(handler, spec, authIndex) {
        const registry = handler.connectionRegistry;
        const parent = registry.messageQueues.get(spec.request_id)?.queue;
        if (!parent || parent.closed) return;
        let activeChild = null;
        let activeAuthIndex = authIndex;
        let cancelled = false;
        let resolveCancellation;
        const cancellation = new Promise(resolve => {
            resolveCancellation = resolve;
        });
        const stopChild = (child, reason) => {
            if (!child) return;
            try {
                handler._cancelBrowserRequest(child.id, child.authIndex, child.attempt);
            } catch (error) {
                handler.logger.warn?.(`[AntiTruncation] Failed to cancel upstream request: ${error.message}`);
            } finally {
                registry.removeMessageQueue(child.id, reason);
            }
        };
        const cancel = (reason = "client_disconnect") => {
            if (cancelled) return;
            cancelled = true;
            resolveCancellation(false);
            const child = activeChild;
            activeChild = null;
            stopChild(child, reason);
        };
        const recordAdditionalAttempt = () => {
            handler.authSwitcher.incrementUsageCount();
            if (handler.authSwitcher.shouldSwitchByUsage()) handler.needsSwitchingAfterRequest = true;
            handler
                ._getUsageStatsService()
                ?.recordAttempt(spec.request_id, activeAuthIndex, handler._getAccountNameForIndex(activeAuthIndex));
        };
        parent.once("close", cancel);
        try {
            const body = JSON.parse(spec.body);
            const cancelledError = () =>
                Object.assign(new Error("Anti-truncation request cancelled."), { cancelled: true });
            const response = await require("./DuplexToolTransport").generate(
                body,
                async requestBody => {
                    const tracker = handler._createImmediateSwitchTracker(activeAuthIndex);
                    // Keep the engine's acknowledged history and published segments intact: only this
                    // upstream round is retried, including continuation and malformed-tool repair rounds.
                    for (;;) {
                        if (cancelled || parent.closed) throw cancelledError();
                        const id = handler._generateRequestId();
                        const attempt = handler._generateRequestAttemptId(id, 1);
                        const queue = registry.createMessageQueue(id, activeAuthIndex, attempt, spec.request_id);
                        const child = { attempt, authIndex: activeAuthIndex, id };
                        activeChild = child;
                        let finished = false;
                        let attemptError = null;
                        // The deadline covers only this upstream round. Expiry stops this child, not the
                        // whole answer, so the engine can keep already accepted segments.
                        const deadline = Date.now() + handler.timeouts.FAKE_STREAM;
                        try {
                            handler._forwardRequest(
                                {
                                    ...spec,
                                    anti_truncation: false,
                                    body: JSON.stringify(requestBody),
                                    path: spec.path.replace(":streamGenerateContent", ":generateContent"),
                                    query_params: { ...spec.query_params, alt: "json" },
                                    request_attempt_id: attempt,
                                    request_id: id,
                                    streaming_mode: "fake",
                                },
                                activeAuthIndex
                            );
                            let json = "";
                            while (!finished) {
                                const remaining = deadline - Date.now();
                                if (remaining <= 0)
                                    throw Object.assign(new Error("Anti-truncation request timed out."), {
                                        status: 504,
                                    });
                                const message = await queue.dequeue(remaining);
                                if (message.event_type === "error")
                                    throw Object.assign(new Error(message.message), {
                                        retryable: message.retryable,
                                        status: message.status,
                                    });
                                if (message.event_type === "response_headers" && message.status >= 400) {
                                    throw Object.assign(new Error(`Upstream returned HTTP ${message.status}`), {
                                        status: message.status,
                                    });
                                }
                                if (message.type === "STREAM_END") {
                                    finished = true;
                                    break;
                                }
                                if (message.event_type === "chunk") json += message.data || "";
                            }
                            let response;
                            try {
                                response = JSON.parse(json);
                            } catch {
                                throw this.protocolError("upstream returned incomplete or invalid JSON.");
                            }
                            // Some browser transports return a Google error as an ordinary JSON body.
                            if (response?.error) {
                                throw Object.assign(new Error(response.error.message || "Upstream generation failed"), {
                                    status: response.error.code,
                                });
                            }
                            return response;
                        } catch (error) {
                            attemptError =
                                error.code === "QUEUE_TIMEOUT"
                                    ? Object.assign(new Error("Anti-truncation upstream round timed out."), {
                                          status: 504,
                                      })
                                    : error;
                        } finally {
                            if (!finished && !cancelled) stopChild(child, "request_failed");
                            else registry.removeMessageQueue(id);
                            if (activeChild === child) activeChild = null;
                        }
                        if (cancelled || parent.closed) throw cancelledError();
                        if (
                            attemptError.retryable === false ||
                            !handler.config?.immediateSwitchStatusCodes?.includes(Number(attemptError.status))
                        ) {
                            throw attemptError;
                        }
                        // No upstream work remains on this account. Recovery may close that context, so
                        // detach the logical parent until a new account has actually been selected.
                        if (!registry.setMessageQueueAuthIndex(spec.request_id, null, parent)) throw attemptError;
                        let retryPrepared = false;
                        try {
                            retryPrepared = await Promise.race([
                                handler._prepareImmediateStatusRetry(
                                    attemptError,
                                    spec.request_id,
                                    tracker,
                                    activeAuthIndex
                                ),
                                cancellation,
                            ]);
                        } catch (switchError) {
                            handler.logger.warn?.(`[AntiTruncation] Account retry failed: ${switchError.message}`);
                        }
                        if (cancelled || parent.closed) throw cancelledError();
                        if (!retryPrepared || !Number.isInteger(tracker.nextAuthIndex) || tracker.nextAuthIndex < 0) {
                            registry.setMessageQueueAuthIndex(spec.request_id, activeAuthIndex, parent);
                            // The outer handler must not restart the whole response after bounded retries.
                            throw Object.assign(attemptError, { retryable: false, skipAccountSwitch: true });
                        }
                        activeAuthIndex = tracker.nextAuthIndex;
                        if (!registry.setMessageQueueAuthIndex(spec.request_id, activeAuthIndex, parent)) {
                            throw Object.assign(attemptError, { retryable: false, skipAccountSwitch: true });
                        }
                        recordAdditionalAttempt();
                    }
                },
                reason => {
                    recordAdditionalAttempt();
                    handler.logger.info(
                        reason === "repair"
                            ? `[AntiTruncation] Retrying rejected transport call for ${spec.request_id}`
                            : `[AntiTruncation] Requesting next segment for ${spec.request_id}`
                    );
                },
                segment => {
                    if (spec.anti_truncation_segments) parent.enqueue({ event_type: "tool_output", ...segment });
                },
                diagnostic => {
                    const detail =
                        diagnostic.type === "interrupted"
                            ? `upstream round failed after ${diagnostic.segments} accepted segment(s) ` +
                              `(status ${diagnostic.status ?? "unknown"}: ${diagnostic.message}); returning them as incomplete`
                            : `${diagnostic.type === "repair" ? "rejected" : "repair exhausted on"} transport call: ${diagnostic.issue}`;
                    handler.logger.warn?.(`[AntiTruncation] ${spec.request_id}: ${detail}`);
                }
            );
            if (cancelled || parent.closed) throw cancelledError();
            parent.enqueue({
                event_type: "response_headers",
                headers: { "content-type": "application/json" },
                status: 200,
            });
            parent.enqueue({ data: JSON.stringify(response), event_type: "chunk" });
            parent.enqueue({ type: "STREAM_END" });
        } catch (error) {
            parent.enqueue({
                event_type: "error",
                message: error.message,
                ...(error.retryable === false ? { retryable: false } : {}),
                ...(error.skipAccountSwitch ? { skipAccountSwitch: true } : {}),
                status: error.code === "QUEUE_TIMEOUT" ? 504 : Number(error.status) || 502,
            });
        } finally {
            parent.removeListener("close", cancel);
        }
    }
}

module.exports = AntiTruncation;
