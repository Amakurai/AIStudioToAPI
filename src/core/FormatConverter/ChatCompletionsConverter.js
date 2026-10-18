/**
 * File: src/core/FormatConverter/ChatCompletionsConverter.js
 * Description: OpenAI Chat Completions requests and streaming/non-streaming responses.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const axios = require("axios");
const mime = require("mime-types");
const FormatConverter = require("./CommonConverter");

class ChatCompletionsConverter extends FormatConverter {
    /**
     * Convert OpenAI request format to Google Gemini format
     * @param {object} openaiBody - OpenAI format request body
     * @returns {Promise<{ googleRequest: object, cleanModelName: string, modelStreamingMode: ("real"|"fake"|null) }>}
     *          - modelStreamingMode: Streaming mode override parsed from model name suffix, or null
     */
    async translateOpenAIToGoogle(openaiBody) {
        this.logger.info("[Adapter] Starting translation of OpenAI request format to Google format...");

        // [DEBUG] Log incoming messages for troubleshooting
        this.logger.debug(`[Adapter] Debug: incoming OpenAI Body = ${JSON.stringify(openaiBody, null, 2)}`);

        const rawModel = openaiBody.model || "gemini-flash-lite-latest";
        const {
            cleanModelName,
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
            streamingMode: modelStreamingMode,
            thinkingLevel: modelThinkingLevel,
        } = this.parseModelSuffixes(rawModel);

        let systemInstruction = null;
        const googleContents = [];

        // Extract system messages
        const systemMessages = openaiBody.messages.filter(msg => msg.role === "system");
        if (systemMessages.length > 0) {
            const systemContent = systemMessages.map(msg => msg.content).join("\n");
            systemInstruction = {
                parts: [{ text: systemContent }],
                role: "system",
            };
        }

        // Convert conversation messages
        const conversationMessages = openaiBody.messages.filter(msg => msg.role !== "system");

        // OpenAI tool-result messages identify the function call by `tool_call_id`;
        // they do not carry the function name. Resolve that name from the preceding
        // assistant tool call so the Gemini functionCall/functionResponse pair keeps
        // the same name and id, including for parallel calls.
        const toolCallIdToName = new Map();
        for (const message of conversationMessages) {
            if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
            for (const toolCall of message.tool_calls) {
                const toolCallId = toolCall?.id;
                const functionName = toolCall?.function?.name;
                if (typeof toolCallId === "string" && toolCallId && typeof functionName === "string" && functionName) {
                    toolCallIdToName.set(toolCallId, functionName);
                }
            }
        }

        // Buffer for accumulating consecutive tool message parts
        // Gemini requires alternating roles, so consecutive tool messages must be merged
        // functionResponse parts use the "user" role and do not need thoughtSignature.
        const pendingToolParts = this._createGoogleContentPartsBuffer(googleContents, "user");
        const pendingModelParts = this._createGoogleContentPartsBuffer(googleContents, "model");

        for (let msgIndex = 0; msgIndex < conversationMessages.length; msgIndex++) {
            const message = conversationMessages[msgIndex];
            const googleParts = [];
            if (message.role !== "assistant") pendingModelParts.flush();

            // Handle tool role (function execution result)
            if (message.role === "tool") {
                // Convert OpenAI tool response to Gemini functionResponse
                let responseContent;
                try {
                    responseContent =
                        typeof message.content === "string" ? JSON.parse(message.content) : message.content;

                    // Handle array format (common in MCP, e.g., [{ type: "text", text: "..." }])
                    // Gemini requires 'response' to be an object (Struct), not an array.
                    if (Array.isArray(responseContent)) {
                        // 1. Process ALL items (text, image, etc.)
                        const processedItems = responseContent.map(item => {
                            if (item.type === "text" && typeof item.text === "string") {
                                try {
                                    const parsed = JSON.parse(item.text);
                                    // Robustness Check: Only unwrap if it's a bare object (not null, not array, not primitive)
                                    // This prevents "123" or "true" or "[]" from becoming inconsistent types in the list
                                    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                                        return parsed;
                                    }
                                    // If it's a primitive or array, keep it wrapped as text to avoid structure confusion
                                    return { content: item.text, type: "text" };
                                } catch {
                                    return { content: item.text, type: "text" }; // Wrap raw text
                                }
                            }
                            return item; // Keep other types (e.g. image) as is
                        });

                        if (processedItems.length > 0) {
                            // 2. Determine structure
                            if (
                                processedItems.length === 1 &&
                                typeof processedItems[0] === "object" &&
                                !Array.isArray(processedItems[0]) &&
                                processedItems[0] !== null
                            ) {
                                // Single object: use it directly as the root response (Best for standard MCP)
                                responseContent = processedItems[0];
                            } else {
                                // Multiple/Mixed items configuration
                                responseContent = { result: JSON.stringify(processedItems) };
                                this.logger.info(
                                    `[Adapter] Multiple tool response items found (${processedItems.length}). Wrapping in JSON string to preserve all data.`
                                );
                            }
                        } else {
                            // Empty array or unforeseen structure
                            // To keep behavior consistent with the multiple-items case, stringify the array
                            // (e.g. returns { result: "[]" })
                            responseContent = { result: JSON.stringify(responseContent) };
                            this.logger.info(
                                `[Adapter] Empty/Unforeseen tool response structure. Wrapping in JSON string: ${JSON.stringify(responseContent)}`
                            );
                        }
                    }
                } catch (e) {
                    // If content is not valid JSON, wrap it
                    responseContent = { result: message.content };
                }

                // Gemini requires an object even when valid JSON parses to a primitive or null.
                if (responseContent === null || typeof responseContent !== "object" || Array.isArray(responseContent)) {
                    responseContent = { result: responseContent };
                }

                const toolCallId =
                    typeof message.tool_call_id === "string" && message.tool_call_id ? message.tool_call_id : null;
                const functionName = message.name || (toolCallId ? toolCallIdToName.get(toolCallId) : null);
                if (!functionName) {
                    this.logger.warn(
                        `[Adapter] Unable to resolve function name for OpenAI tool result (tool_call_id: ${toolCallId || "missing"}), using unknown_function`
                    );
                }

                // Add to buffer instead of pushing directly
                // This allows merging consecutive tool messages into one user message
                // Note: functionResponse does NOT need thoughtSignature per official docs
                const functionResponsePart = {
                    functionResponse: {
                        ...(toolCallId ? { id: toolCallId } : {}),
                        name: functionName || "unknown_function",
                        response: responseContent,
                    },
                };
                pendingToolParts.push(functionResponsePart);
                continue;
            }

            // Before processing non-tool messages, flush any pending tool parts
            pendingToolParts.flush();

            // Handle assistant messages with tool_calls
            if (message.role === "assistant" && message.tool_calls && Array.isArray(message.tool_calls)) {
                // Convert OpenAI tool_calls to Gemini functionCall
                // For Gemini 3: thoughtSignature should only be on the FIRST functionCall part
                let signatureAttachedToCall = false;
                for (const toolCall of message.tool_calls) {
                    // Avoid accessing Function.prototype.arguments in strict mode (will throw)
                    if (
                        toolCall.type === "function" &&
                        toolCall.function &&
                        typeof toolCall.function === "object" &&
                        !Array.isArray(toolCall.function)
                    ) {
                        let args;
                        try {
                            const rawArgs = Object.prototype.hasOwnProperty.call(toolCall.function, "arguments")
                                ? toolCall.function["arguments"]
                                : undefined;
                            args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
                        } catch (e) {
                            this.logger.warn(
                                `[Adapter] Failed to parse tool function arguments for "${toolCall.function.name}": ${e.message}`
                            );
                            args = {};
                        }

                        const functionCallPart = {
                            functionCall: {
                                args,
                                ...(typeof toolCall.id === "string" && toolCall.id ? { id: toolCall.id } : {}),
                                name: toolCall.function.name,
                            },
                        };
                        // Pass back thoughtSignature only on the FIRST functionCall
                        // [PLACEHOLDER MODE] - Use dummy signature to skip validation for official Gemini API testing
                        if (!signatureAttachedToCall) {
                            functionCallPart.thoughtSignature = FormatConverter.DUMMY_THOUGHT_SIGNATURE;
                            signatureAttachedToCall = true;
                            this.logger.debug(
                                `[Adapter] Using dummy thoughtSignature for first functionCall: ${toolCall.function.name}`
                            );
                        }
                        googleParts.push(functionCallPart);
                    }
                }
                // Do not continue here; allow falling through to handle potential text content (e.g. thoughts)
            }

            // Handle regular text content
            if (typeof message.content === "string" && message.content.length > 0) {
                const textPart = { text: message.content };
                googleParts.push(textPart);
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === "text") {
                        const textPart = { text: part.text };
                        googleParts.push(textPart);
                    } else if (part.type === "image_url" && part.image_url) {
                        const dataUrl = this.normalizeImageUrl(part.image_url);
                        if (!dataUrl) {
                            this.logger.warn("[Adapter] Skipping image_url part because no string URL was provided.");
                            googleParts.push({
                                text: "[System Note: Skipped an image input because image_url was not a string URL]",
                            });
                            continue;
                        }
                        const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
                        if (match) {
                            googleParts.push({
                                inlineData: {
                                    data: match[2],
                                    mimeType: match[1],
                                },
                            });
                        } else if (dataUrl.match(/^https?:\/\//)) {
                            try {
                                this.logger.info(`[Adapter] Downloading image from URL: ${dataUrl}`);
                                const response = await axios.get(dataUrl, {
                                    responseType: "arraybuffer",
                                });
                                const imageBuffer = Buffer.from(response.data, "binary");
                                const base64Data = imageBuffer.toString("base64");
                                let mimeType = response.headers["content-type"];
                                if (!mimeType || mimeType === "application/octet-stream") {
                                    mimeType = mime.lookup(dataUrl) || "image/jpeg"; // Fallback
                                }
                                googleParts.push({
                                    inlineData: {
                                        data: base64Data,
                                        mimeType,
                                    },
                                });
                                this.logger.info(`[Adapter] Successfully downloaded and converted image to base64.`);
                            } catch (error) {
                                this.logger.error(
                                    `[Adapter] Failed to download or process image from URL: ${dataUrl}`,
                                    error
                                );
                                // Optionally, push an error message as text
                                googleParts.push({ text: `[System Note: Failed to load image from ${dataUrl}]` });
                            }
                        } else {
                            this.logger.warn(
                                `[Adapter] Skipping image_url part because URL format is unsupported: ${dataUrl}`
                            );
                            googleParts.push({
                                text: "[System Note: Skipped an image input because image_url format was unsupported]",
                            });
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

        // Flush any remaining tool parts after the loop
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
            maxOutputTokens: openaiBody.max_tokens,
            stopSequences: openaiBody.stop,
            temperature: openaiBody.temperature,
            topK: openaiBody.top_k,
            topP: openaiBody.top_p,
        };

        // Handle thinking config
        const extraBody = openaiBody.extra_body || {};
        const rawThinkingConfig =
            extraBody.google?.thinking_config ||
            extraBody.google?.thinkingConfig ||
            extraBody.thinkingConfig ||
            extraBody.thinking_config ||
            openaiBody.thinkingConfig ||
            openaiBody.thinking_config;

        let thinkingConfig = null;

        if (rawThinkingConfig) {
            thinkingConfig = {};

            if (rawThinkingConfig.include_thoughts !== undefined) {
                thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
            } else if (rawThinkingConfig.includeThoughts !== undefined) {
                thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
            }

            this.logger.info(
                `[Adapter] Successfully extracted and converted thinking config: ${JSON.stringify(thinkingConfig)}`
            );
        }

        // Handle OpenAI reasoning_effort parameter
        if (!thinkingConfig) {
            const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
            if (effort) {
                this.logger.debug(
                    `[Adapter] Detected OpenAI standard reasoning parameter (reasoning_effort: ${effort}), auto-converting to Google format.`
                );
                thinkingConfig = { includeThoughts: true };
            }
        }

        // Force thinking mode (only set includeThoughts=true when missing)
        if (
            this.serverSystem.config.forceThinking &&
            (!thinkingConfig || thinkingConfig.includeThoughts === undefined)
        ) {
            this.logger.info("[Adapter] ⚠️ Force thinking enabled, setting includeThoughts=true for OpenAI request.");
            thinkingConfig = { ...(thinkingConfig || {}), includeThoughts: true };
        }

        this._applyThinkingConfig(generationConfig, thinkingConfig, modelThinkingLevel);

        googleRequest.generationConfig = generationConfig;

        // Convert OpenAI tools to Gemini functionDeclarations
        const openaiTools = openaiBody.tools || openaiBody.functions;
        if (openaiTools && Array.isArray(openaiTools) && openaiTools.length > 0) {
            const functionDeclarations = [];

            for (const tool of openaiTools) {
                // Handle OpenAI tools format: { type: "function", function: {...} }
                // Also handle legacy functions format: { name, description, parameters }
                const funcDef = tool.function || tool;

                if (funcDef && funcDef.name) {
                    const declaration = {
                        name: funcDef.name,
                    };

                    if (funcDef.description) {
                        declaration.description = funcDef.description;
                    }

                    if (funcDef.parameters) {
                        declaration.parametersJsonSchema = funcDef.parameters;
                    }
                    functionDeclarations.push(declaration);
                }
            }

            if (functionDeclarations.length > 0) {
                googleRequest.tools = [{ functionDeclarations }];
                this.logger.info(`[Adapter] Converted ${functionDeclarations.length} OpenAI tool(s) to Gemini format`);
            }
        }

        // Convert OpenAI tool_choice to Gemini toolConfig.functionCallingConfig
        const toolChoice = openaiBody.tool_choice || openaiBody.function_call;
        if (toolChoice) {
            const functionCallingConfig = {};
            const hasFunctionDeclarations = this.hasGeminiFunctionDeclarations(googleRequest);

            if (toolChoice === "auto" && hasFunctionDeclarations) {
                functionCallingConfig.mode = "AUTO";
            } else if (toolChoice === "none" && hasFunctionDeclarations) {
                functionCallingConfig.mode = "NONE";
            } else if (toolChoice === "required" && hasFunctionDeclarations) {
                functionCallingConfig.mode = "ANY";
            } else if (typeof toolChoice === "object" && toolChoice.type === "allowed_tools") {
                // Chat nests the mode/selectors under allowed_tools; Responses uses a flat shape.
                const allowedTools = toolChoice.allowed_tools;
                if (!allowedTools || !["auto", "required"].includes(allowedTools.mode)) {
                    throw new Error("Chat allowed_tools requires an auto or required mode.");
                }
                if (!Array.isArray(allowedTools.tools)) {
                    throw new Error("Chat allowed_tools requires a tools array.");
                }
                const declaredNames = new Set(
                    (googleRequest.tools || []).flatMap(tool =>
                        (tool.functionDeclarations || []).map(declaration => declaration.name)
                    )
                );
                const allowedNames = [];
                for (const selector of allowedTools.tools) {
                    const name = selector?.type === "function" ? selector.function?.name : undefined;
                    if (typeof name !== "string" || !declaredNames.has(name)) {
                        throw new Error("Chat allowed_tools must select declared function tools.");
                    }
                    if (!allowedNames.includes(name)) allowedNames.push(name);
                }
                if (allowedNames.length === 0) {
                    if (allowedTools.mode === "required") {
                        throw new Error("Chat allowed_tools required mode needs at least one function.");
                    }
                    functionCallingConfig.mode = "NONE";
                } else {
                    functionCallingConfig.mode = allowedTools.mode === "required" ? "ANY" : "VALIDATED";
                    functionCallingConfig.allowedFunctionNames = allowedNames;
                }
            } else if (typeof toolChoice === "object" && hasFunctionDeclarations) {
                // Handle { type: "function", function: { name: "xxx" } }
                // or legacy { name: "xxx" }
                const funcName = toolChoice.function?.name || toolChoice.name;
                if (funcName) {
                    functionCallingConfig.mode = "ANY";
                    functionCallingConfig.allowedFunctionNames = [funcName];
                }
            }

            if (Object.keys(functionCallingConfig).length > 0) {
                googleRequest.toolConfig = { functionCallingConfig };
                this.logger.debug(
                    `[Adapter] Converted tool_choice to Gemini toolConfig: ${JSON.stringify(functionCallingConfig)}`
                );
            }
        }

        // Handle response_format for structured output
        // Pass the JSON Schema through without converting its types or constraints.
        const responseFormat = openaiBody.response_format;
        if (responseFormat) {
            if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
                // Extract schema from OpenAI format
                const jsonSchema = responseFormat.json_schema;
                const schema = jsonSchema.schema;

                if (schema !== undefined && schema !== null) {
                    generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema } };
                    this.logger.info(
                        `[Adapter] Forwarded OpenAI response_format as Gemini responseFormat.text.schema: ${jsonSchema.name || "unnamed"}`
                    );
                }
            } else if (responseFormat.type === "json_object") {
                // MIME alone may not constrain output on the AI Studio path; allow arbitrary object properties.
                generationConfig.responseFormat = {
                    text: { mimeType: "APPLICATION_JSON", schema: { additionalProperties: true, type: "object" } },
                };
                this.logger.info("[Adapter] Enabled JSON object mode with an open object schema");
            } else if (responseFormat.type === "text") {
                // Explicit text mode (default behavior, no action needed)
                this.logger.debug("[Adapter] Response format set to text (default)");
            } else {
                this.logger.warn(`[Adapter] Unsupported response_format type: ${responseFormat.type}. Ignoring.`);
            }
        }

        this._applyTrailingUserTurnGuard(googleRequest, cleanModelName);
        this._finalizeGoogleRequest(googleRequest, {
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
        });
        this.logger.info("[Adapter] OpenAI to Google translation complete.");
        return { cleanModelName, googleRequest, modelStreamingMode };
    }

    /**
     * Convert Google streaming response chunk to OpenAI format
     * @param {string} googleChunk - The Google response chunk
     * @param {string} modelName - The model name
     * @param {object} streamState - Optional state object to track thought mode
     */
    translateGoogleToOpenAIStream(googleChunk, modelName = "gemini-flash-lite-latest", streamState = null) {
        this.logger.debug(`[Adapter] Debug: Received Google chunk for OpenAI: ${googleChunk}`);

        // Ensure streamState exists to properly track tool call indices
        if (!streamState) {
            this.logger.warn(
                "[Adapter] streamState not provided, creating default state. This may cause issues with tool call tracking."
            );
            streamState = {};
        }
        if (!googleChunk || googleChunk.trim() === "") {
            return null;
        }

        let jsonString = googleChunk;
        if (jsonString.startsWith("data: ")) {
            jsonString = jsonString.substring(6).trim();
        }

        if (jsonString === "[DONE]") {
            return "data: [DONE]\n\n";
        }

        let googleResponse;
        try {
            googleResponse = JSON.parse(jsonString);
        } catch (e) {
            this.logger.warn(`[Adapter] Unable to parse Google JSON chunk for OpenAI: ${jsonString}`);
            return null;
        }

        if (!streamState.id) {
            streamState.id = `chatcmpl-${this._generateRequestId()}`;
            streamState.created = Math.floor(Date.now() / 1000);
        }
        const streamId = streamState.id;
        const created = streamState.created;

        // Cache usage data whenever it arrives.
        // Store in streamState to prevent concurrency issues between requests
        if (googleResponse.usageMetadata) {
            streamState.usage = this._parseUsage(googleResponse);
        }

        const candidate = googleResponse.candidates?.[0];

        if (!candidate) {
            if (googleResponse.promptFeedback) {
                this.logger.warn(
                    `[Adapter] Google returned promptFeedback for OpenAI stream, may have been blocked: ${JSON.stringify(
                        googleResponse.promptFeedback
                    )}`
                );
                const errorText = `[ProxySystem Error] Request blocked due to safety settings. Finish Reason: ${googleResponse.promptFeedback.blockReason}`;
                return `data: ${JSON.stringify({
                    choices: [{ delta: { content: errorText }, finish_reason: "stop", index: 0 }],
                    created,
                    id: streamId,
                    model: modelName,
                    object: "chat.completion.chunk",
                })}\n\n`;
            }
            return null;
        }

        const chunksToSend = [];

        // Iterate over each part in the Gemini chunk and send it as a separate OpenAI chunk
        if (candidate.content && Array.isArray(candidate.content.parts)) {
            for (const part of candidate.content.parts) {
                const delta = {};
                let hasContent = false;

                if (part.thought === true) {
                    if (part.text) {
                        delta.reasoning_content = part.text;
                        hasContent = true;
                    }
                } else if (part.text) {
                    delta.content = part.text;
                    hasContent = true;
                } else if (part.inlineData) {
                    delta.content = this._inlineDataMarkdown(part.inlineData);
                    this.logger.info("[Adapter] Successfully parsed media from streaming response chunk.");
                    hasContent = true;
                } else if (part.functionCall) {
                    // Convert Gemini functionCall to OpenAI tool_calls format
                    const funcCall = part.functionCall;
                    const toolCallId =
                        typeof funcCall.id === "string" && funcCall.id
                            ? funcCall.id
                            : `call_${this._generateRequestId()}`;

                    // Track tool call index for multiple function calls
                    const toolCallIndex = streamState.toolCallIndex ?? 0;
                    streamState.toolCallIndex = toolCallIndex + 1;

                    const toolCallObj = {
                        function: {
                            arguments: JSON.stringify(funcCall.args || {}),
                            name: funcCall.name,
                        },
                        id: toolCallId,
                        index: toolCallIndex,
                        type: "function",
                    };

                    delta.tool_calls = [toolCallObj];

                    // Mark that we have a function call for finish_reason
                    streamState.hasFunctionCall = true;

                    this.logger.info(
                        `[Adapter] Converted Gemini functionCall to OpenAI tool_calls: ${funcCall.name} (index: ${toolCallIndex})`
                    );
                    hasContent = true;
                }

                if (hasContent) {
                    // The 'role' should only be sent in the first chunk with content.
                    if (!streamState.roleSent) {
                        delta.role = "assistant";
                        streamState.roleSent = true;
                    }

                    const openaiResponse = {
                        choices: [
                            {
                                delta,
                                finish_reason: null,
                                index: 0,
                            },
                        ],
                        created,
                        id: streamId,
                        model: modelName,
                        object: "chat.completion.chunk",
                    };
                    chunksToSend.push(`data: ${JSON.stringify(openaiResponse)}\n\n`);
                }
            }
        }

        // Handle the final chunk with finish_reason and usage
        if (candidate.finishReason) {
            // Determine the correct finish_reason for OpenAI format
            let finishReason;
            if (streamState.hasFunctionCall) {
                finishReason = "tool_calls";
            } else {
                finishReason = this._mapFinishReason(candidate.finishReason, modelName);
            }

            const finalResponse = {
                choices: [
                    {
                        delta: {},
                        finish_reason: finishReason,
                        index: 0,
                    },
                ],
                created,
                id: streamId,
                model: modelName,
                object: "chat.completion.chunk",
            };

            // Attach cached usage data to the very last message (if available)
            if (streamState.usage) {
                finalResponse.usage = streamState.usage;
            }
            chunksToSend.push(`data: ${JSON.stringify(finalResponse)}\n\n`);
        }

        return chunksToSend.length > 0 ? chunksToSend.join("") : null;
    }

    /**
     * Convert Google non-stream response to OpenAI format
     */
    convertGoogleToOpenAINonStream(googleResponse, modelName = "gemini-flash-lite-latest") {
        try {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for OpenAI non-stream: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Adapter] Debug: Received Google response for OpenAI non-stream (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }

        const candidate = googleResponse.candidates?.[0];

        if (!candidate) {
            this.logger.warn("[Adapter] No candidate found in Google response");
            return {
                choices: [
                    {
                        finish_reason: "stop",
                        index: 0,
                        message: { content: "", role: "assistant" },
                    },
                ],
                created: Math.floor(Date.now() / 1000),
                id: `chatcmpl-${this._generateRequestId()}`,
                model: modelName,
                object: "chat.completion",
                usage: {
                    completion_tokens: 0,
                    prompt_tokens: 0,
                    total_tokens: 0,
                },
            };
        }

        let content = "";
        let reasoning_content = "";
        const tool_calls = [];

        if (candidate.content && Array.isArray(candidate.content.parts)) {
            for (const part of candidate.content.parts) {
                if (part.thought === true) {
                    reasoning_content += part.text || "";
                } else if (part.text) {
                    content += part.text;
                } else if (part.inlineData) {
                    content += this._inlineDataMarkdown(part.inlineData);
                } else if (part.functionCall) {
                    // Convert Gemini functionCall to OpenAI tool_calls format
                    const funcCall = part.functionCall;
                    const toolCallId =
                        typeof funcCall.id === "string" && funcCall.id
                            ? funcCall.id
                            : `call_${this._generateRequestId()}`;

                    const toolCallObj = {
                        function: {
                            arguments: JSON.stringify(funcCall.args || {}),
                            name: funcCall.name,
                        },
                        id: toolCallId,
                        index: tool_calls.length,
                        type: "function",
                    };
                    tool_calls.push(toolCallObj);
                    this.logger.info(`[Adapter] Converted Gemini functionCall to OpenAI tool_calls: ${funcCall.name}`);
                }
            }
        }

        const message = { content, role: "assistant" };
        if (reasoning_content) {
            message.reasoning_content = reasoning_content;
        }
        if (tool_calls.length > 0) {
            message.tool_calls = tool_calls;
        }

        // Determine finish_reason
        let finishReason;
        if (tool_calls.length > 0) {
            finishReason = "tool_calls";
        } else {
            finishReason = this._mapFinishReason(candidate.finishReason, modelName);
        }

        return {
            choices: [
                {
                    finish_reason: finishReason,
                    index: 0,
                    message,
                },
            ],
            created: Math.floor(Date.now() / 1000),
            id: `chatcmpl-${this._generateRequestId()}`,
            model: modelName,
            object: "chat.completion",
            usage: this._parseUsage(googleResponse),
        };
    }
}

module.exports = ChatCompletionsConverter;
