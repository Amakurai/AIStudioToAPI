/** Internal tool transport for the two opt-in Flash aliases. */
class AntiTruncation {
    static TOOL = "deliver_response";
    static MAX_FOLLOWUPS = 2;
    static MAX_SMALL_BUDGET_FOLLOWUPS = 5;
    static MAX_TOOL_REPAIRS = 2;
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

    static textChunkLimit(maxOutputTokens) {
        return Math.min(12000, Math.max(64, maxOutputTokens || 12000));
    }

    static chunkInstruction(limit) {
        return (
            `Each deliver_response call must contain at most ${limit} characters of text. ` +
            "End at a line or sentence boundary within this limit, leaving room to finish the tool arguments. " +
            "When more answer text remains, set done=false and wait for acknowledgement before continuing. " +
            "Keep every character and newline; never omit the remainder to fit a chunk."
        );
    }

    static maxWaitMs(perCallTimeout) {
        // A duplex answer can need several independent upstream calls, including repairs.
        return perCallTimeout * (2 + this.MAX_SMALL_BUDGET_FOLLOWUPS + this.MAX_TOOL_REPAIRS) + 1000;
    }

    static baseModel(model) {
        if (typeof model !== "string") return null;
        let decoded;
        try {
            decoded = decodeURIComponent(model);
        } catch {
            return null;
        }
        const match = decoded.match(/^(gemini-3\.[78]-flash)-抗截断$/);
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

    static prepare(body) {
        const request = this.normalizeRequest(body);
        this.validateRequest(request);
        const generation = request.generationConfig;
        // These Flash models require a final ordinary user turn, including native requests.
        const last = request.contents[request.contents.length - 1];
        if (last.role !== "user" || last.parts?.some(part => part.functionCall || part.functionResponse)) {
            request.contents.push({ parts: [{ text: "\n" }], role: "user" });
        }
        request.generationConfig = { ...generation, candidateCount: 1 };
        // Stop sequences apply to visible text, not the internal tool's JSON serialization.
        delete request.generationConfig.responseMimeType;
        request.tools = [
            {
                functionDeclarations: [
                    {
                        description:
                            "Deliver the next contiguous portion of the user-facing answer. This is a text transport, not an external action.",
                        name: this.TOOL,
                        parameters: {
                            properties: {
                                done: {
                                    description: "True only when the entire requested answer is complete.",
                                    type: "BOOLEAN",
                                },
                                text: {
                                    description:
                                        "Exact next answer text, preserving all whitespace, Markdown and XML. Never repeat previously delivered text.",
                                    type: "STRING",
                                },
                            },
                            required: ["text", "done"],
                            type: "OBJECT",
                        },
                    },
                ],
            },
        ];
        request.toolConfig = { functionCallingConfig: { allowedFunctionNames: [this.TOOL], mode: "ANY" } };
        const instruction =
            "Response transport: deliver your user-facing answer only through deliver_response(text, done). " +
            "Preserve the requested language and format exactly. Put only the answer in text, not private reasoning. " +
            "If the full answer fits within the per-call text limit, send it once with done=true. Otherwise send a contiguous portion with done=false. " +
            "After acknowledgement, continue exactly where the previous text ended without repeating it. " +
            "Do not summarize or shorten the answer to fit. Set done=true only after completing the user's request. " +
            this.chunkInstruction(this.textChunkLimit(generation.maxOutputTokens));
        request.systemInstruction = {
            ...(request.systemInstruction || {}),
            parts: [...(request.systemInstruction?.parts || []), { text: instruction }],
        };
        return request;
    }

    static async generate(body, send, onFollowup = () => {}) {
        const request = this.prepare(body);
        let text = "";
        let finalResponse;
        let completed = false;
        let repairs = 0;
        let chunkLimit = this.textChunkLimit(request.generationConfig.maxOutputTokens);
        const maxFollowups =
            request.generationConfig.maxOutputTokens <= 8192 ? this.MAX_SMALL_BUDGET_FOLLOWUPS : this.MAX_FOLLOWUPS;
        const usage = {};
        const stops = request.generationConfig.stopSequences;
        delete request.generationConfig.stopSequences;
        for (let round = 0; round <= maxFollowups; round++) {
            if (round || repairs) onFollowup();
            const response = await send(request);
            if (!response || typeof response !== "object" || Array.isArray(response)) {
                throw this.protocolError("upstream returned an invalid response object.");
            }
            if (response.error)
                throw Object.assign(new Error(response.error.message || "Upstream generation failed"), {
                    status: response.error.code,
                });
            for (const key of [
                "promptTokenCount",
                "candidatesTokenCount",
                "totalTokenCount",
                "thoughtsTokenCount",
                "cachedContentTokenCount",
                "toolUsePromptTokenCount",
            ]) {
                if (Number.isFinite(response.usageMetadata?.[key]))
                    usage[key] = (usage[key] || 0) + response.usageMetadata[key];
            }
            const candidate = response.candidates?.[0];
            if (candidate?.finishReason === "MALFORMED_FUNCTION_CALL") {
                if (repairs >= this.MAX_TOOL_REPAIRS) {
                    if (text.length) break;
                    throw this.protocolError("tool arguments remained malformed after bounded repair attempts.");
                }
                repairs++;
                chunkLimit = Math.max(32, Math.floor(chunkLimit / 2));
                request.systemInstruction.parts.push({
                    text:
                        "The last tool call was malformed and none of its text was accepted. " +
                        "Retry only the next not-yet-acknowledged portion, starting at the same position as that failed call. " +
                        this.chunkInstruction(chunkLimit),
                });
                // Keep only acknowledged tool turns in history. Never parse diagnostic text as answer content.
                round--;
                continue;
            }
            if (!candidate) {
                if (
                    response.promptFeedback?.blockReason &&
                    response.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
                ) {
                    // Compatibility converters need a candidate to surface a content-filter result.
                    return {
                        ...response,
                        candidates: [
                            {
                                content: { parts: text ? [{ text }] : [], role: "model" },
                                finishReason: "SAFETY",
                                index: 0,
                            },
                        ],
                        usageMetadata: usage,
                    };
                }
                throw this.protocolError("upstream returned no candidate.");
            }
            if (
                !Array.isArray(response.candidates) ||
                response.candidates.length !== 1 ||
                !["STOP", "MAX_TOKENS", ...this.BLOCKED_FINISH_REASONS].includes(candidate.finishReason)
            ) {
                throw this.protocolError("upstream returned an invalid or unfinished tool response.");
            }
            // Preserve upstream blocking and refusal outcomes; never turn them into a success.
            if (!["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
                return {
                    ...response,
                    candidates: response.candidates?.map(item => ({
                        ...item,
                        content: {
                            parts: [
                                ...(text ? [{ text }] : []),
                                ...(Array.isArray(item.content?.parts)
                                    ? item.content.parts.filter(
                                          part =>
                                              part &&
                                              typeof part.text === "string" &&
                                              !part.functionCall &&
                                              !part.functionResponse
                                      )
                                    : []),
                            ],
                            role: "model",
                        },
                    })),
                    usageMetadata: usage,
                };
            }
            const parts = candidate.content?.parts;
            if (!Array.isArray(parts) || parts.some(part => !part || typeof part !== "object")) {
                throw this.protocolError("upstream returned invalid content parts.");
            }
            const calls = parts.filter(part => part.functionCall);
            if (calls.length !== 1 || calls[0].functionCall.name !== this.TOOL) {
                throw this.protocolError("upstream did not return the expected internal tool call.");
            }
            const args = calls[0].functionCall.args;
            if (
                !args ||
                typeof args.text !== "string" ||
                (typeof args.done !== "boolean" &&
                    !(candidate.finishReason === "MAX_TOKENS" && args.done === undefined))
            ) {
                throw this.protocolError("incomplete or invalid tool arguments; no malformed text was returned.");
            }
            finalResponse = response;
            text += args.text;
            const stopPositions = stops
                .filter(stop => typeof stop === "string" && stop.length)
                .map(stop => text.indexOf(stop))
                .filter(index => index >= 0);
            if (stopPositions.length) {
                text = text.slice(0, Math.min(...stopPositions));
                completed = true;
                break;
            }
            completed = args.done && candidate.finishReason !== "MAX_TOKENS";
            if (completed || !args.text.length || round === maxFollowups) break;
            request.contents.push(candidate.content);
            request.contents.push({
                parts: [
                    {
                        functionResponse: {
                            ...(calls[0].functionCall.id ? { id: calls[0].functionCall.id } : {}),
                            name: this.TOOL,
                            response: { continue: true, received: true },
                        },
                    },
                ],
                role: "user",
            });
            request.contents.push({
                parts: [
                    {
                        text: "Continue the answer from the exact next character using deliver_response. Do not repeat any text already delivered.",
                    },
                ],
                role: "user",
            });
        }
        return {
            ...finalResponse,
            candidates: [
                {
                    ...finalResponse.candidates[0],
                    content: { parts: [{ text }], role: "model" },
                    finishReason: completed ? "STOP" : "MAX_TOKENS",
                },
            ],
            usageMetadata: usage,
        };
    }

    static async forward(handler, spec, authIndex) {
        const registry = handler.connectionRegistry;
        const parent = registry.messageQueues.get(spec.request_id)?.queue;
        if (!parent || parent.closed) return;
        let activeChild = null;
        let activeAuthIndex = authIndex;
        let cancelled = false;
        let cancelReason = null;
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
            cancelReason = reason;
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
            const engine = spec.anti_truncation_mode === "duplex" ? require("./DuplexToolTransport") : this;
            const response = await engine.generate(
                body,
                async requestBody => {
                    const tracker = handler._createImmediateSwitchTracker(activeAuthIndex);
                    // Keep the engine's acknowledged history and published segments intact: only this
                    // upstream round is retried, including continuation and malformed-tool repair rounds.
                    for (;;) {
                        if (cancelled || parent.closed)
                            throw new Error("Anti-truncation request cancelled or timed out.");
                        const id = handler._generateRequestId();
                        const attempt = handler._generateRequestAttemptId(id, 1);
                        const queue = registry.createMessageQueue(id, activeAuthIndex, attempt, spec.request_id);
                        const child = { attempt, authIndex: activeAuthIndex, id };
                        activeChild = child;
                        let finished = false;
                        let attemptError = null;
                        const deadline = Date.now() + handler.timeouts.FAKE_STREAM;
                        const timer = setTimeout(() => cancel("timeout"), handler.timeouts.FAKE_STREAM);
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
                            attemptError = error;
                        } finally {
                            clearTimeout(timer);
                            if (!finished && !cancelled) stopChild(child, "request_failed");
                            else registry.removeMessageQueue(id);
                            if (activeChild === child) activeChild = null;
                        }
                        if (
                            cancelled ||
                            parent.closed ||
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
                        if (cancelled || parent.closed) throw attemptError;
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
                () => {
                    recordAdditionalAttempt();
                    handler.logger.info(`[AntiTruncation] Continuing incomplete response for ${spec.request_id}`);
                },
                segment => {
                    if (spec.anti_truncation_segments) parent.enqueue({ event_type: "tool_output", ...segment });
                }
            );
            if (cancelled || parent.closed) throw new Error("Anti-truncation request cancelled or timed out.");
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
                status:
                    cancelReason === "timeout" || error.code === "QUEUE_TIMEOUT" ? 504 : Number(error.status) || 502,
            });
        } finally {
            parent.removeListener("close", cancel);
        }
    }
}

module.exports = AntiTruncation;
