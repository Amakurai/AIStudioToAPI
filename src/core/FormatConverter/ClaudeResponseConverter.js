/**
 * File: src/core/FormatConverter/ClaudeResponseConverter.js
 * Description: Anthropic Messages streaming/non-streaming responses and hosted-tool metadata.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const FormatConverter = require("./CommonConverter");

class ClaudeResponseConverter extends FormatConverter {
    _parseClaudeUsage(usageMetadata = {}) {
        const parsedUsage = this._parseUsage({ usageMetadata });
        const cacheReadInputTokens = parsedUsage.prompt_tokens_details.cached_tokens || 0;

        return {
            // Anthropic reports uncached input separately from cache reads/writes.
            // Gemini exposes cache reads but does not expose an equivalent cache-write count.
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cacheReadInputTokens,
            input_tokens: Math.max(0, parsedUsage.prompt_tokens - cacheReadInputTokens),
            output_tokens: parsedUsage.completion_tokens,
        };
    }

    _formatGeminiExecutableCodeAsBashCommand(executableCode = {}) {
        const code = typeof executableCode.code === "string" ? executableCode.code : "";
        const language = String(executableCode.language || "python").toLowerCase();
        if (language !== "python" && language !== "py") return code;

        const codeLines = new Set(code.split(/\r?\n/));
        let delimiter = "PYTHON_CODE";
        while (codeLines.has(delimiter)) delimiter += "_";
        return `python - <<'${delimiter}'\n${code}${code.endsWith("\n") ? "" : "\n"}${delimiter}`;
    }

    _buildClaudeWebToolBlocks(candidate, state, options) {
        const blocks = [];
        if (!state.claudeWebToolCalls) state.claudeWebToolCalls = new Map();
        if (!state.claudeUrlCalls) state.claudeUrlCalls = new Map();
        if (!state.claudeGroundingSourceKeys) state.claudeGroundingSourceKeys = new Set();
        if (!state.claudeUrlMetadataKeys) state.claudeUrlMetadataKeys = new Set();

        const createCall = (name, input) => {
            const call = { id: `srvtoolu_${this._generateRequestId()}`, resultSent: false, seenResults: new Set() };
            blocks.push({ caller: { type: "direct" }, id: call.id, input, name, type: "server_tool_use" });
            state.serverToolUsage[name === "web_search" ? "web_search_requests" : "web_fetch_requests"]++;
            return call;
        };
        const ensureSearchCall = (key, queries = []) => {
            let call = key ? state.claudeWebToolCalls.get(key) : state.claudeLastSearchCall;
            if (!call) {
                call = createCall("web_search", { query: queries.join("\n") || "Google Search" });
                if (key) state.claudeWebToolCalls.set(key, call);
            }
            state.claudeLastSearchCall = call;
            if (!call.queries) call.queries = new Set(queries);
            else {
                const fresh = queries.filter(query => !call.queries.has(query));
                for (const query of fresh) call.queries.add(query);
            }
            return call;
        };
        const ensureFetchCall = (url, key) => {
            let calls = key ? state.claudeWebToolCalls.get(key) : null;
            if (key && !calls) {
                calls = new Map();
                state.claudeWebToolCalls.set(key, calls);
            }
            let call = calls?.get(url);
            const existing = state.claudeUrlCalls.get(url);
            if (!call && existing && !key) call = existing;
            if (!call) call = createCall("web_fetch", { url });
            if (key) {
                calls.set(url, call);
            }
            state.claudeUrlCalls.set(url, call);
            return call;
        };
        const searchResults = () => {
            const chunks = candidate?.groundingMetadata?.groundingChunks;
            return (Array.isArray(chunks) ? chunks : []).flatMap(chunk => {
                const web = chunk?.web;
                if (typeof web?.uri !== "string" || !web.uri) return [];
                return [
                    {
                        encrypted_content: "",
                        page_age: null,
                        title: web.title || web.siteName || web.uri,
                        type: "web_search_result",
                        url: web.uri,
                    },
                ];
            });
        };
        const emitSearchResults = (call, results) => {
            // Native search responses can precede the grounding sources in the final chunk.
            if (results.length === 0 && options.includeMetadata === false) return;
            const fresh = results.filter(result => {
                const key = `${result.url}\u0000${result.title}`;
                if (call.seenResults.has(key)) return false;
                call.seenResults.add(key);
                state.claudeGroundingSourceKeys.add(key);
                return true;
            });
            if (!call.resultSent) {
                blocks.push({ content: fresh, tool_use_id: call.id, type: "web_search_tool_result" });
                call.resultSent = true;
            }
        };
        const emitFetchResult = (metadata, key) => {
            const url = metadata?.retrievedUrl || metadata?.retrieved_url;
            if (typeof url !== "string" || !url) return;
            const status = String(metadata.urlRetrievalStatus || metadata.url_retrieval_status || "");
            const resultKey = `${url}:${status}`;
            // Candidate metadata has no call ID and can repeat a previous result
            // while a new call is outstanding. Do not complete that new call twice.
            if (!key && state.claudeUrlMetadataKeys.has(resultKey)) return;
            let call = key ? state.claudeWebToolCalls.get(key)?.get(url) : null;
            // A redirected URL still belongs to the outstanding call in this response.
            if (!call && key) {
                call = [...(state.claudeWebToolCalls.get(key)?.values() || [])].find(item => !item.resultSent);
            }
            if (!call) call = ensureFetchCall(url, key);
            state.claudeUrlCalls.set(url, call);
            if (key) state.claudeWebToolCalls.get(key)?.set(url, call);
            if (call.seenResults.has(resultKey)) return;
            call.seenResults.add(resultKey);
            state.claudeUrlMetadataKeys.add(resultKey);
            if (!status || call.resultSent) return;
            const content = status.includes("SUCCESS")
                ? {
                      content: {
                          citations: null,
                          source: { data: "", media_type: "text/plain", type: "text" },
                          title: null,
                          type: "document",
                      },
                      retrieved_at: new Date().toISOString(),
                      type: "web_fetch_result",
                      url,
                  }
                : {
                      error_code: status.includes("UNSAFE") ? "url_not_allowed" : "url_not_accessible",
                      type: "web_fetch_tool_result_error",
                  };
            blocks.push({ caller: { type: "direct" }, content, tool_use_id: call.id, type: "web_fetch_tool_result" });
            call.resultSent = true;
        };

        if (options.includeNative !== false) {
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
            for (const part of parts) {
                const invocation = part?.toolCall || part?.toolResponse;
                if (!invocation?.id) continue;
                const type = invocation.toolType;
                const key = `${type}:${invocation.id}`;
                if (type === "GOOGLE_SEARCH_WEB") {
                    const queries = this._normalizeWebSearchQueries(invocation.args?.queries || invocation.args?.query);
                    const call = ensureSearchCall(key, queries);
                    if (part.toolResponse) {
                        call.responseReceived = true;
                        state.claudeLastSearchResultCall = call;
                        emitSearchResults(call, searchResults());
                    }
                } else if (type === "URL_CONTEXT") {
                    if (part.toolCall) {
                        const urls = invocation.args?.urls;
                        const validUrls = (Array.isArray(urls) ? urls : typeof urls === "string" ? [urls] : []).filter(
                            url => typeof url === "string" && url
                        );
                        for (const url of validUrls) ensureFetchCall(url, key);
                    } else {
                        const response = invocation.response || {};
                        for (const entry of this._extractUrlContextMetadataEntries(response)) {
                            emitFetchResult(entry, key);
                        }
                    }
                }
            }
        }

        if (options.includeMetadata !== false) {
            const grounding = candidate?.groundingMetadata;
            const context = candidate?.urlContextMetadata || candidate?.url_context_metadata;
            const knownQueries = new Set([
                ...[...state.claudeWebToolCalls.values()].flatMap(call => [...(call.queries || [])]),
            ]);
            const searchQueries = this._normalizeWebSearchQueries(grounding?.webSearchQueries);
            const queries = searchQueries.filter(query => !knownQueries.has(query));
            const results = searchResults().filter(
                result => !state.claudeGroundingSourceKeys.has(`${result.url}\u0000${result.title}`)
            );
            // URL Context also emits grounding sources. Those sources alone
            // do not represent an additional Google Search invocation.
            const hasSearch = searchQueries.length > 0 || state.claudeLastSearchCall;
            const metadata = this._extractUrlContextMetadataEntries(context);
            // Streaming accumulation includes an empty URL Context object even
            // when no fetch occurred. Only actual retrievals indicate a fetch.
            const hasFetch = (Array.isArray(metadata) && metadata.length > 0) || state.claudeUrlCalls.size > 0;
            if ((queries.length > 0 || results.length > 0) && (hasSearch || !hasFetch)) {
                const call = state.claudeLastSearchResultCall || ensureSearchCall(null, queries);
                emitSearchResults(call, results);
            }
            for (const call of state.claudeWebToolCalls.values()) {
                if (call.responseReceived && !call.resultSent) emitSearchResults(call, []);
            }
            for (const entry of Array.isArray(metadata) ? metadata : []) emitFetchResult(entry);
        }

        return blocks;
    }

    _formatClaudeServerToolUsage(usage = {}) {
        const counts = Object.fromEntries(Object.entries(usage).filter(([, count]) => count > 0));
        if (Object.keys(counts).length === 0) return {};

        // Both web counters are required whenever server_tool_use is present.
        return { web_fetch_requests: 0, web_search_requests: 0, ...counts };
    }

    _buildClaudeServerToolBlocks(candidate, state = {}, options = {}) {
        const includeCodeExecution = options.includeCodeExecution !== false;
        const includeMetadata = options.includeMetadata !== false;
        const blocks = [];

        if (!state.serverToolSeenKeys) state.serverToolSeenKeys = new Set();
        if (!state.codeExecutionToolUseIds) state.codeExecutionToolUseIds = new Map();
        if (!state.serverToolUsage) {
            state.serverToolUsage = {
                code_execution_requests: 0,
                web_fetch_requests: 0,
                web_search_requests: 0,
            };
        }

        const createToolUseId = () => `srvtoolu_${this._generateRequestId()}`;

        blocks.push(
            ...this._buildClaudeWebToolBlocks(candidate, state, {
                includeMetadata,
                includeNative: options.includeNative,
            })
        );

        if (includeCodeExecution) {
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
            for (const part of parts) {
                if (part?.executableCode) {
                    const executableCode = part.executableCode;
                    const geminiId = executableCode.id || null;
                    const seenKey = geminiId ? `code_call:${geminiId}` : null;
                    if (seenKey && state.serverToolSeenKeys.has(seenKey)) continue;

                    const toolUseId = createToolUseId();
                    if (seenKey) state.serverToolSeenKeys.add(seenKey);
                    blocks.push({
                        caller: { type: "direct" },
                        id: toolUseId,
                        input: { command: this._formatGeminiExecutableCodeAsBashCommand(executableCode) },
                        name: "bash_code_execution",
                        type: "server_tool_use",
                    });
                    if (geminiId) state.codeExecutionToolUseIds.set(geminiId, toolUseId);
                    state.lastCodeExecutionToolUseId = toolUseId;
                    state.serverToolUsage.code_execution_requests++;
                } else if (part?.codeExecutionResult) {
                    const executionResult = part.codeExecutionResult;
                    const geminiId = executionResult.id || null;
                    const seenKey = geminiId ? `code_result:${geminiId}` : null;
                    if (seenKey && state.serverToolSeenKeys.has(seenKey)) continue;

                    let toolUseId = geminiId ? state.codeExecutionToolUseIds.get(geminiId) : null;
                    if (!toolUseId) toolUseId = state.lastCodeExecutionToolUseId;
                    if (!toolUseId) {
                        toolUseId = createToolUseId();
                        blocks.push({
                            caller: { type: "direct" },
                            id: toolUseId,
                            input: { command: "" },
                            name: "bash_code_execution",
                            type: "server_tool_use",
                        });
                        state.serverToolUsage.code_execution_requests++;
                    }

                    if (seenKey) state.serverToolSeenKeys.add(seenKey);
                    const outcome = String(executionResult.outcome || "");
                    const succeeded = outcome === "OUTCOME_OK";
                    blocks.push({
                        content: {
                            content: [],
                            return_code: succeeded ? 0 : outcome === "OUTCOME_DEADLINE_EXCEEDED" ? 124 : 1,
                            stderr: succeeded ? "" : executionResult.output || "",
                            stdout: succeeded ? executionResult.output || "" : "",
                            type: "bash_code_execution_result",
                        },
                        tool_use_id: toolUseId,
                        type: "bash_code_execution_tool_result",
                    });
                }
            }
        }

        return { blocks, usage: state.serverToolUsage };
    }

    _buildClaudeWebSearchCitations(candidate) {
        const groundingMetadata = candidate?.groundingMetadata;
        const groundingChunks = Array.isArray(groundingMetadata?.groundingChunks)
            ? groundingMetadata.groundingChunks
            : [];
        const groundingSupports = Array.isArray(groundingMetadata?.groundingSupports)
            ? groundingMetadata.groundingSupports
            : [];
        const citations = [];
        const seenCitationKeys = new Set();

        for (let supportIndex = 0; supportIndex < groundingSupports.length; supportIndex++) {
            const support = groundingSupports[supportIndex];
            const chunkIndices = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [];
            const segmentText =
                typeof support?.segment?.text === "string" && support.segment.text
                    ? [...support.segment.text].slice(0, 150).join("")
                    : "";

            for (const chunkIndex of chunkIndices) {
                const web = groundingChunks[chunkIndex]?.web;
                if (!web || typeof web.uri !== "string" || !web.uri) continue;

                const title = web.title || web.siteName || null;
                const citationKey = `${chunkIndex}\u0000${segmentText}`;
                if (seenCitationKeys.has(citationKey)) continue;
                seenCitationKeys.add(citationKey);

                citations.push({
                    cited_text: segmentText || title || web.uri,
                    // Gemini exposes the source mapping but not Anthropic's opaque
                    // encrypted index. Keep a stable, non-empty proxy-local value so
                    // Claude clients can retain the citation object across the stream.
                    encrypted_index: `google_grounding_${chunkIndex}_${supportIndex}`,
                    title,
                    type: "web_search_result_location",
                    url: web.uri,
                });
            }
        }

        return citations;
    }

    _accumulateClaudeServerToolMetadata(candidate, state) {
        if (!state.claudeServerToolMetadata) {
            state.claudeServerToolMetadata = {
                groundingChunks: [],
                groundingSupportKeys: new Set(),
                groundingSupports: [],
                urlMetadata: new Map(),
                webSearchQueries: new Set(),
            };
        }

        const accumulated = state.claudeServerToolMetadata;
        const groundingMetadata = candidate?.groundingMetadata;
        for (const query of this._normalizeWebSearchQueries(groundingMetadata?.webSearchQueries)) {
            accumulated.webSearchQueries.add(query);
        }
        if (Array.isArray(groundingMetadata?.groundingChunks)) {
            // In streaming responses, groundingChunkIndices address the ordered
            // concatenation of every groundingChunks array received so far. Equal
            // chunk values can still occupy different global slots, so deduplicating
            // them would shift every later index and corrupt citation attribution.
            accumulated.groundingChunks.push(...groundingMetadata.groundingChunks);
        }
        if (Array.isArray(groundingMetadata?.groundingSupports)) {
            for (const support of groundingMetadata.groundingSupports) {
                const key = JSON.stringify(support);
                if (accumulated.groundingSupportKeys.has(key)) continue;
                accumulated.groundingSupportKeys.add(key);
                accumulated.groundingSupports.push(support);
            }
        }

        const urlContextMetadata = candidate?.urlContextMetadata || candidate?.url_context_metadata;
        const urlMetadata = this._extractUrlContextMetadataEntries(urlContextMetadata);
        for (const metadata of urlMetadata) {
            const url = metadata?.retrievedUrl || metadata?.retrieved_url;
            if (typeof url === "string" && url) accumulated.urlMetadata.set(url, metadata);
        }

        return {
            groundingMetadata: {
                groundingChunks: accumulated.groundingChunks,
                groundingSupports: accumulated.groundingSupports,
                webSearchQueries: [...accumulated.webSearchQueries],
            },
            urlContextMetadata: {
                urlMetadata: [...accumulated.urlMetadata.values()],
            },
        };
    }

    /**
     * Convert Google streaming response chunk to Claude format
     * @param {string} googleChunk - The Google response chunk
     * @param {string} modelName - The model name
     * @param {object} streamState - State object to track streaming progress
     */
    translateGoogleToClaudeStream(googleChunk, modelName = "gemini-flash-lite-latest", streamState = null) {
        this.logger.debug(`[Adapter] Debug: Received Google chunk for Claude: ${googleChunk}`);

        if (!streamState) {
            this.logger.warn(
                "[Adapter] streamState not provided, creating default state. This may cause issues with tool call tracking."
            );
            streamState = {};
        }
        if (streamState.completed || !googleChunk || googleChunk.trim() === "") {
            return null;
        }

        let jsonString = googleChunk;
        if (jsonString.startsWith("data: ")) {
            jsonString = jsonString.substring(6).trim();
        }
        if (jsonString === "[DONE]") {
            return null;
        }

        let googleResponse;
        try {
            googleResponse = JSON.parse(jsonString);
        } catch (e) {
            this.logger.warn(`[Adapter] Unable to parse Google JSON chunk for Claude: ${jsonString}`);
            return null;
        }

        const candidate = googleResponse.candidates?.[0];
        const usage = googleResponse.usageMetadata;

        // Update stream state with usage if available
        if (usage) {
            const claudeUsage = this._parseClaudeUsage(usage);
            const totalInputTokens = (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0);

            if (totalInputTokens > 0) {
                streamState.inputTokens = claudeUsage.input_tokens;
                streamState.cacheReadInputTokens = claudeUsage.cache_read_input_tokens;
                streamState.cacheCreationInputTokens = claudeUsage.cache_creation_input_tokens;
            }
            streamState.outputTokens = claudeUsage.output_tokens;
        }

        // Initialize stream state
        if (!streamState.messageId) {
            streamState.messageId = `msg_${this._generateRequestId()}`;
            streamState.contentBlockIndex = 0;
            if (!streamState.inputTokens) streamState.inputTokens = 0;
            if (!streamState.outputTokens) streamState.outputTokens = 0;
        }

        if (!candidate) {
            if (googleResponse.promptFeedback) {
                this.logger.warn(
                    `[Adapter] Google returned promptFeedback for Claude stream, may have been blocked: ${JSON.stringify(
                        googleResponse.promptFeedback
                    )}`
                );
            }
            const message = this._getGeminiPromptBlockMessage(googleResponse.promptFeedback);
            if (message) {
                streamState.error = { message, type: "invalid_request_error" };
                streamState.completed = true;
                return `event: error\ndata: ${JSON.stringify({ error: streamState.error, type: "error" })}\n\n`;
            }
            return null;
        }

        const events = [];

        const closeThinkingBlock = () => {
            if (!streamState.thinkingBlockStarted || streamState.thinkingBlockStopped) return;

            events.push({
                delta: {
                    signature: streamState.thinkingSignature || `proxy_thinking_${this._generateRequestId()}`,
                    type: "signature_delta",
                },
                index: streamState.thinkingBlockIndex,
                type: "content_block_delta",
            });
            events.push({
                index: streamState.thinkingBlockIndex,
                type: "content_block_stop",
            });
            streamState.thinkingBlockStopped = true;
            streamState.thinkingSignature = null;
        };

        const closeTextBlock = () => {
            if (!streamState.textBlockStarted || streamState.textBlockStopped) return;

            events.push({
                index: streamState.textBlockIndex,
                type: "content_block_stop",
            });
            streamState.textBlockStopped = true;
        };

        const ensureTextBlock = () => {
            closeThinkingBlock();
            if (streamState.textBlockStarted && !streamState.textBlockStopped) return;

            events.push({
                content_block: { text: "", type: "text" },
                index: streamState.contentBlockIndex,
                type: "content_block_start",
            });
            streamState.textBlockStarted = true;
            streamState.textBlockStopped = false;
            streamState.textBlockIndex = streamState.contentBlockIndex;
            streamState.contentBlockIndex++;
        };

        const emitServerToolBlocks = blocks => {
            for (const block of blocks) {
                closeThinkingBlock();
                closeTextBlock();

                const index = streamState.contentBlockIndex;
                if (block.type === "server_tool_use") {
                    events.push({
                        content_block: {
                            caller: block.caller || { type: "direct" },
                            id: block.id,
                            input: {},
                            name: block.name,
                            type: block.type,
                        },
                        index,
                        type: "content_block_start",
                    });
                    events.push({
                        delta: {
                            partial_json: JSON.stringify(block.input || {}),
                            type: "input_json_delta",
                        },
                        index,
                        type: "content_block_delta",
                    });
                } else {
                    events.push({
                        content_block: block,
                        index,
                        type: "content_block_start",
                    });
                }
                events.push({ index, type: "content_block_stop" });
                streamState.contentBlockIndex++;
            }
        };

        const emitTextContent = (text, citations = []) => {
            if (!text && citations.length === 0) return;

            ensureTextBlock();

            if (text) {
                events.push({
                    delta: { text, type: "text_delta" },
                    index: streamState.textBlockIndex,
                    type: "content_block_delta",
                });
            }
            for (const citation of citations) {
                events.push({
                    delta: { citation, type: "citations_delta" },
                    index: streamState.textBlockIndex,
                    type: "content_block_delta",
                });
            }
        };

        // Send message_start event once
        if (!streamState.messageStartSent) {
            events.push({
                message: {
                    content: [],
                    id: streamState.messageId,
                    model: modelName,
                    role: "assistant",
                    stop_reason: null,
                    stop_sequence: null,
                    type: "message",
                    usage: {
                        cache_creation_input_tokens: streamState.cacheCreationInputTokens || 0,
                        cache_read_input_tokens: streamState.cacheReadInputTokens || 0,
                        input_tokens: streamState.inputTokens || 0,
                        output_tokens: 0,
                    },
                },
                type: "message_start",
            });
            streamState.messageStartSent = true;
        }

        // Preserve the existing metadata aggregation; only native tool parts
        // are converted as they arrive.
        const accumulatedServerToolMetadata = this._accumulateClaudeServerToolMetadata(candidate, streamState);
        const candidateParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        // Grounding metadata describes the candidate as a whole, without call IDs.
        // Attach it only to the last search response, as with the metadata fallback.
        const lastSearchResponsePart = [...candidateParts]
            .reverse()
            .find(part => part?.toolResponse?.toolType === "GOOGLE_SEARCH_WEB");

        // Process content parts
        if (candidateParts.length > 0) {
            for (const part of candidateParts) {
                if (part.thought === true && part.text) {
                    // Preserve Gemini thoughts as Claude thinking blocks. The proxy-issued
                    // opaque signature makes the block replayable through this adapter.
                    closeTextBlock();
                    if (!streamState.thinkingBlockStarted || streamState.thinkingBlockStopped) {
                        events.push({
                            content_block: { signature: "", thinking: "", type: "thinking" },
                            index: streamState.contentBlockIndex,
                            type: "content_block_start",
                        });
                        streamState.thinkingBlockStarted = true;
                        streamState.thinkingBlockStopped = false;
                        streamState.thinkingBlockIndex = streamState.contentBlockIndex;
                        streamState.thinkingSignature = `proxy_thinking_${this._generateRequestId()}`;
                        streamState.contentBlockIndex++;
                    }
                    events.push({
                        delta: { thinking: part.text, type: "thinking_delta" },
                        index: streamState.thinkingBlockIndex,
                        type: "content_block_delta",
                    });
                } else if (part.text) {
                    // Regular text content
                    emitTextContent(part.text);
                } else if (part.inlineData) {
                    // Image output - convert to markdown image format for streaming
                    ensureTextBlock();
                    // Send image as markdown text delta
                    const imageMarkdown = `![Generated Image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})`;
                    events.push({
                        delta: { text: imageMarkdown, type: "text_delta" },
                        index: streamState.textBlockIndex,
                        type: "content_block_delta",
                    });
                    this.logger.info("[Adapter] Successfully parsed image from streaming response chunk.");
                } else if (part.toolCall || part.toolResponse || part.executableCode || part.codeExecutionResult) {
                    const serverTools = this._buildClaudeServerToolBlocks(
                        {
                            content: { parts: [part] },
                            groundingMetadata:
                                candidate.finishReason && part === lastSearchResponsePart
                                    ? accumulatedServerToolMetadata.groundingMetadata
                                    : undefined,
                        },
                        streamState,
                        { includeMetadata: false }
                    );
                    emitServerToolBlocks(serverTools.blocks);
                } else if (part.functionCall) {
                    // Tool use
                    closeThinkingBlock();
                    closeTextBlock();
                    const toolUseId = `toolu_${this._generateRequestId()}`;
                    events.push({
                        content_block: {
                            caller: { type: "direct" },
                            id: toolUseId,
                            input: {},
                            name: part.functionCall.name,
                            type: "tool_use",
                        },
                        index: streamState.contentBlockIndex,
                        type: "content_block_start",
                    });
                    events.push({
                        delta: {
                            partial_json: JSON.stringify(part.functionCall.args || {}),
                            type: "input_json_delta",
                        },
                        index: streamState.contentBlockIndex,
                        type: "content_block_delta",
                    });
                    events.push({
                        index: streamState.contentBlockIndex,
                        type: "content_block_stop",
                    });
                    streamState.contentBlockIndex++;
                    streamState.hasToolUse = true;
                }
            }
        }

        if (candidate.finishReason) {
            const citations = this._buildClaudeWebSearchCitations(accumulatedServerToolMetadata);
            emitTextContent("", citations);

            const metadataServerTools = this._buildClaudeServerToolBlocks(accumulatedServerToolMetadata, streamState, {
                includeCodeExecution: false,
                includeNative: false,
            });
            emitServerToolBlocks(metadataServerTools.blocks);
        }

        // Handle finish
        if (candidate.finishReason) {
            // Close any open blocks
            closeTextBlock();
            closeThinkingBlock();

            // Determine stop reason
            let stopReason = "end_turn";
            if (streamState.hasToolUse) {
                stopReason = "tool_use";
            } else if (candidate.finishReason === "MAX_TOKENS") {
                stopReason = "max_tokens";
            } else if (candidate.finishReason === "STOP") {
                stopReason = "end_turn";
            }

            const serverToolUse = this._formatClaudeServerToolUsage(streamState.serverToolUsage);
            events.push({
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                type: "message_delta",
                usage: {
                    cache_creation_input_tokens: streamState.cacheCreationInputTokens || 0,
                    cache_read_input_tokens: streamState.cacheReadInputTokens || 0,
                    input_tokens: streamState.inputTokens || 0,
                    output_tokens: streamState.outputTokens || 0,
                    ...(Object.keys(serverToolUse).length > 0 ? { server_tool_use: serverToolUse } : {}),
                },
            });

            events.push({ type: "message_stop" });
            streamState.completed = true;
        }

        if (events.length === 0) return null;

        return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    }

    /**
     * Convert Google non-stream response to Claude format
     */
    convertGoogleToClaudeNonStream(googleResponse, modelName = "gemini-flash-lite-latest") {
        try {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for Claude non-stream: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for Claude non-stream (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }

        const candidate = googleResponse.candidates?.[0];
        const usage = googleResponse.usageMetadata || {};
        const claudeUsage = this._parseClaudeUsage(usage);

        const messageId = `msg_${this._generateRequestId()}`;
        const content = [];

        if (!candidate) {
            return {
                content: [{ text: "", type: "text" }],
                id: messageId,
                model: modelName,
                role: "assistant",
                stop_reason: "end_turn",
                stop_sequence: null,
                type: "message",
                usage: claudeUsage,
            };
        }

        let hasToolUse = false;
        const serverToolState = {};

        if (candidate.content && Array.isArray(candidate.content.parts)) {
            const lastSearchResponsePart = [...candidate.content.parts]
                .reverse()
                .find(part => part?.toolResponse?.toolType === "GOOGLE_SEARCH_WEB");
            for (const part of candidate.content.parts) {
                if (part.thought === true && part.text) {
                    content.push({
                        signature: `proxy_thinking_${this._generateRequestId()}`,
                        thinking: part.text,
                        type: "thinking",
                    });
                } else if (part.text) {
                    content.push({
                        text: part.text,
                        type: "text",
                    });
                } else if (part.inlineData) {
                    // Image output - convert to base64 format
                    content.push({
                        text: `![Generated Image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})`,
                        type: "text",
                    });
                } else if (part.toolCall || part.toolResponse || part.executableCode || part.codeExecutionResult) {
                    const serverTools = this._buildClaudeServerToolBlocks(
                        {
                            content: { parts: [part] },
                            groundingMetadata:
                                part === lastSearchResponsePart ? candidate.groundingMetadata : undefined,
                        },
                        serverToolState,
                        { includeMetadata: false }
                    );
                    content.push(...serverTools.blocks);
                } else if (part.functionCall) {
                    hasToolUse = true;
                    content.push({
                        caller: { type: "direct" },
                        id: `toolu_${this._generateRequestId()}`,
                        input: part.functionCall.args || {},
                        name: part.functionCall.name,
                        type: "tool_use",
                    });
                }
            }
        }

        const metadataServerTools = this._buildClaudeServerToolBlocks(candidate, serverToolState, {
            includeCodeExecution: false,
            includeNative: false,
        });
        content.push(...metadataServerTools.blocks);

        const webSearchCitations = this._buildClaudeWebSearchCitations(candidate);
        if (webSearchCitations.length > 0) {
            const citedTextBlock = [...content].reverse().find(block => block.type === "text");
            if (citedTextBlock) citedTextBlock.citations = webSearchCitations;
        }

        // Determine stop reason
        let stopReason = "end_turn";
        if (hasToolUse) {
            stopReason = "tool_use";
        } else if (candidate.finishReason === "MAX_TOKENS") {
            stopReason = "max_tokens";
        } else if (candidate.finishReason === "SAFETY") {
            stopReason = "end_turn"; // Claude doesn't have a direct equivalent
        }

        const serverToolUse = this._formatClaudeServerToolUsage(serverToolState.serverToolUsage);

        return {
            content: content.length > 0 ? content : [{ text: "", type: "text" }],
            id: messageId,
            model: modelName,
            role: "assistant",
            stop_reason: stopReason,
            stop_sequence: null,
            type: "message",
            usage: {
                ...claudeUsage,
                ...(Object.keys(serverToolUse).length > 0 ? { server_tool_use: serverToolUse } : {}),
            },
        };
    }
}

module.exports = ClaudeResponseConverter;
