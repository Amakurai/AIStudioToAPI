/**
 * File: src/core/FormatConverter/ResponsesStreamResponseConverter.js
 * Description: OpenAI Responses streaming response conversion, SSE events, and incremental state.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const ResponsesNonStreamResponseConverter = require("./ResponsesNonStreamResponseConverter");

class ResponsesStreamResponseConverter extends ResponsesNonStreamResponseConverter {
    /**
     * Convert Google streaming chunk to OpenAI Response API format
     * @param {string} googleChunk - Google API streaming chunk
     * @param {string} modelName - Model name
     * @param {object} streamState - State object to track stream progress
     * @returns {string|null} - SSE formatted events for Response API
     */
    translateGoogleToResponseAPIStream(googleChunk, modelName = "gemini-flash-lite-latest", streamState = null) {
        this.logger.debug(`[Adapter] Debug: Received Google chunk for Response API: ${googleChunk}`);

        // Ensure streamState exists
        if (!streamState) {
            this.logger.warn("[Adapter] streamState not provided, creating default state.");
            streamState = {};
        }

        if (streamState.completed || !googleChunk || googleChunk.trim() === "") {
            return null;
        }

        const eventsToSend = [];

        const pushEvent = (eventType, payload) => {
            // sequence_number is zero-based and increases once per emitted event.
            if (!Number.isInteger(streamState.sequenceNumber)) streamState.sequenceNumber = -1;
            streamState.sequenceNumber++;

            // The Responses function-calling stream documents response_id on argument
            // events and on output-item events whose item is a function_call. Generic
            // text/reasoning output events do not carry this top-level field.
            const isFunctionCallEvent =
                eventType === "response.function_call_arguments.delta" ||
                eventType === "response.function_call_arguments.done" ||
                ((eventType === "response.output_item.added" || eventType === "response.output_item.done") &&
                    payload?.item?.type === "function_call");

            const eventPayload = {
                ...payload,
                ...(isFunctionCallEvent ? { response_id: streamState.id } : {}),
                sequence_number: streamState.sequenceNumber,
                type: eventType,
            };

            eventsToSend.push(`event: ${eventType}\ndata: ${JSON.stringify(eventPayload)}\n\n`);
        };

        const ensureInitialized = () => {
            if (streamState.initialized) return;

            streamState.initialized = true;
            streamState.id = streamState.id || `resp_${this._generateRequestId()}`;
            streamState.created_at = streamState.created_at || Math.floor(Date.now() / 1000);

            streamState.outputItemsByIndex = [];
            streamState.nextOutputIndex = 0;
            streamState.messageItem = null;
            streamState.messageText = "";
            streamState.reasoningItem = null;
            streamState.reasoningSummaryText = "";
            streamState.reasoningSummaryPartAdded = false;
            streamState.webSearchCallsByGoogleId = Object.create(null);
            streamState.webSearchCallOrder = [];
            streamState.hasNativeUrlContext = false;
            streamState.openPageCallsByGoogleId = Object.create(null);
            streamState.urlContextUrls = [];
            streamState.messageAnnotations = [];
            streamState.messageAnnotationKeys = Object.create(null);
            streamState.messagePartRanges = new Map();
            streamState.groundingChunks = [];
            streamState.groundingSupports = [];
            streamState.webSearchQueries = [];
            streamState.codeInterpreterCalls = [];
            streamState.codeInterpreterContainerId = null;
            streamState.completed = false;
        };

        // include controls conversion but is a request field, not a Response field.
        const { include: responseInclude, ...responseFields } = streamState.responseDefaults || {};
        const buildResponseObject = (overrides = {}) => ({
            completed_at: null,
            created_at: streamState.created_at,
            error: null,
            id: streamState.id,
            incomplete_details: null,
            instructions: null,
            max_output_tokens: null,
            metadata: {},
            model: modelName,
            object: "response",
            output: [],
            parallel_tool_calls: true,
            previous_response_id: null,
            reasoning: {
                effort: null,
                summary: null,
            },
            service_tier: "default",
            status: "in_progress",
            temperature: 1.0,
            text: {
                format: {
                    type: "text",
                },
            },
            tool_choice: "auto",
            tools: [],
            top_p: 1.0,
            truncation: "disabled",
            usage: null,
            user: null,
            ...responseFields,
            ...overrides,
            // This proxy does not support OpenAI-side persistence.
            ...{ store: false },
        });

        const ensureMessageItem = () => {
            if (streamState.messageItem) return streamState.messageItem;

            const itemId = `msg_${this._generateRequestId()}`;
            const outputIndex = streamState.nextOutputIndex++;

            streamState.messageItem = {
                content: [],
                content_index: 0,
                id: itemId,
                output_index: outputIndex,
                role: "assistant",
                status: "in_progress",
                type: "message",
            };

            // Reserve the output slot so subsequent items get unique output_index values.
            streamState.outputItemsByIndex[outputIndex] = {
                content: [],
                id: itemId,
                role: "assistant",
                status: "in_progress",
                type: "message",
            };

            pushEvent("response.output_item.added", {
                item: {
                    content: [],
                    id: itemId,
                    role: "assistant",
                    status: "in_progress",
                    type: "message",
                },
                output_index: outputIndex,
            });

            pushEvent("response.content_part.added", {
                content_index: 0,
                item_id: itemId,
                output_index: outputIndex,
                part: {
                    annotations: [],
                    logprobs: [],
                    text: "",
                    type: "output_text",
                },
            });

            return streamState.messageItem;
        };

        const ensureReasoningItem = () => {
            if (streamState.reasoningItem) return streamState.reasoningItem;

            const itemId = `rsn_${this._generateRequestId()}`;
            const outputIndex = streamState.nextOutputIndex++;

            streamState.reasoningItem = {
                id: itemId,
                output_index: outputIndex,
                status: "in_progress",
                summary_index: 0,
                type: "reasoning",
            };

            streamState.outputItemsByIndex[outputIndex] = {
                id: itemId,
                status: "in_progress",
                summary: [],
                type: "reasoning",
            };

            pushEvent("response.output_item.added", {
                item: {
                    id: itemId,
                    status: "in_progress",
                    summary: [],
                    type: "reasoning",
                },
                output_index: outputIndex,
            });

            return streamState.reasoningItem;
        };

        const includeWebSearchSources =
            Array.isArray(responseInclude) && responseInclude.includes("web_search_call.action.sources");
        const includeCodeInterpreterOutputs =
            Array.isArray(responseInclude) && responseInclude.includes("code_interpreter_call.outputs");

        const getCodeInterpreterContainerId = () => {
            if (streamState.codeInterpreterContainerId) return streamState.codeInterpreterContainerId;
            const requestedContainer = responseFields.tools?.find(tool => tool?.type === "code_interpreter")?.container;
            streamState.codeInterpreterContainerId =
                typeof requestedContainer === "string" && requestedContainer
                    ? requestedContainer
                    : `cntr_${this._generateRequestId()}`;
            return streamState.codeInterpreterContainerId;
        };

        const ensureCodeInterpreterCall = (googleCallId, code = "") => {
            const existing =
                typeof googleCallId === "string" && googleCallId
                    ? streamState.codeInterpreterCalls.find(call => call.google_call_id === googleCallId)
                    : null;
            if (existing) {
                if (!existing.code && typeof code === "string") existing.code = code;
                return existing;
            }

            const call = {
                code: typeof code === "string" ? code : "",
                google_call_id: typeof googleCallId === "string" ? googleCallId : null,
                id: `ci_${this._generateRequestId()}`,
                output_index: streamState.nextOutputIndex++,
                status: "in_progress",
            };
            streamState.codeInterpreterCalls.push(call);
            return call;
        };

        const findCodeInterpreterCall = googleCallId => {
            if (typeof googleCallId === "string" && googleCallId) {
                const matched = streamState.codeInterpreterCalls.find(call => call.google_call_id === googleCallId);
                if (matched) return matched;
            }
            return streamState.codeInterpreterCalls.find(call => call.status === "in_progress") || null;
        };

        const completeCodeInterpreterCall = (call, executionResult = null, forcedStatus = null) => {
            if (!call || call.status !== "in_progress") return;
            const outcome = String(executionResult?.outcome || "");
            const output = typeof executionResult?.output === "string" ? executionResult.output : "";
            const outputs = output ? [{ logs: output, type: "logs" }] : [];
            const status = forcedStatus || (outcome && outcome !== "OUTCOME_OK" ? "failed" : "completed");
            const completedItem = {
                code: call.code || null,
                container_id: getCodeInterpreterContainerId(),
                id: call.id,
                outputs: includeCodeInterpreterOutputs ? outputs : null,
                status,
                type: "code_interpreter_call",
            };
            call.status = status;
            streamState.outputItemsByIndex[call.output_index] = completedItem;
            pushEvent("response.output_item.added", {
                item: completedItem,
                output_index: call.output_index,
            });
            pushEvent("response.output_item.done", {
                item: completedItem,
                output_index: call.output_index,
            });
        };

        const ensureWebSearchCall = (googleCallId, queries = []) => {
            const normalizedQueries = this._normalizeWebSearchQueries(queries);
            const lookupKey =
                typeof googleCallId === "string" && googleCallId
                    ? googleCallId
                    : streamState.webSearchCallOrder[0] || `grounding_${this._generateRequestId()}`;
            const existing = streamState.webSearchCallsByGoogleId[lookupKey];

            if (existing) {
                if (
                    existing.status !== "completed" &&
                    normalizedQueries.length > 0 &&
                    (existing.action.queries || []).length === 0
                ) {
                    existing.action.queries = normalizedQueries;
                }
                return existing;
            }

            const outputIndex = streamState.nextOutputIndex++;
            const searchCall = {
                action: {
                    ...(normalizedQueries.length > 0 ? { queries: normalizedQueries } : {}),
                    type: "search",
                },
                google_call_id: lookupKey,
                id: `ws_${this._generateRequestId()}`,
                output_index: outputIndex,
                status: "in_progress",
            };

            streamState.webSearchCallsByGoogleId[lookupKey] = searchCall;
            streamState.webSearchCallOrder.push(lookupKey);

            const item = {
                action: searchCall.action,
                id: searchCall.id,
                status: "in_progress",
                type: "web_search_call",
            };
            streamState.outputItemsByIndex[outputIndex] = item;

            pushEvent("response.output_item.added", {
                item,
                output_index: outputIndex,
            });
            pushEvent("response.web_search_call.in_progress", {
                item_id: searchCall.id,
                output_index: outputIndex,
            });
            pushEvent("response.web_search_call.searching", {
                item_id: searchCall.id,
                output_index: outputIndex,
            });

            return searchCall;
        };

        const completeWebSearchCall = searchCall => {
            if (!searchCall || searchCall.status === "completed") return;

            if (includeWebSearchSources && searchCall.action.type === "search") {
                // Gemini reports sources in response-level grounding metadata, which
                // can arrive after the native tool response. Finalize only once all
                // chunks have arrived so output_item.done matches response.completed.
                searchCall.action.sources = this._extractResponseWebSearchSources(streamState.groundingChunks);
            }
            searchCall.status = "completed";
            const completedItem = {
                action: searchCall.action,
                id: searchCall.id,
                status: "completed",
                type: "web_search_call",
            };
            streamState.outputItemsByIndex[searchCall.output_index] = completedItem;

            pushEvent("response.web_search_call.completed", {
                item_id: searchCall.id,
                output_index: searchCall.output_index,
            });
            pushEvent("response.output_item.done", {
                item: completedItem,
                output_index: searchCall.output_index,
            });
        };

        const findWebSearchCall = googleCallId => {
            if (typeof googleCallId === "string" && googleCallId) {
                return streamState.webSearchCallsByGoogleId[googleCallId] || null;
            }

            const lastKey = streamState.webSearchCallOrder[streamState.webSearchCallOrder.length - 1];
            return lastKey ? streamState.webSearchCallsByGoogleId[lastKey] : null;
        };

        const addOpenPageCall = url => {
            const call = {
                action: { type: "open_page", url },
                id: `ws_${this._generateRequestId()}`,
                output_index: streamState.nextOutputIndex++,
                status: "in_progress",
            };
            const item = {
                action: call.action,
                id: call.id,
                status: call.status,
                type: "web_search_call",
            };
            streamState.outputItemsByIndex[call.output_index] = item;
            pushEvent("response.output_item.added", { item, output_index: call.output_index });
            pushEvent("response.web_search_call.in_progress", {
                item_id: call.id,
                output_index: call.output_index,
            });
            return call;
        };

        const finalizeReasoningItem = () => {
            if (!streamState.reasoningItem) return;
            if (streamState.reasoningItem.status === "completed") return;

            const itemId = streamState.reasoningItem.id;
            const outputIndex = streamState.reasoningItem.output_index;
            const summaryIndex = streamState.reasoningItem.summary_index ?? 0;
            const finalText = streamState.reasoningSummaryText || "";

            pushEvent("response.reasoning_summary_text.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: summaryIndex,
                text: finalText,
            });

            pushEvent("response.reasoning_summary_part.done", {
                item_id: itemId,
                output_index: outputIndex,
                part: {
                    text: finalText,
                    type: "summary_text",
                },
                summary_index: summaryIndex,
            });

            const completedItem = {
                id: itemId,
                status: "completed",
                summary: [
                    {
                        text: finalText,
                        type: "summary_text",
                    },
                ],
                type: "reasoning",
            };

            streamState.reasoningItem.status = "completed";
            streamState.outputItemsByIndex[outputIndex] = completedItem;

            pushEvent("response.output_item.done", {
                item: completedItem,
                output_index: outputIndex,
            });
        };

        const finalizeMessageItem = (status = "completed") => {
            if (!streamState.messageItem) return;
            if (streamState.messageItem.status !== "in_progress") return;

            const itemId = streamState.messageItem.id;
            const outputIndex = streamState.messageItem.output_index;
            const contentIndex = streamState.messageItem.content_index;
            const finalText = streamState.messageText || "";
            const annotations = streamState.messageAnnotations || [];

            pushEvent("response.output_text.done", {
                content_index: contentIndex,
                item_id: itemId,
                logprobs: [],
                output_index: outputIndex,
                text: finalText,
            });

            pushEvent("response.content_part.done", {
                content_index: contentIndex,
                item_id: itemId,
                output_index: outputIndex,
                part: {
                    annotations,
                    logprobs: [],
                    text: finalText,
                    type: "output_text",
                },
            });

            const completedItem = {
                content: [
                    {
                        annotations,
                        logprobs: [],
                        text: finalText,
                        type: "output_text",
                    },
                ],
                id: itemId,
                role: "assistant",
                status,
                type: "message",
            };

            streamState.messageItem.status = status;
            streamState.messageItem.content = completedItem.content;

            streamState.outputItemsByIndex[outputIndex] = completedItem;

            pushEvent("response.output_item.done", {
                item: completedItem,
                output_index: outputIndex,
            });
        };

        const handleGoogleResponseObject = googleResponse => {
            if (streamState.completed) return;
            ensureInitialized();

            // Cache usage data if present
            if (googleResponse?.usageMetadata) {
                streamState.usage = this._parseUsage(googleResponse);
            }

            const candidate = googleResponse?.candidates?.[0];
            if (!candidate) {
                if (googleResponse?.promptFeedback) {
                    this.logger.warn(
                        `[Adapter] Google returned promptFeedback for Response API stream: ${JSON.stringify(
                            googleResponse.promptFeedback
                        )}`
                    );
                }
                const message = this._getGeminiPromptBlockMessage(googleResponse?.promptFeedback);
                if (message) {
                    streamState.error = { code: "invalid_prompt", message };
                    pushEvent("error", { ...streamState.error, param: null });
                    streamState.completed = true;
                }
                return;
            }

            const candidateParts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
            const candidatePartRanges = new Map();
            let candidateTextOffset = streamState.messageText.length;
            let imageNoticePending = !streamState.imageOutputSuppressedNoticeSent;
            for (let partIndex = 0; partIndex < candidateParts.length; partIndex++) {
                const part = candidateParts[partIndex];
                if (part?.thought === true) continue;
                if (typeof part?.text === "string" && part.text) {
                    const currentPartRange = {
                        startIndex: candidateTextOffset,
                        text: part.text,
                    };
                    candidatePartRanges.set(partIndex, currentPartRange);
                    const accumulatedPartRange = streamState.messagePartRanges.get(partIndex);
                    if (
                        accumulatedPartRange &&
                        accumulatedPartRange.startIndex + accumulatedPartRange.text.length === candidateTextOffset
                    ) {
                        accumulatedPartRange.text += part.text;
                    } else {
                        streamState.messagePartRanges.set(partIndex, { ...currentPartRange });
                    }
                    candidateTextOffset += part.text.length;
                } else if (part?.inlineData && imageNoticePending) {
                    candidateTextOffset +=
                        "[Image output omitted: Responses API image outputs are disabled by this proxy.]".length;
                    imageNoticePending = false;
                }
            }

            const candidateGrounding = candidate.groundingMetadata;
            if (candidateGrounding) {
                if (Array.isArray(candidateGrounding.groundingChunks)) {
                    streamState.groundingChunks.push(...candidateGrounding.groundingChunks);
                }
                if (Array.isArray(candidateGrounding.groundingSupports)) {
                    streamState.groundingSupports.push(
                        ...candidateGrounding.groundingSupports.map(support => ({
                            ...support,

                            _responseTextChunkRange: candidatePartRanges.get(support?.segment?.partIndex),
                            // Snapshot both interpretations: Gemini metadata may
                            // describe the accumulated Part or this chunk's delta.
                            _responseTextPartRange: streamState.messagePartRanges.has(support?.segment?.partIndex)
                                ? { ...streamState.messagePartRanges.get(support.segment.partIndex) }
                                : candidatePartRanges.get(support?.segment?.partIndex),
                        }))
                    );
                }
                streamState.webSearchQueries = this._normalizeWebSearchQueries([
                    ...streamState.webSearchQueries,
                    ...this._normalizeWebSearchQueries(candidateGrounding.webSearchQueries),
                ]);
            }

            // Emit the initial response state events once
            if (!streamState.responseSent) {
                pushEvent("response.created", {
                    response: buildResponseObject({
                        output: [],
                        status: "in_progress",
                        usage: null,
                    }),
                });
                pushEvent("response.in_progress", {
                    response: buildResponseObject({
                        output: [],
                        status: "in_progress",
                        usage: null,
                    }),
                });
                streamState.responseSent = true;
            }

            // Parts -> SSE events
            if (candidateParts.length > 0) {
                for (const part of candidateParts) {
                    // The Responses API exposes reasoning summaries via `summary` + `response.reasoning_summary_text.*`.
                    // Map Gemini "thought" parts to reasoning *summary* to match official expectations.
                    if (part?.thought === true) {
                        if (part?.text) {
                            const reasoningItem = ensureReasoningItem();
                            streamState.reasoningSummaryText += part.text;

                            if (!streamState.reasoningSummaryPartAdded) {
                                streamState.reasoningSummaryPartAdded = true;
                                pushEvent("response.reasoning_summary_part.added", {
                                    item_id: reasoningItem.id,
                                    output_index: reasoningItem.output_index,
                                    part: {
                                        text: "",
                                        type: "summary_text",
                                    },
                                    summary_index: reasoningItem.summary_index ?? 0,
                                });
                            }

                            pushEvent("response.reasoning_summary_text.delta", {
                                delta: part.text,
                                item_id: reasoningItem.id,
                                output_index: reasoningItem.output_index,
                                summary_index: reasoningItem.summary_index ?? 0,
                            });
                        }
                        continue;
                    }

                    if (part?.toolCall?.toolType === "GOOGLE_SEARCH_WEB") {
                        const toolCall = part.toolCall;
                        ensureWebSearchCall(toolCall.id, toolCall.args?.queries || toolCall.args?.query);
                        continue;
                    }

                    if (part?.toolResponse?.toolType === "GOOGLE_SEARCH_WEB") {
                        const toolResponse = part.toolResponse;
                        findWebSearchCall(toolResponse.id) || ensureWebSearchCall(toolResponse.id);
                        continue;
                    }

                    if (part?.toolCall?.toolType === "URL_CONTEXT") {
                        streamState.hasNativeUrlContext = true;
                        const toolCall = part.toolCall;
                        const calls = (streamState.openPageCallsByGoogleId[toolCall.id] ||= []);
                        for (const url of toolCall.args?.urls || []) {
                            if (typeof url === "string" && url) calls.push(addOpenPageCall(url));
                        }
                        continue;
                    }

                    if (part?.toolResponse?.toolType === "URL_CONTEXT") {
                        streamState.hasNativeUrlContext = true;
                        const toolResponse = part.toolResponse;
                        const calls =
                            streamState.openPageCallsByGoogleId[toolResponse.id] ||
                            this._extractResponseUrlContextUrls(toolResponse.response).map(addOpenPageCall);
                        calls.forEach(completeWebSearchCall);
                        continue;
                    }

                    if (part?.executableCode) {
                        ensureCodeInterpreterCall(part.executableCode.id, part.executableCode.code);
                        continue;
                    }

                    if (part?.codeExecutionResult) {
                        const call =
                            findCodeInterpreterCall(part.codeExecutionResult.id) ||
                            ensureCodeInterpreterCall(part.codeExecutionResult.id);
                        completeCodeInterpreterCall(call, part.codeExecutionResult);
                        continue;
                    }

                    if (part?.text) {
                        const messageItem = ensureMessageItem();
                        streamState.messageText += part.text;

                        pushEvent("response.output_text.delta", {
                            content_index: messageItem.content_index,
                            delta: part.text,
                            item_id: messageItem.id,
                            logprobs: [],
                            output_index: messageItem.output_index,
                        });
                    } else if (part?.inlineData) {
                        // This proxy intentionally does not expose image outputs in Responses API because many
                        // clients treat `image_generation_call` as a hosted tool call and may initiate a second
                        // tool-execution roundtrip that Gemini image models cannot support (function calling).
                        // Emit a one-time text note so clients don't get an empty response.
                        if (!streamState.imageOutputSuppressedNoticeSent) {
                            streamState.imageOutputSuppressedNoticeSent = true;
                            const messageItem = ensureMessageItem();
                            const note =
                                "[Image output omitted: Responses API image outputs are disabled by this proxy.]";
                            streamState.messageText += note;
                            pushEvent("response.output_text.delta", {
                                content_index: messageItem.content_index,
                                delta: note,
                                item_id: messageItem.id,
                                logprobs: [],
                                output_index: messageItem.output_index,
                            });
                        }
                    } else if (part?.functionCall) {
                        const funcCall = part.functionCall;
                        const responseFunctionIdentity = this._resolveResponseFunctionIdentity(
                            funcCall.name,
                            streamState.responseFunctionNameMap
                        );
                        const isCustom = responseFunctionIdentity.type === "custom";
                        const itemId = `${isCustom ? "ctc" : "fc"}_${this._generateRequestId()}`;
                        // Pass the Gemini-issued function call id through as the Responses API
                        // `call_id` so it round-trips back into `functionCall.id` /
                        // `functionResponse.id` on the next request (needed to pair parallel
                        // calls). Fall back to a generated id when the backend omits it.
                        const callId =
                            typeof funcCall.id === "string" && funcCall.id
                                ? funcCall.id
                                : `call_${this._generateRequestId()}`;
                        const args = isCustom ? funcCall.args?.input : JSON.stringify(funcCall.args || {});
                        if (typeof args !== "string") {
                            this.logger.warn(
                                `[Adapter] Skipping custom tool ${responseFunctionIdentity.name}: returned a non-string input`
                            );
                            continue;
                        }
                        const outputIndex = streamState.nextOutputIndex++;
                        const inputField = isCustom ? "input" : "arguments";
                        const callType = isCustom ? "custom_tool_call" : "function_call";
                        const inputEvent = isCustom
                            ? "response.custom_tool_call_input"
                            : "response.function_call_arguments";

                        pushEvent("response.output_item.added", {
                            item: {
                                call_id: callId,
                                id: itemId,
                                [inputField]: "",
                                name: responseFunctionIdentity.name,
                                ...(responseFunctionIdentity.namespace
                                    ? { namespace: responseFunctionIdentity.namespace }
                                    : {}),
                                status: "in_progress",
                                type: callType,
                            },
                            output_index: outputIndex,
                        });

                        pushEvent(`${inputEvent}.delta`, {
                            delta: args,
                            item_id: itemId,
                            output_index: outputIndex,
                        });

                        pushEvent(`${inputEvent}.done`, {
                            [inputField]: args,
                            item_id: itemId,
                            output_index: outputIndex,
                        });

                        const completedToolItem = {
                            call_id: callId,
                            id: itemId,
                            [inputField]: args,
                            name: responseFunctionIdentity.name,
                            ...(responseFunctionIdentity.namespace
                                ? { namespace: responseFunctionIdentity.namespace }
                                : {}),
                            status: "completed",
                            type: callType,
                        };
                        streamState.outputItemsByIndex[outputIndex] = completedToolItem;

                        pushEvent("response.output_item.done", {
                            item: completedToolItem,
                            output_index: outputIndex,
                        });

                        this.logger.debug(
                            `[Adapter] Converted Gemini functionCall to Response API ${callType}: ${responseFunctionIdentity.namespace ? `${responseFunctionIdentity.namespace}.` : ""}${responseFunctionIdentity.name} (call_id: ${callId})`
                        );
                    }
                }
            }

            const urlContextUrls = this._extractResponseUrlContextUrls(
                candidate.urlContextMetadata || candidate.url_context_metadata
            );
            if (urlContextUrls.length > 0) streamState.urlContextUrls = urlContextUrls;

            // Completion
            if (candidate.finishReason && !streamState.completed) {
                for (const call of streamState.codeInterpreterCalls) {
                    completeCodeInterpreterCall(call, null, "incomplete");
                }
                // Metadata is a fallback for responses without native tool invocations.
                if (!streamState.hasNativeUrlContext) {
                    streamState.urlContextUrls.map(addOpenPageCall).forEach(completeWebSearchCall);
                }
                for (const calls of Object.values(streamState.openPageCallsByGoogleId)) {
                    calls.forEach(completeWebSearchCall);
                }
                const grounding = this._extractResponseWebSearchGrounding(
                    {
                        groundingMetadata: {
                            groundingChunks: streamState.groundingChunks,
                            groundingSupports: streamState.groundingSupports,
                            webSearchQueries: streamState.webSearchQueries,
                        },
                    },
                    streamState.messageText || ""
                );
                if (
                    grounding.queries.length > 0 ||
                    (grounding.annotations.length > 0 &&
                        !streamState.hasNativeUrlContext &&
                        streamState.urlContextUrls.length === 0) ||
                    (streamState.groundingChunks.length > 0 &&
                        !streamState.hasNativeUrlContext &&
                        streamState.urlContextUrls.length === 0) ||
                    streamState.webSearchCallOrder.length > 0
                ) {
                    const searchCall = findWebSearchCall();
                    if (!searchCall) {
                        ensureWebSearchCall(null, grounding.queries);
                    } else if (
                        searchCall.status !== "completed" &&
                        (searchCall.action.queries || []).length === 0 &&
                        grounding.queries.length > 0
                    ) {
                        searchCall.action.queries = grounding.queries;
                    }
                    for (const lookupKey of streamState.webSearchCallOrder) {
                        completeWebSearchCall(streamState.webSearchCallsByGoogleId[lookupKey]);
                    }
                }

                streamState.messageAnnotations = grounding.annotations;
                if (streamState.messageItem) {
                    grounding.annotations.forEach((annotation, annotationIndex) => {
                        const annotationKey = `${annotation.start_index}:${annotation.end_index}:${annotation.url}`;
                        if (streamState.messageAnnotationKeys[annotationKey]) return;
                        streamState.messageAnnotationKeys[annotationKey] = true;
                        pushEvent("response.output_text.annotation.added", {
                            annotation,
                            annotation_index: annotationIndex,
                            content_index: streamState.messageItem.content_index,
                            item_id: streamState.messageItem.id,
                            output_index: streamState.messageItem.output_index,
                        });
                    });
                }

                const incompleteReason = this._antiTruncationIncompleteReason(candidate, modelName);
                finalizeReasoningItem();
                finalizeMessageItem(incompleteReason ? "incomplete" : "completed");

                const usage = streamState.usage || {
                    completion_tokens: 0,
                    prompt_tokens: 0,
                    total_tokens: 0,
                };

                const responseUsage = {
                    input_tokens: usage.prompt_tokens,
                    input_tokens_details: {
                        cache_write_tokens: 0,
                        cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
                    },
                    output_tokens: usage.completion_tokens,
                    output_tokens_details: {
                        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
                    },
                    total_tokens: usage.total_tokens,
                };

                const completedAt = Math.floor(Date.now() / 1000);
                const finalOutput = (streamState.outputItemsByIndex || []).filter(Boolean);

                pushEvent(incompleteReason ? "response.incomplete" : "response.completed", {
                    response: buildResponseObject({
                        completed_at: incompleteReason ? null : completedAt,
                        incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
                        output: finalOutput,
                        status: incompleteReason ? "incomplete" : "completed",
                        usage: responseUsage,
                    }),
                });

                streamState.completed = true;
            }
        };

        // Google streaming might concatenate multiple SSE frames; handle them safely.
        const frames = String(googleChunk)
            .split(/\n\n+/)
            .map(s => s.trim())
            .filter(Boolean);

        for (const frame of frames) {
            let jsonString = frame;
            if (jsonString.startsWith("data:")) {
                jsonString = jsonString.replace(/^data:\s*/i, "").trim();
            }

            if (jsonString === "[DONE]") {
                continue; // Responses streaming does not use [DONE]
            }

            try {
                const googleResponse = JSON.parse(jsonString);
                handleGoogleResponseObject(googleResponse);
            } catch (e) {
                this.logger.warn(`[Adapter] Unable to parse Google JSON chunk for Response API: ${jsonString}`);
            }
        }

        return eventsToSend.length > 0 ? eventsToSend.join("") : null;
    }
}

module.exports = ResponsesStreamResponseConverter;
