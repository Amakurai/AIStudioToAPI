/**
 * File: src/core/FormatConverter/ResponsesNonStreamResponseConverter.js
 * Description: OpenAI Responses non-streaming response conversion and helpers shared with SSE conversion.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const FormatConverter = require("./CommonConverter");

class ResponsesNonStreamResponseConverter extends FormatConverter {
    _resolveResponseFunctionIdentity(name, functionNameMap) {
        if (functionNameMap && Object.prototype.hasOwnProperty.call(functionNameMap, name)) {
            return functionNameMap[name] || { name };
        }
        return { name };
    }

    /**
     * Convert a non-streaming Gemini GenerateContent response into an OpenAI
     * Responses API response object.
     *
     * @param {object} googleResponse - Gemini GenerateContent response
     * @param {string} [modelName="gemini-flash-lite-latest"] - Model reported in the response
     * @param {object} [responseDefaults={}] - Responses request fields copied into the response; `include` is
     * used to select optional nested fields and is not echoed into the response
     * @param {Record<string, {name: string, namespace?: string, type?: string}>} [responseFunctionNameMap={}]
     * Gemini function-name aliases mapped back to their Responses API identities
     * @returns {object} OpenAI Responses API response
     */
    convertGoogleToResponseAPINonStream(
        googleResponse,
        modelName = "gemini-flash-lite-latest",
        responseDefaults = {},
        responseFunctionNameMap = {}
    ) {
        const { include: responseInclude, ...responseFields } = responseDefaults || {};
        try {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for Response API non-stream: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for Response API non-stream (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }

        const candidate = googleResponse.candidates?.[0];
        const incompleteReason = this._antiTruncationIncompleteReason(candidate, modelName);

        if (!candidate) {
            this.logger.warn("[Adapter] No candidate found in Google response");
            return {
                completed_at: Math.floor(Date.now() / 1000),
                created_at: Math.floor(Date.now() / 1000),
                error: null,
                id: `resp_${this._generateRequestId()}`,
                incomplete_details: null,
                instructions: null,
                max_output_tokens: null,
                metadata: {},
                model: modelName,
                object: "response",
                output: [],
                parallel_tool_calls: true,
                reasoning: {
                    effort: null,
                    summary: null,
                },
                service_tier: "default",
                status: "completed",
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
                usage: {
                    input_tokens: 0,
                    input_tokens_details: {
                        cache_write_tokens: 0,
                        cached_tokens: 0,
                    },
                    output_tokens: 0,
                    output_tokens_details: {
                        reasoning_tokens: 0,
                    },
                    total_tokens: 0,
                },
                ...responseFields,
                // This proxy does not support OpenAI-side persistence.
                ...{ store: false },
            };
        }

        const output = [];
        let messageContent = "";
        const messagePartRanges = new Map();
        let reasoningContent = "";
        let webSearchQueries = [];
        const nativeSearchItems = [];
        const nativeSearchItemsByGoogleId = new Map();
        const includeCodeInterpreterOutputs =
            Array.isArray(responseInclude) && responseInclude.includes("code_interpreter_call.outputs");
        const requestedCodeInterpreterContainer = responseFields.tools?.find(
            tool => tool?.type === "code_interpreter"
        )?.container;
        const codeInterpreterContainerId =
            typeof requestedCodeInterpreterContainer === "string" && requestedCodeInterpreterContainer
                ? requestedCodeInterpreterContainer
                : `cntr_${this._generateRequestId()}`;
        const codeInterpreterItems = [];
        const codeInterpreterItemsByGoogleId = new Map();
        const createCodeInterpreterItem = (googleCallId, code = "") => {
            const item = {
                code: typeof code === "string" && code ? code : null,
                container_id: codeInterpreterContainerId,
                id: `ci_${this._generateRequestId()}`,
                outputs: includeCodeInterpreterOutputs ? [] : null,
                status: "in_progress",
                type: "code_interpreter_call",
            };
            codeInterpreterItems.push(item);
            output.push(item);
            if (typeof googleCallId === "string" && googleCallId) {
                codeInterpreterItemsByGoogleId.set(googleCallId, item);
            }
            return item;
        };
        const findCodeInterpreterItem = googleCallId => {
            if (typeof googleCallId === "string" && googleCallId) {
                const matched = codeInterpreterItemsByGoogleId.get(googleCallId);
                if (matched) return matched;
            }
            return codeInterpreterItems.find(item => item.status === "in_progress") || null;
        };
        const completeCodeInterpreterItem = (item, executionResult) => {
            const outcome = String(executionResult?.outcome || "");
            const executionOutput = typeof executionResult?.output === "string" ? executionResult.output : "";
            item.status = outcome && outcome !== "OUTCOME_OK" ? "failed" : "completed";
            if (includeCodeInterpreterOutputs) {
                item.outputs = executionOutput ? [{ logs: executionOutput, type: "logs" }] : [];
            }
        };
        const createNativeSearchItem = queries => {
            const normalizedQueries = this._normalizeWebSearchQueries(queries);
            const item = {
                action: {
                    ...(normalizedQueries.length > 0 ? { queries: normalizedQueries } : {}),
                    type: "search",
                },
                id: `ws_${this._generateRequestId()}`,
                status: "completed",
                type: "web_search_call",
            };
            nativeSearchItems.push(item);
            output.push(item);
            return item;
        };
        const ensureNativeSearchItem = (googleCallId, queries) => {
            const hasId = typeof googleCallId === "string" && googleCallId;
            let item = hasId ? nativeSearchItemsByGoogleId.get(googleCallId) : nativeSearchItems.at(-1);
            const normalizedQueries = this._normalizeWebSearchQueries(queries);
            if (!item) {
                item = createNativeSearchItem(normalizedQueries);
                if (hasId) nativeSearchItemsByGoogleId.set(googleCallId, item);
            } else if (normalizedQueries.length > 0 && (item.action.queries || []).length === 0) {
                item.action.queries = normalizedQueries;
            }
            return item;
        };
        const hasNativeWebSearch =
            Array.isArray(candidate.content?.parts) &&
            candidate.content.parts.some(
                part =>
                    part?.toolCall?.toolType === "GOOGLE_SEARCH_WEB" ||
                    part?.toolResponse?.toolType === "GOOGLE_SEARCH_WEB"
            );
        if (candidate.content && Array.isArray(candidate.content.parts)) {
            for (let partIndex = 0; partIndex < candidate.content.parts.length; partIndex++) {
                const part = candidate.content.parts[partIndex];
                // Responses API supports reasoning output items; map Gemini "thought" parts into a reasoning *summary*.
                if (part?.thought === true) {
                    if (part?.text) reasoningContent += part.text;
                    continue;
                } else if (part.text) {
                    // Regular text content
                    messagePartRanges.set(partIndex, {
                        startIndex: messageContent.length,
                        text: part.text,
                    });
                    messageContent += part.text;
                } else if (part.inlineData) {
                    // Responses API image outputs are intentionally suppressed by this proxy; preserve a text note.
                    if (!messageContent) {
                        messageContent =
                            "[Image output omitted: Responses API image outputs are disabled by this proxy.]";
                    }
                } else if (part?.toolCall?.toolType === "GOOGLE_SEARCH_WEB") {
                    const queries = part.toolCall.args?.queries || part.toolCall.args?.query;
                    webSearchQueries = this._normalizeWebSearchQueries([
                        ...webSearchQueries,
                        ...this._normalizeWebSearchQueries(queries),
                    ]);
                    ensureNativeSearchItem(part.toolCall.id, queries);
                } else if (part?.toolResponse?.toolType === "GOOGLE_SEARCH_WEB") {
                    ensureNativeSearchItem(part.toolResponse.id);
                } else if (part?.executableCode) {
                    const existing =
                        typeof part.executableCode.id === "string" && part.executableCode.id
                            ? codeInterpreterItemsByGoogleId.get(part.executableCode.id)
                            : null;
                    if (existing) {
                        if (!existing.code && typeof part.executableCode.code === "string") {
                            existing.code = part.executableCode.code;
                        }
                    } else {
                        createCodeInterpreterItem(part.executableCode.id, part.executableCode.code);
                    }
                } else if (part?.codeExecutionResult) {
                    const item =
                        findCodeInterpreterItem(part.codeExecutionResult.id) ||
                        createCodeInterpreterItem(part.codeExecutionResult.id);
                    completeCodeInterpreterItem(item, part.codeExecutionResult);
                } else if (part.functionCall) {
                    // Function call
                    const funcCall = part.functionCall;
                    const responseFunctionIdentity = this._resolveResponseFunctionIdentity(
                        funcCall.name,
                        responseFunctionNameMap
                    );
                    const isCustom = responseFunctionIdentity.type === "custom";
                    const toolInput = isCustom ? funcCall.args?.input : JSON.stringify(funcCall.args || {});
                    if (typeof toolInput !== "string") {
                        this.logger.warn(
                            `[Adapter] Skipping custom tool ${responseFunctionIdentity.name}: returned a non-string input`
                        );
                        continue;
                    }
                    // Pass through the Gemini-issued call id so it round-trips into
                    // `functionCall.id`/`functionResponse.id` on the next request.
                    const callId =
                        typeof funcCall.id === "string" && funcCall.id
                            ? funcCall.id
                            : `call_${this._generateRequestId()}`;
                    output.push({
                        [isCustom ? "input" : "arguments"]: toolInput,
                        call_id: callId,
                        id: `${isCustom ? "ctc" : "fc"}-${this._generateRequestId()}`,
                        name: responseFunctionIdentity.name,
                        ...(responseFunctionIdentity.namespace
                            ? { namespace: responseFunctionIdentity.namespace }
                            : {}),
                        status: "completed",
                        type: isCustom ? "custom_tool_call" : "function_call",
                    });
                    this.logger.debug(
                        `[Adapter] Converted Gemini functionCall to Response API ${isCustom ? "custom_tool_call" : "function_call"}: ${responseFunctionIdentity.namespace ? `${responseFunctionIdentity.namespace}.` : ""}${responseFunctionIdentity.name} (call_id: ${callId})`
                    );
                }
            }
        }

        for (const item of codeInterpreterItems) {
            if (item.status === "in_progress") item.status = "incomplete";
        }

        if (reasoningContent) {
            output.unshift({
                id: `rsn_${this._generateRequestId()}`,
                status: "completed",
                summary: [
                    {
                        text: reasoningContent,
                        type: "summary_text",
                    },
                ],
                type: "reasoning",
            });
        }

        const grounding = this._extractResponseWebSearchGrounding(candidate, messageContent, messagePartRanges);
        const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
        const urlCalls = parts.filter(part => part?.toolCall?.toolType === "URL_CONTEXT");
        const urlResults = parts.filter(part => part?.toolResponse?.toolType === "URL_CONTEXT");
        const urlContextUrls =
            urlCalls.length > 0
                ? urlCalls.flatMap(part => part.toolCall.args?.urls || []).filter(url => typeof url === "string" && url)
                : urlResults.length > 0
                  ? urlResults.flatMap(part => this._extractResponseUrlContextUrls(part.toolResponse.response))
                  : this._extractResponseUrlContextUrls(candidate.urlContextMetadata || candidate.url_context_metadata);
        const hasUrlContext = urlCalls.length > 0 || urlResults.length > 0 || urlContextUrls.length > 0;
        if (webSearchQueries.length === 0) webSearchQueries = grounding.queries;
        const requestedSearchSources =
            Array.isArray(responseInclude) && responseInclude.includes("web_search_call.action.sources");
        const sources = requestedSearchSources
            ? this._extractResponseWebSearchSources(candidate.groundingMetadata?.groundingChunks)
            : null;
        if (hasNativeWebSearch) {
            const lastSearchItem = nativeSearchItems.at(-1);
            if (lastSearchItem && webSearchQueries.length > 0 && (lastSearchItem.action.queries || []).length === 0) {
                lastSearchItem.action.queries = webSearchQueries;
            }
            if (requestedSearchSources) {
                nativeSearchItems.forEach(item => {
                    item.action.sources = sources;
                });
            }
        } else if (
            webSearchQueries.length > 0 ||
            (!hasUrlContext &&
                (grounding.annotations.length > 0 || candidate.groundingMetadata?.groundingChunks?.length > 0))
        ) {
            const searchItem = {
                action: {
                    ...(webSearchQueries.length > 0 ? { queries: webSearchQueries } : {}),
                    ...(requestedSearchSources ? { sources } : {}),
                    type: "search",
                },
                id: `ws_${this._generateRequestId()}`,
                status: "completed",
                type: "web_search_call",
            };
            // Grounding-only search metadata arrives after the model content but
            // represents work performed before the resulting message.
            const firstMessageLikeIndex = output.findIndex(item =>
                ["function_call", "custom_tool_call"].includes(item.type)
            );
            if (firstMessageLikeIndex < 0) output.push(searchItem);
            else output.splice(firstMessageLikeIndex, 0, searchItem);
        }

        for (const url of urlContextUrls) {
            output.push({
                action: { type: "open_page", url },
                id: `ws_${this._generateRequestId()}`,
                status: "completed",
                type: "web_search_call",
            });
        }

        // Add message output if present
        if (messageContent) {
            output.push({
                content: [
                    {
                        annotations: grounding.annotations,
                        logprobs: [],
                        text: messageContent,
                        type: "output_text",
                    },
                ],
                id: `msg_${this._generateRequestId()}`,
                role: "assistant",
                status: incompleteReason ? "incomplete" : "completed",
                type: "message",
            });
        }

        // Parse usage
        const usage = this._parseUsage(googleResponse);

        return {
            completed_at: incompleteReason ? null : Math.floor(Date.now() / 1000),
            created_at: Math.floor(Date.now() / 1000),
            error: null,
            id: `resp_${this._generateRequestId()}`,
            incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
            instructions: null,
            max_output_tokens: null,
            metadata: {},
            model: modelName,
            object: "response",
            output,
            parallel_tool_calls: true,
            reasoning: {
                effort: null,
                summary: null,
            },
            service_tier: "default",
            status: incompleteReason ? "incomplete" : "completed",
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
            usage: {
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
            },
            ...responseFields,
            // This proxy does not support OpenAI-side persistence.
            ...{ store: false },
        };
    }

    _extractResponseUrlContextUrls(metadata) {
        return this._extractUrlContextMetadataEntries(metadata)
            .map(entry => entry?.retrievedUrl || entry?.retrieved_url)
            .filter(url => typeof url === "string" && url);
    }

    _extractResponseWebSearchSources(chunks) {
        // Use every web grounding chunk, including sources without an inline
        // citation. URL Context remains open_page; its schema has no sources field.
        const urls = (Array.isArray(chunks) ? chunks : [])
            .map(chunk => chunk?.web?.uri)
            .filter(url => typeof url === "string" && url.trim());
        return [...new Set(urls)].map(url => ({ type: "url", url }));
    }

    _extractResponseWebSearchGrounding(candidate, messageText = "", messagePartRanges = null) {
        const metadata = candidate?.groundingMetadata || {};
        const queries = this._normalizeWebSearchQueries(metadata.webSearchQueries);
        const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
        const supports = Array.isArray(metadata.groundingSupports) ? metadata.groundingSupports : [];
        const annotations = [];
        const annotationKeys = new Set();

        for (const support of supports) {
            const segment = support?.segment || {};
            const segmentText = typeof segment.text === "string" ? segment.text : "";
            let partRange =
                support?._responseTextPartRange ||
                (Number.isInteger(segment.partIndex) && messagePartRanges instanceof Map
                    ? messagePartRanges.get(segment.partIndex)
                    : null);
            const segmentStartByte = Number.isFinite(segment.startIndex) ? Math.max(0, segment.startIndex) : 0;
            const segmentEndByte = Number.isFinite(segment.endIndex)
                ? Math.max(segmentStartByte, segment.endIndex)
                : segmentStartByte + Buffer.byteLength(segmentText, "utf8");
            if (segmentText && support?._responseTextChunkRange) {
                const matchingRange = [partRange, support._responseTextChunkRange].find(range => {
                    if (!range || segmentEndByte > Buffer.byteLength(range.text, "utf8")) return false;
                    const start = this._utf8ByteOffsetToStringIndex(range.text, segmentStartByte);
                    const end = this._utf8ByteOffsetToStringIndex(range.text, segmentEndByte);
                    return range.text.slice(start, end) === segmentText;
                });
                // Prefer cumulative offsets when both match; use delta-local
                // offsets only when the segment text confirms that interpretation.
                if (matchingRange) partRange = matchingRange;
            }
            const partText = partRange?.text || messageText;
            const partBaseIndex = Number.isInteger(partRange?.startIndex) ? partRange.startIndex : 0;
            let localStartIndex = this._utf8ByteOffsetToStringIndex(partText, segmentStartByte);
            let localEndIndex = this._utf8ByteOffsetToStringIndex(partText, segmentEndByte);

            // Gemini grounding offsets are UTF-8 byte offsets. Resolve the exact segment text as
            // an additional safeguard, scoped to the selected Part so repeated text in an earlier
            // Part cannot steal the citation.
            if (segmentText && partText.slice(localStartIndex, localEndIndex) !== segmentText) {
                let matchedIndex = partText.indexOf(segmentText, Math.max(0, localStartIndex - 128));
                if (matchedIndex < 0) matchedIndex = partText.indexOf(segmentText);
                if (matchedIndex >= 0) {
                    localStartIndex = matchedIndex;
                    localEndIndex = matchedIndex + segmentText.length;
                }
            }

            let startIndex = partBaseIndex + localStartIndex;
            let endIndex = partBaseIndex + localEndIndex;
            startIndex = Math.min(startIndex, messageText.length);
            endIndex = Math.min(Math.max(startIndex, endIndex), messageText.length);
            const openAIStartIndex = Array.from(messageText.slice(0, startIndex)).length;
            const openAIEndIndex = openAIStartIndex + Array.from(messageText.slice(startIndex, endIndex)).length;

            const chunkIndices = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [];
            for (const chunkIndex of chunkIndices) {
                const web = chunks[chunkIndex]?.web;
                if (!web || typeof web.uri !== "string" || !web.uri) continue;

                const annotation = {
                    end_index: openAIEndIndex,
                    start_index: openAIStartIndex,
                    title: web.siteName || web.title || web.domain || web.uri,
                    type: "url_citation",
                    url: web.uri,
                };
                const key = `${annotation.start_index}:${annotation.end_index}:${annotation.url}`;
                if (annotationKeys.has(key)) continue;
                annotationKeys.add(key);
                annotations.push(annotation);
            }
        }

        return { annotations, queries };
    }
}

module.exports = ResponsesNonStreamResponseConverter;
