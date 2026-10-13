/**
 * File: src/core/FormatConverter/ClaudeRequestConverter.js
 * Description: Anthropic Messages requests and tool-result content.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const axios = require("axios");
const mime = require("mime-types");
const FormatConverter = require("./CommonConverter");

class ClaudeRequestConverter extends FormatConverter {
    async _convertClaudeToolResultMedia(content) {
        const parts = [];
        const convertBlocks = async blocks => {
            const converted = [];
            for (const block of blocks) {
                if (block?.type === "document" && block.source?.type === "content") {
                    const nestedContent = block.source.content;
                    converted.push({
                        ...block,
                        source: {
                            ...block.source,
                            content: Array.isArray(nestedContent) ? await convertBlocks(nestedContent) : nestedContent,
                        },
                    });
                } else if (block?.type === "image" || block?.type === "document") {
                    const media = await this._loadFunctionResponseMedia(block, parts.length);
                    if (media) {
                        const metadata = { ...block };
                        delete metadata.source;
                        converted.push({ ...metadata, content: { $ref: media.displayName } });
                        parts.push(media.part);
                    } else {
                        converted.push(block);
                    }
                } else {
                    converted.push(block);
                }
            }
            return converted;
        };
        return { content: await convertBlocks(content), parts };
    }

    _serializeClaudeServerToolData(value) {
        return JSON.stringify(value, (key, item) =>
            ["signature", "thoughtSignature", "thought_signature", "encrypted_content", "encrypted_index"].includes(key)
                ? undefined
                : item
        );
    }

    // ==================== Claude API Format Conversion ====================

    /**
     * Convert Claude API request format to Google Gemini format
     * @param {object} claudeBody - Claude API format request body
     * @returns {Promise<{ googleRequest: object, cleanModelName: string, modelStreamingMode: ("real"|"fake"|null) }>}
     *          - modelStreamingMode: Streaming mode override parsed from model name suffix, or null
     */
    async translateClaudeToGoogle(claudeBody) {
        this.logger.info("[Adapter] Starting translation of Claude request format to Google format...");

        // [DEBUG] Log incoming messages
        this.logger.debug(`[Adapter] Debug: incoming Claude Body = ${JSON.stringify(claudeBody, null, 2)}`);

        const rawModel = claudeBody.model || "gemini-flash-lite-latest";
        const {
            cleanModelName,
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
            streamingMode: modelStreamingMode,
            thinkingLevel: modelThinkingLevel,
        } = this.parseModelSuffixes(rawModel);

        let systemInstruction = null;
        const googleContents = [];

        // Pre-scan messages to build a map of tool_use_id -> function_name
        // This is required because Gemini's functionResponse needs the original function name,
        // but Claude's tool_result only provides the tool_use_id.
        const toolIdToNameMap = new Map();
        if (claudeBody.messages && Array.isArray(claudeBody.messages)) {
            for (const message of claudeBody.messages) {
                if (message.role === "assistant" && Array.isArray(message.content)) {
                    for (const block of message.content) {
                        if (block.type === "tool_use" && block.id && block.name) {
                            toolIdToNameMap.set(block.id, block.name);
                        }
                    }
                }
            }
        }

        const appendSystemContent = content => {
            let text = "";
            if (typeof content === "string") {
                text = content;
            } else if (Array.isArray(content)) {
                text = content
                    .map(block => {
                        if (typeof block === "string") return block;
                        if (block && block.type === "text") return block.text || "";
                        return block?.text || "";
                    })
                    .filter(Boolean)
                    .join("\n");
            } else if (content && typeof content === "object") {
                text = content.text || "";
            }

            if (!text) return;

            if (systemInstruction) {
                systemInstruction.parts[0].text = `${systemInstruction.parts[0].text}\n${text}`;
            } else {
                systemInstruction = {
                    parts: [{ text }],
                    role: "system",
                };
            }
        };

        // Extract system messages into Gemini systemInstruction.
        if (claudeBody.system) {
            appendSystemContent(claudeBody.system);
        }

        if (Array.isArray(claudeBody.messages)) {
            for (const message of claudeBody.messages) {
                if (message.role === "system") {
                    appendSystemContent(message.content);
                }
            }
        }

        // Buffer for accumulating consecutive tool result parts
        const pendingToolParts = this._createGoogleContentPartsBuffer(googleContents, "user");
        const pendingModelParts = this._createGoogleContentPartsBuffer(googleContents, "model");

        const ensureGeminiFunctionResponseObject = value => {
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                return value;
            }
            return { result: value };
        };

        const normalizeClaudeToolResultContent = content => {
            if (typeof content === "string") {
                try {
                    return ensureGeminiFunctionResponseObject(JSON.parse(content));
                } catch {
                    return { result: content };
                }
            }

            if (Array.isArray(content)) {
                const textParts = content
                    .filter(c => c && c.type === "text")
                    .map(c => c.text || "")
                    .join("\n");

                if (textParts.length > 0) {
                    try {
                        return ensureGeminiFunctionResponseObject(JSON.parse(textParts));
                    } catch {
                        return { result: textParts };
                    }
                }

                return { result: content };
            }

            return ensureGeminiFunctionResponseObject(content ?? { result: "" });
        };

        const normalizeClaudeToolResultResponse = async toolResult => {
            let responseContent;
            let parts = [];
            if (Array.isArray(toolResult.content) && toolResult.content.some(block => block?.type !== "text")) {
                const converted = await this._convertClaudeToolResultMedia(toolResult.content);
                responseContent = { result: converted.content };
                parts = converted.parts;
            } else {
                responseContent = normalizeClaudeToolResultContent(toolResult.content);
            }
            if (toolResult.is_error === true && !Object.prototype.hasOwnProperty.call(responseContent, "error")) {
                responseContent = {
                    error:
                        Object.keys(responseContent).length === 1 &&
                        Object.prototype.hasOwnProperty.call(responseContent, "result")
                            ? responseContent.result
                            : responseContent,
                };
            }
            return { ...(parts.length > 0 ? { parts } : {}), response: responseContent };
        };

        const claudeServerToolBlockTypes = new Set([
            "bash_code_execution_tool_result",
            "server_tool_use",
            "text_editor_code_execution_tool_result",
            "web_search_tool_result",
            "web_fetch_tool_result",
        ]);

        const convertClaudeServerToolBlock = block => ({
            text: `[Claude server tool history: ${block.type}]\n${this._serializeClaudeServerToolData(block)}`,
        });

        // Convert Claude messages to Google format
        for (const message of claudeBody.messages) {
            if (message.role === "system") continue;
            if (message.role !== "assistant") pendingModelParts.flush();

            const googleParts = [];

            // Handle tool_result role (Claude's function response)
            if (message.role === "user" && Array.isArray(message.content)) {
                const toolResults = message.content.filter(block => block.type === "tool_result");
                if (toolResults.length > 0) {
                    for (const toolResult of toolResults) {
                        const convertedResult = await normalizeClaudeToolResultResponse(toolResult);

                        // Resolve function name using the map
                        const toolUseId = toolResult.tool_use_id;
                        let functionName = toolIdToNameMap.get(toolUseId);

                        if (!functionName) {
                            this.logger.warn(
                                `[Adapter] Warning: Tool name resolution failed for ID: ${toolUseId}. outputting as unknown_function`
                            );
                            functionName = "unknown_function";
                        }

                        pendingToolParts.push({
                            functionResponse: {
                                ...(toolUseId ? { id: toolUseId } : {}),
                                name: functionName,
                                ...convertedResult,
                            },
                        });
                    }

                    // Process non-tool_result content in the same message
                    const otherContent = message.content.filter(block => block.type !== "tool_result");
                    if (otherContent.length > 0) {
                        for (const block of otherContent) {
                            if (block.type === "text") {
                                pendingToolParts.push({ text: block.text });
                            } else if (block.type === "image") {
                                const media = await this._loadFunctionResponseMedia(block, pendingToolParts.length, {
                                    functionResponse: false,
                                });
                                pendingToolParts.push(
                                    media?.part || { text: `[Claude media unavailable]\n${JSON.stringify(block)}` }
                                );
                            }
                        }
                    }
                    if (googleParts.length === 0) continue;
                }
            }

            // Flush pending tool parts before non-tool messages
            if (
                message.role !== "user" ||
                !Array.isArray(message.content) ||
                !message.content.some(block => block.type === "tool_result")
            ) {
                pendingToolParts.flush();
            }

            // Handle assistant messages with tool_use
            if (message.role === "assistant" && Array.isArray(message.content)) {
                let signatureAttachedToCall = false;
                for (const block of message.content) {
                    if (block.type === "tool_use") {
                        const functionCallPart = {
                            functionCall: {
                                args: block.input || {},
                                ...(block.id ? { id: block.id } : {}),
                                name: block.name,
                            },
                        };
                        if (!signatureAttachedToCall) {
                            functionCallPart.thoughtSignature = FormatConverter.DUMMY_THOUGHT_SIGNATURE;
                            signatureAttachedToCall = true;
                        }
                        googleParts.push(functionCallPart);
                    } else if (block.type === "thinking") {
                        // Claude thinking block -> Gemini thought
                        // Compatibility APIs intentionally do not accept external
                        // signatures because their provenance cannot be verified.
                        googleParts.push({ text: block.thinking || "", thought: true });
                    } else if (block.type === "text") {
                        googleParts.push({ text: block.text });
                    } else if (claudeServerToolBlockTypes.has(block.type)) {
                        // Server tools have already executed. Preserve their assistant-turn
                        // history as model context without asking Gemini to execute them again.
                        googleParts.push(convertClaudeServerToolBlock(block));
                    }
                }
            }

            // Handle regular content
            if (googleParts.length === 0) {
                if (typeof message.content === "string" && message.content.length > 0) {
                    googleParts.push({ text: message.content });
                } else if (Array.isArray(message.content)) {
                    for (const block of message.content) {
                        if (block.type === "text") {
                            googleParts.push({ text: block.text });
                        } else if (block.type === "image") {
                            const source = block.source;
                            if (source.type === "base64") {
                                googleParts.push({
                                    inlineData: {
                                        data: source.data,
                                        mimeType: source.media_type,
                                    },
                                });
                            } else if (source.type === "url") {
                                try {
                                    this.logger.info(`[Adapter] Downloading image from URL: ${source.url}`);
                                    const response = await axios.get(source.url, { responseType: "arraybuffer" });
                                    const imageBuffer = Buffer.from(response.data, "binary");
                                    const base64Data = imageBuffer.toString("base64");
                                    let mimeType = response.headers["content-type"];
                                    if (!mimeType || mimeType === "application/octet-stream") {
                                        mimeType = mime.lookup(source.url) || "image/jpeg";
                                    }
                                    googleParts.push({
                                        inlineData: {
                                            data: base64Data,
                                            mimeType,
                                        },
                                    });
                                    this.logger.info(
                                        `[Adapter] Successfully downloaded and converted image to base64.`
                                    );
                                } catch (error) {
                                    this.logger.error(`[Adapter] Failed to download image: ${error.message}`);
                                    googleParts.push({
                                        text: `[System Note: Failed to load image from ${source.url}]`,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            if (googleParts.length > 0) {
                if (message.role === "assistant") {
                    pendingModelParts.push(...googleParts);
                } else {
                    googleContents.push({ parts: googleParts, role: "user" });
                }
            }
        }

        // Flush remaining tool parts
        pendingModelParts.flush();
        pendingToolParts.flush();

        // Build Google request
        const googleRequest = {
            contents: googleContents,
            ...(systemInstruction && {
                systemInstruction: { parts: systemInstruction.parts, role: "user" },
            }),
        };

        // Generation config
        const generationConfig = {
            maxOutputTokens: claudeBody.max_tokens,
            stopSequences: claudeBody.stop_sequences,
            temperature: claudeBody.temperature,
            topK: claudeBody.top_k,
            topP: claudeBody.top_p,
        };

        // Handle thinking config from Claude's metadata or top-level thinking
        let thinkingConfig = null;

        const thinkingParam = claudeBody.thinking || claudeBody.metadata?.thinking;

        // Claude supports legacy/manual thinking plus the newer adaptive and
        // between-tools modes. Gemini cannot reproduce every scheduling detail,
        // so this adapter only preserves whether thinking is enabled.
        const thinkingType = thinkingParam?.type;
        const isThinkingEnabled =
            thinkingParam &&
            (thinkingParam.enabled === true ||
                thinkingType === "enabled" ||
                thinkingType === "adaptive" ||
                thinkingType === "between_tools");
        const isThinkingDisabled = thinkingType === "disabled" || thinkingParam?.enabled === false;

        if (isThinkingEnabled) {
            thinkingConfig = { includeThoughts: thinkingParam.display !== "omitted" };
            if (thinkingParam.budget_tokens) {
                // Gemini doesn't have budget_tokens, but we can log it
                this.logger.debug(`[Adapter] Claude thinking budget_tokens: ${thinkingParam.budget_tokens}`);
            }
        } else if (isThinkingDisabled) {
            thinkingConfig = { includeThoughts: false };
        }

        // Anthropic effort values do not have exact Gemini equivalents. When no
        // recognized thinking mode has already made the decision, treat effort as
        // an enable signal without mapping its strength. Explicit disabled and
        // display:"omitted" settings therefore keep their precedence.
        const claudeEffort = claudeBody.output_config?.effort;
        if (!thinkingConfig && typeof claudeEffort === "string" && claudeEffort.length > 0) {
            thinkingConfig = { includeThoughts: true };
            this.logger.debug(`[Adapter] Claude output_config.effort enables thinking: ${claudeEffort}`);
        }

        // Force thinking mode (only set includeThoughts=true when missing)
        if (
            this.serverSystem.config.forceThinking &&
            (!thinkingConfig || thinkingConfig.includeThoughts === undefined)
        ) {
            this.logger.info("[Adapter] ⚠️ Force thinking enabled, setting includeThoughts=true for Claude request.");
            thinkingConfig = { ...(thinkingConfig || {}), includeThoughts: true };
        }

        this._applyThinkingConfig(generationConfig, thinkingConfig, modelThinkingLevel);

        // Handle Claude's structured output (output_format)
        // Ref: https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs
        if (claudeBody.output_format) {
            if (claudeBody.output_format.type === "json_schema") {
                // Support both direct 'schema' (user example) and 'json_schema' wrapper (OpenAI style)
                let schema = claudeBody.output_format.schema;
                let schemaName = "structured_output";

                if ((schema === undefined || schema === null) && claudeBody.output_format.json_schema) {
                    schema = claudeBody.output_format.json_schema.schema;
                    schemaName = claudeBody.output_format.json_schema.name || schemaName;
                }

                if (schema !== undefined && schema !== null) {
                    generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema } };
                    this.logger.info(
                        `[Adapter] Forwarded Claude output_format as Gemini responseFormat.text.schema. Name: ${schemaName}`
                    );
                }
            } else if (claudeBody.output_format.type === "json_object") {
                generationConfig.responseFormat = {
                    text: { mimeType: "APPLICATION_JSON", schema: { additionalProperties: true, type: "object" } },
                };
                this.logger.info(
                    `[Adapter] Converted Claude output_format (json_object) to Gemini responseFormat.text.`
                );
            } else if (claudeBody.output_format.type === "text") {
                generationConfig.responseFormat = { text: { mimeType: "TEXT_PLAIN" } };
            }
        }

        // Handle Claude's output_config (new format)
        if (claudeBody.output_config && claudeBody.output_config.format) {
            const format = claudeBody.output_config.format;
            if (format.type === "json_schema" && format.schema !== undefined && format.schema !== null) {
                generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema: format.schema } };
                this.logger.info(
                    `[Adapter] Forwarded Claude output_config as Gemini responseFormat.text.schema. Title: ${format.schema.title || "untitled"}`
                );
            }
        }

        googleRequest.generationConfig = generationConfig;

        // Convert Claude tools to Gemini functionDeclarations
        const builtInToolChoiceNames = new Set();
        if (claudeBody.tools && Array.isArray(claudeBody.tools) && claudeBody.tools.length > 0) {
            let hasCodeExecutionTool = false;
            let hasWebSearchTool = false;
            let hasUrlContextTool = false;
            const functionDeclarations = [];

            for (const tool of claudeBody.tools) {
                // Handle specialized web search tool type (e.g. from Claude's search integration)
                if (
                    typeof tool.type === "string" &&
                    tool.type.startsWith("web_search_") &&
                    tool.name === "web_search"
                ) {
                    hasWebSearchTool = true;
                    if (tool.name) builtInToolChoiceNames.add(tool.name);
                    this.logger.info(
                        `[Adapter] Detected web search tool in Claude request (name: ${tool.name}, type: ${tool.type}), mapping to Gemini googleSearch.`
                    );
                    continue; // Skip adding to functionDeclarations
                }

                // Handle specialized web fetch tool type, mapped to urlContext (Gemini 2.0 Feature)
                if (typeof tool.type === "string" && tool.type.startsWith("web_fetch_") && tool.name === "web_fetch") {
                    hasUrlContextTool = true;
                    if (tool.name) builtInToolChoiceNames.add(tool.name);
                    this.logger.info(
                        `[Adapter] Detected web fetch tool in Claude request (name: ${tool.name}, type: ${tool.type}), mapping to Gemini urlContext.`
                    );
                    continue; // Skip adding to functionDeclarations
                }

                // Handle specialized code execution tool, mapped to Gemini codeExecution.
                if (typeof tool.type === "string" && tool.type.startsWith("code_execution_")) {
                    if (
                        tool.name !== "code_execution" ||
                        !FormatConverter.CLAUDE_CODE_EXECUTION_TOOL_TYPES.has(tool.type)
                    ) {
                        throw new Error(`Unsupported Claude code execution tool: ${tool.type}`);
                    }
                    hasCodeExecutionTool = true;
                    if (tool.name) builtInToolChoiceNames.add(tool.name);
                    this.logger.info(
                        `[Adapter] Detected code execution tool in Claude request (name: ${tool.name}, type: ${tool.type}), mapping to Gemini codeExecution.`
                    );
                    continue; // Skip adding to functionDeclarations
                }

                if (tool.name) {
                    const declaration = { name: tool.name };
                    if (tool.description) declaration.description = tool.description;
                    if (tool.input_schema) {
                        declaration.parametersJsonSchema = tool.input_schema;
                    }
                    functionDeclarations.push(declaration);
                }
            }

            if (functionDeclarations.length > 0) {
                googleRequest.tools = [{ functionDeclarations }];
                this.logger.info(`[Adapter] Converted ${functionDeclarations.length} Claude tool(s) to Gemini format`);
            }

            // If web search tool was found, ensure googleSearch is added to tools
            if (hasWebSearchTool) {
                if (!googleRequest.tools) googleRequest.tools = [];
                if (!FormatConverter.hasGeminiGoogleSearchTool(googleRequest.tools)) {
                    googleRequest.tools.push({ googleSearch: {} });
                }
            }

            // If web fetch tool was found, ensure urlContext is added to tools
            if (hasUrlContextTool) {
                if (!googleRequest.tools) googleRequest.tools = [];
                if (!FormatConverter.hasGeminiUrlContextTool(googleRequest.tools)) {
                    googleRequest.tools.push({ urlContext: {} });
                }
            }

            // If code execution tool was found, ensure codeExecution is added to tools
            if (hasCodeExecutionTool) {
                if (!googleRequest.tools) googleRequest.tools = [];
                if (!FormatConverter.hasGeminiCodeExecutionTool(googleRequest.tools)) {
                    googleRequest.tools.push({ codeExecution: {} });
                }
            }
        }

        // Convert Claude tool_choice to Gemini toolConfig
        if (claudeBody.tool_choice) {
            const functionCallingConfig = {};
            const hasClaudeFunctionDeclarations = this.hasGeminiFunctionDeclarations(googleRequest);
            const isBuiltInToolChoice =
                claudeBody.tool_choice.type === "tool" && builtInToolChoiceNames.has(claudeBody.tool_choice.name);
            if (claudeBody.tool_choice.type === "auto" && hasClaudeFunctionDeclarations) {
                functionCallingConfig.mode = "AUTO";
            } else if (claudeBody.tool_choice.type === "none" && hasClaudeFunctionDeclarations) {
                functionCallingConfig.mode = "NONE";
            } else if (claudeBody.tool_choice.type === "any" && hasClaudeFunctionDeclarations) {
                functionCallingConfig.mode = "ANY";
            } else if (
                claudeBody.tool_choice.type === "tool" &&
                claudeBody.tool_choice.name &&
                !isBuiltInToolChoice &&
                hasClaudeFunctionDeclarations
            ) {
                functionCallingConfig.mode = "ANY";
                functionCallingConfig.allowedFunctionNames = [claudeBody.tool_choice.name];
            }
            if (Object.keys(functionCallingConfig).length > 0) {
                googleRequest.toolConfig = { functionCallingConfig };
            }
        }

        // Handle Claude's disable_parallel_tool_use
        // Note: Gemini doesn't have a direct equivalent for this at the toolConfig level,
        // but we can log it for debug purposes. Future improvements might involve
        // filtering outputs if the model ignores the implied constraint.
        if (claudeBody.tool_choice && claudeBody.tool_choice.disable_parallel_tool_use === true) {
            this.logger.info(
                "[Adapter] Claude request specifies disable_parallel_tool_use=true (Note: Applied as best-effort in Gemini)."
            );
        }

        this._applyTrailingUserTurnGuard(googleRequest, cleanModelName);
        this._finalizeGoogleRequest(googleRequest, {
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
        });
        this.logger.info("[Adapter] Claude to Google translation complete.");
        return { cleanModelName, googleRequest, modelStreamingMode };
    }
}

module.exports = ClaudeRequestConverter;
