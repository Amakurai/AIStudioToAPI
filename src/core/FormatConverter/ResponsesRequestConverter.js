/**
 * File: src/core/FormatConverter/ResponsesRequestConverter.js
 * Description: OpenAI Responses requests, namespace tools, and tool selectors.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const axios = require("axios");
const mime = require("mime-types");
const FormatConverter = require("./CommonConverter");

class ResponsesRequestConverter extends FormatConverter {
    /**
     * Gemini exposes a flat function namespace, while the Responses API can group
     * functions under a `namespace` tool. Build a stable Gemini-safe alias for a
     * namespaced function and keep enough metadata to restore the official
     * Responses `name` + `namespace` shape on the way back.
     *
     * Gemini function names are kept to ASCII letters, digits, and underscores
     * and capped at 64 characters. The hash makes aliases stable and prevents
     * equal inner function names in different namespaces from colliding.
     *
     * @param {string} namespace - Responses API namespace name
     * @param {string} functionName - Function name inside the namespace
     * @returns {string} Gemini-safe function name
     * @private
     */
    _encodeResponseNamespaceFunctionName(namespace, functionName) {
        const source = `${namespace}\u0000${functionName}`;
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        const hashText = (hash >>> 0).toString(36).padStart(7, "0").slice(-7);
        let readable = `ns_${namespace}__${functionName}`.replace(/[^A-Za-z0-9_]/g, "_");
        if (!/^[A-Za-z_]/.test(readable)) readable = `ns_${readable}`;
        const suffix = `_${hashText}`;
        return `${readable.slice(0, 64 - suffix.length)}${suffix}`;
    }

    /**
     * Collect Responses API function tools, including functions nested in
     * namespace tools, into Gemini's flat functionDeclarations representation.
     *
     * @param {Array<object>} tools - Responses API tools
     * @returns {{
     *   functionDeclarations: Array<object>,
     *   functionNameMap: Record<string, {name: string, namespace?: string, type?: string}>,
     *   namespaceAliasMap: Record<string, string>,
     *   namespaceFunctionCount: number
     * }} Flattened declarations and reversible name mappings
     * @private
     */
    _flattenResponseFunctionTools(tools) {
        const functionDeclarations = [];
        const functionNameMap = Object.create(null);
        const namespaceAliasMap = Object.create(null);
        const usedNames = new Set();
        let namespaceFunctionCount = 0;

        const addDeclaration = (funcDef, namespace = null, namespaceDescription = null) => {
            if (!funcDef || typeof funcDef.name !== "string" || !funcDef.name) return;

            let geminiName = funcDef.name;
            if (namespace) {
                geminiName = this._encodeResponseNamespaceFunctionName(namespace, funcDef.name);
            }

            if (usedNames.has(geminiName)) {
                this.logger.warn(
                    `[Adapter] Duplicate Responses API function name after namespace flattening, skipping: ${geminiName}`
                );
                return;
            }
            usedNames.add(geminiName);

            if (namespace || funcDef.type === "custom") {
                const mapKey = `${namespace}\u0000${funcDef.name}`;
                if (namespace) {
                    namespaceAliasMap[mapKey] = geminiName;
                    namespaceFunctionCount++;
                }
                functionNameMap[geminiName] = {
                    name: funcDef.name,
                    ...(namespace ? { namespace } : {}),
                    ...(funcDef.type === "custom" ? { type: "custom" } : {}),
                };
            }

            const declaration = { name: geminiName };
            const descriptionParts = [];
            if (namespace) descriptionParts.push(`Responses API namespace: ${namespace}.`);
            if (namespaceDescription) descriptionParts.push(namespaceDescription);
            if (funcDef.description) descriptionParts.push(funcDef.description);
            if (funcDef.type === "custom") {
                descriptionParts.push(
                    "Put the exact raw tool input in the input string. Do not add wrappers or Markdown fences to that string."
                );
                const format = funcDef.format;
                if (format?.type === "grammar") {
                    if (!["lark", "regex"].includes(format.syntax) || typeof format.definition !== "string") {
                        throw new Error(`Invalid custom tool grammar: ${funcDef.name}`);
                    }
                    descriptionParts.push(
                        `The input must conform to this ${format.syntax} grammar:\n${format.definition}`
                    );
                    this.logger.debug(
                        `[Adapter] Custom tool ${funcDef.name}: Gemini can only follow the grammar as instructions; constrained grammar decoding is unavailable.`
                    );
                } else if (format && format.type !== "text") {
                    throw new Error(`Unsupported custom tool format: ${format.type}`);
                }
                declaration.parametersJsonSchema = {
                    additionalProperties: false,
                    properties: { input: { type: "string" } },
                    required: ["input"],
                    type: "object",
                };
            }
            if (descriptionParts.length > 0) declaration.description = descriptionParts.join(" ");
            if (funcDef.type !== "custom" && funcDef.parameters) declaration.parametersJsonSchema = funcDef.parameters;
            functionDeclarations.push(declaration);
        };

        for (const tool of Array.isArray(tools) ? tools : []) {
            if (!tool || typeof tool !== "object") continue;
            if (tool.type === "function" || tool.type === "custom") {
                const funcDef = tool.function && typeof tool.function === "object" ? tool.function : tool;
                addDeclaration(funcDef);
            } else if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
                for (const nestedTool of tool.tools) {
                    if (!nestedTool || !["function", "custom"].includes(nestedTool.type)) continue;
                    const funcDef =
                        nestedTool.function && typeof nestedTool.function === "object"
                            ? nestedTool.function
                            : nestedTool;
                    addDeclaration(funcDef, tool.name, tool.description);
                }
            }
        }

        return { functionDeclarations, functionNameMap, namespaceAliasMap, namespaceFunctionCount };
    }

    /**
     * Resolve Responses API allowed_tools selectors against the full tool
     * definitions. Selectors only identify tools and do not carry schemas or
     * descriptions, so they must not be forwarded as declarations themselves.
     *
     * @param {Array<object>} tools - Full Responses API tool definitions
     * @param {Array<object>} selectors - tool_choice.tools selectors for allowed_tools
     * @returns {Array<object>} Selected full tool definitions
     * @private
     */
    _filterResponseToolsBySelectors(tools, selectors) {
        const definitions = Array.isArray(tools) ? tools : [];
        const allowedSelectors = Array.isArray(selectors)
            ? selectors.filter(selector => selector && typeof selector === "object")
            : [];

        const matchesSelector = (tool, selector, namespace = null) => {
            if (!tool || !selector || tool.type !== selector.type) return false;
            const toolName = tool.name ?? tool.function?.name;
            const selectorName = selector.name ?? selector.function?.name;
            if (toolName !== undefined && toolName !== selectorName) return false;
            if (toolName === undefined && selectorName !== undefined) return false;
            if (namespace !== null && selector.namespace !== namespace) return false;
            if (namespace === null && selector.namespace !== undefined) return false;
            if (selector.server_label !== undefined && tool.server_label !== selector.server_label) return false;
            return true;
        };

        const selectedTools = [];
        for (const tool of definitions) {
            if (!tool || typeof tool !== "object") continue;

            if (tool.type !== "namespace") {
                if (allowedSelectors.some(selector => matchesSelector(tool, selector))) {
                    selectedTools.push(tool);
                }
                continue;
            }

            if (allowedSelectors.some(selector => matchesSelector(tool, selector))) {
                selectedTools.push(tool);
                continue;
            }

            const nestedTools = Array.isArray(tool.tools)
                ? tool.tools.filter(nestedTool =>
                      allowedSelectors.some(selector => matchesSelector(nestedTool, selector, tool.name))
                  )
                : [];
            if (nestedTools.length > 0) {
                selectedTools.push({ ...tool, tools: nestedTools });
            }
        }

        return selectedTools;
    }

    // ==================== OpenAI Response API Format Conversion ====================

    /**
     * Convert OpenAI Response API request format to Google Gemini format
     * Response API uses different structure: input instead of messages, instructions instead of system message
     * @param {object} responseBody - OpenAI Response API format request body
     * @returns {Promise<{
     *   googleRequest: object,
     *   cleanModelName: string,
     *   modelStreamingMode: ("real"|"fake"|null),
     *   responseFunctionNameMap: Record<string, {name: string, namespace?: string, type?: string}>
     * }>}
     *          - modelStreamingMode: Streaming mode override parsed from model name suffix, or null
     */
    async translateOpenAIResponseToGoogle(responseBody) {
        this.logger.info("[Adapter] Starting translation of OpenAI Response API request format to Google format...");

        this.logger.debug(
            `[Adapter] Debug: incoming OpenAI Response API Body = ${JSON.stringify(responseBody, null, 2)}`
        );

        const rawModel = responseBody.model || "gemini-flash-lite-latest";
        const {
            cleanModelName,
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
            streamingMode: modelStreamingMode,
            thinkingLevel: modelThinkingLevel,
        } = this.parseModelSuffixes(rawModel);

        const toolChoice = responseBody.tool_choice;

        // `tool_choice: {type:"allowed_tools", tools:[...]}` contains selectors,
        // not full tool definitions. Resolve those selectors against responseBody.tools
        // before flattening namespace tools so schemas and descriptions are preserved.
        const availableTools = [
            ...(Array.isArray(responseBody.tools) ? responseBody.tools : []),
            ...(Array.isArray(responseBody.input)
                ? responseBody.input.flatMap(item =>
                      item?.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : []
                  )
                : []),
        ];
        let effectiveTools = availableTools;
        if (
            toolChoice &&
            typeof toolChoice === "object" &&
            toolChoice.type === "allowed_tools" &&
            Array.isArray(toolChoice.tools)
        ) {
            effectiveTools = this._filterResponseToolsBySelectors(availableTools, toolChoice.tools);
        }
        const responseFunctionTools = this._flattenResponseFunctionTools(effectiveTools);
        const toGeminiFunctionName = (name, namespace) => {
            if (typeof namespace !== "string" || !namespace || typeof name !== "string" || !name) return name;
            return (
                responseFunctionTools.namespaceAliasMap[`${namespace}\u0000${name}`] ||
                this._encodeResponseNamespaceFunctionName(namespace, name)
            );
        };

        const googleContents = [];
        let systemInstructionText = "";

        const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
        const ensureJSONObject = (value, fallbackKey) => (isPlainObject(value) ? value : { [fallbackKey]: value });
        const safeParseJSON = (value, fallbackKey) => {
            if (typeof value !== "string") {
                return ensureJSONObject(value, fallbackKey);
            }

            try {
                return ensureJSONObject(JSON.parse(value || "{}"), fallbackKey);
            } catch (e) {
                this.logger.warn(`[Adapter] Failed to parse JSON for ${fallbackKey}: ${e.message}`);
                return { [fallbackKey]: value };
            }
        };

        const convertFunctionCallOutput = async output => {
            if (!Array.isArray(output)) {
                return { response: safeParseJSON(output, "unparsed_output") };
            }

            const normalizedOutput = [];
            const parts = [];
            for (let itemIndex = 0; itemIndex < output.length; itemIndex++) {
                const contentPart = output[itemIndex];
                if (contentPart?.type === "input_text") {
                    normalizedOutput.push({ text: contentPart.text || "", type: "input_text" });
                    continue;
                }

                if (contentPart?.type === "input_image" || contentPart?.type === "input_file") {
                    const media = await this._loadFunctionResponseMedia(contentPart, itemIndex);
                    if (media) {
                        normalizedOutput.push({
                            content: { $ref: media.displayName },
                            ...(contentPart.filename ? { filename: contentPart.filename } : {}),
                            type: contentPart.type,
                        });
                        parts.push(media.part);
                    } else {
                        normalizedOutput.push(contentPart);
                    }
                    continue;
                }

                normalizedOutput.push(contentPart);
            }

            return {
                response: { output: normalizedOutput },
                ...(parts.length > 0 ? { parts } : {}),
            };
        };

        const serializeResponseTextPart = contentPart => {
            const text = typeof contentPart?.text === "string" ? contentPart.text : "";
            if (contentPart?.type !== "output_text" || !Array.isArray(contentPart.annotations)) {
                return text;
            }

            // Gemini request content has no equivalent to Responses API output_text
            // annotations. Preserve URL citations in the replayed assistant history as
            // text so stateless follow-up requests can still reason about their sources.
            const seenCitationUrls = new Set();
            const citations = [];
            for (const annotation of contentPart.annotations) {
                if (
                    annotation?.type !== "url_citation" ||
                    typeof annotation.url !== "string" ||
                    !annotation.url ||
                    seenCitationUrls.has(annotation.url)
                ) {
                    continue;
                }
                seenCitationUrls.add(annotation.url);
                citations.push({
                    ...(typeof annotation.title === "string" && annotation.title ? { title: annotation.title } : {}),
                    url: annotation.url,
                });
            }

            if (citations.length === 0) return text;
            return `${text}\n\n[Source citations from the prior assistant response]\n${citations
                .map(citation => `- ${citation.title ? `${citation.title}: ` : ""}${citation.url}`)
                .join("\n")}`;
        };

        const extractTextContent = content => {
            if (typeof content === "string") return content;
            if (!Array.isArray(content)) return "";
            return content
                .filter(
                    c =>
                        c &&
                        typeof c === "object" &&
                        (c.type === "text" || c.type === "input_text" || c.type === "output_text")
                )
                .map(serializeResponseTextPart)
                .filter(Boolean)
                .join("\n");
        };

        const instructions = responseBody.instructions;
        if (typeof instructions === "string") {
            systemInstructionText = instructions;
        } else if (Array.isArray(instructions)) {
            const systemItems = instructions.filter(
                item => item && typeof item === "object" && (item.role === "system" || item.role === "developer")
            );
            if (systemItems.length > 0) {
                const extraContent = systemItems
                    .map(item => extractTextContent(item.content))
                    .filter(Boolean)
                    .join("\n");
                if (extraContent) systemInstructionText = extraContent;
            }
        }

        const input = responseBody.input;

        if (Array.isArray(input)) {
            const systemItems = input.filter(
                item => item && typeof item === "object" && (item.role === "system" || item.role === "developer")
            );
            if (systemItems.length > 0) {
                const extraContent = systemItems
                    .map(item => extractTextContent(item.content))
                    .filter(t => t.length > 0)
                    .join("\n");

                if (extraContent) {
                    systemInstructionText = systemInstructionText
                        ? `${systemInstructionText}\n${extraContent}`
                        : extraContent;
                }
            }
        }

        let systemInstruction = null;
        if (systemInstructionText) {
            systemInstruction = {
                parts: [{ text: systemInstructionText }],
                // Keep consistent with other adapters: systemInstruction is sent as a separate instruction channel,
                // and Gemini API expects it to be encoded as a "user" role here.
                role: "user",
            };
        }

        if (typeof input === "string") {
            // Simple string input
            googleContents.push({
                parts: [{ text: input }],
                role: "user",
            });
        } else if (Array.isArray(input)) {
            // Array input - could be strings or message objects
            //
            // Tool-call translation notes (Responses API <-> Gemini function calling):
            // - The Responses API `call_id` is written back into BOTH the Gemini
            //   `functionCall.id` and the paired `functionResponse.id`, so parallel calls
            //   can be paired without ambiguity. On the way out (Gemini -> Responses), the
            //   Gemini-issued `functionCall.id` is passed through as `call_id`.
            // - Adjacent function_call items are merged into ONE model turn, and the
            //   function_call_output items answering them are merged into ONE user turn,
            //   matching Gemini's convention for parallel function calling.
            const callIdToName = Object.create(null);
            const toolCallsInOrder = [];
            const toolCallsAnsweredByCallId = new Set();
            const functionResponseMetaByItem = new Map();
            for (let itemIndex = 0; itemIndex < input.length; itemIndex++) {
                const scannedItem = input[itemIndex];
                if (!scannedItem || typeof scannedItem !== "object") {
                    continue;
                }
                if (
                    ["function_call", "custom_tool_call"].includes(scannedItem.type) &&
                    typeof scannedItem.name === "string"
                ) {
                    const geminiFunctionName = toGeminiFunctionName(scannedItem.name, scannedItem.namespace);
                    toolCallsInOrder.push({
                        callId:
                            typeof scannedItem.call_id === "string" && scannedItem.call_id ? scannedItem.call_id : null,
                        index: itemIndex,
                        matched: false,
                        name: geminiFunctionName,
                    });
                    if (typeof scannedItem.call_id === "string" && scannedItem.call_id) {
                        callIdToName[scannedItem.call_id] = geminiFunctionName;
                    }
                } else if (["function_call_output", "custom_tool_call_output"].includes(scannedItem.type)) {
                    const outputCallId =
                        typeof scannedItem.call_id === "string" && scannedItem.call_id ? scannedItem.call_id : null;
                    if (outputCallId) {
                        toolCallsAnsweredByCallId.add(outputCallId);
                    }
                    // Prefer the name already resolved from the paired call. Namespaced
                    // Responses tools use a flattened Gemini alias, so the raw output
                    // name (for example, `lookup`) must not replace the alias associated
                    // with its call_id. If the call is not present in this input history,
                    // rebuild the same deterministic alias from the explicit namespace.
                    let functionName =
                        (outputCallId ? callIdToName[outputCallId] : undefined) ||
                        (typeof scannedItem.name === "string" && scannedItem.name
                            ? toGeminiFunctionName(scannedItem.name, scannedItem.namespace)
                            : undefined);
                    if (!functionName) {
                        // No usable call_id/name on the output item. When the history holds
                        // exactly one call issued before this output that is still unmatched,
                        // pair by elimination; otherwise use a clearly-labeled placeholder
                        // (and log loudly) instead of silently feeding the model a wrong name.
                        let eliminationCandidate = null;
                        for (const toolCall of toolCallsInOrder) {
                            if (toolCall.index >= itemIndex) {
                                break;
                            }
                            if (
                                toolCall.matched ||
                                (toolCall.callId && toolCallsAnsweredByCallId.has(toolCall.callId))
                            ) {
                                continue;
                            }
                            if (eliminationCandidate) {
                                eliminationCandidate = null;
                                break;
                            }
                            eliminationCandidate = toolCall;
                        }
                        if (eliminationCandidate) {
                            eliminationCandidate.matched = true;
                            functionName = eliminationCandidate.name;
                            this.logger.debug(
                                `[Adapter] Paired function_call_output with single unmatched function_call by elimination: ${eliminationCandidate.name}`
                            );
                        } else {
                            functionName = "unknown_function";
                            this.logger.warn(
                                `[Adapter] function_call_output has no resolvable function name (call_id: ${outputCallId || "missing"}), using placeholder "unknown_function"`
                            );
                        }
                    }
                    functionResponseMetaByItem.set(scannedItem, {
                        id: outputCallId || undefined,
                        name: functionName,
                    });
                }
            }

            // Keep assistant messages, reasoning and tool calls in the same model turn.
            // The function_call_output items answering them form the following user turn.
            const pendingModelParts = this._createGoogleContentPartsBuffer(googleContents, "model");
            const pendingFunctionResponseParts = this._createGoogleContentPartsBuffer(googleContents, "user");
            const flushToolTurns = () => {
                pendingModelParts.flush();
                pendingFunctionResponseParts.flush();
            };

            for (const item of input) {
                if (typeof item === "string") {
                    // Array of strings (plain content separates tool rounds)
                    flushToolTurns();
                    googleContents.push({
                        parts: [{ text: item }],
                        role: "user",
                    });
                } else if (item && typeof item === "object") {
                    if (item.type === "additional_tools" || item.role === "system" || item.role === "developer") {
                        continue;
                    }
                    if (item.type === "code_interpreter_call") {
                        if (pendingFunctionResponseParts.length > 0) {
                            flushToolTurns();
                        }
                        // Replay executed code in the model turn alongside any function calls.
                        // Responses container/item IDs do not identify native Gemini executions.
                        if (typeof item.code === "string" && item.code) {
                            pendingModelParts.push({
                                executableCode: { code: item.code, language: "PYTHON" },
                            });
                        }
                        if (item.status === "completed" || item.status === "failed") {
                            const logs = Array.isArray(item.outputs)
                                ? item.outputs
                                      .filter(output => output?.type === "logs" && typeof output.logs === "string")
                                      .map(output => output.logs)
                                      .join("")
                                : "";
                            pendingModelParts.push({
                                codeExecutionResult: {
                                    outcome: item.status === "completed" ? "OUTCOME_OK" : "OUTCOME_FAILED",
                                    output: logs,
                                },
                            });
                        }
                        continue;
                    }
                    if (item.type === "reasoning") {
                        const summary = Array.isArray(item.summary)
                            ? item.summary
                                  .filter(
                                      part =>
                                          part?.type === "summary_text" &&
                                          typeof part.text === "string" &&
                                          part.text.length > 0
                                  )
                                  .map(part => part.text)
                                  .join("\n")
                            : "";
                        if (summary) {
                            if (pendingFunctionResponseParts.length > 0) {
                                flushToolTurns();
                            }
                            pendingModelParts.push({
                                text: `[Previous assistant reasoning summary]\n${summary}`,
                            });
                        }
                        continue;
                    }
                    // Handle different message types in Response API
                    if (item.type === "function_call" || item.type === "custom_tool_call") {
                        // Function call from model (assistant message with tool call).
                        // A tool round closes as soon as its outputs begin, so starting a new
                        // functionCall turn after pending responses flushes that round first.
                        if (pendingFunctionResponseParts.length > 0) {
                            flushToolTurns();
                        }
                        const rawArgs =
                            item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "arguments")
                                ? item["arguments"]
                                : undefined;
                        const functionCallPart = {
                            functionCall: {
                                args:
                                    item.type === "custom_tool_call"
                                        ? { input: item.input }
                                        : safeParseJSON(rawArgs, "unparsed_arguments"),
                                name: toGeminiFunctionName(item.name, item.namespace),
                            },
                        };
                        if (!pendingModelParts.some(part => part.functionCall)) {
                            functionCallPart.thoughtSignature = FormatConverter.DUMMY_THOUGHT_SIGNATURE;
                        }
                        if (typeof item.call_id === "string" && item.call_id) {
                            functionCallPart.functionCall.id = item.call_id;
                        }
                        pendingModelParts.push(functionCallPart);
                        this.logger.debug(
                            `[Adapter] Converted Response API function_call to Gemini functionCall: ${item.name}`
                        );
                    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
                        // Function output (tool result from user). Responses must live in the
                        // user turn directly following the model turn with the calls, so close
                        // the pending model turn first and keep accumulating outputs.
                        pendingModelParts.flush();
                        const responseMeta = functionResponseMetaByItem.get(item) || {
                            id: undefined,
                            name: "unknown_function",
                        };
                        const convertedOutput = await convertFunctionCallOutput(item.output);
                        const functionResponseBody = {
                            name: responseMeta.name,
                            ...convertedOutput,
                        };
                        if (responseMeta.id) {
                            functionResponseBody.id = responseMeta.id;
                        }
                        pendingFunctionResponseParts.push({
                            functionResponse: functionResponseBody,
                        });
                        this.logger.debug(
                            `[Adapter] Converted Response API function_call_output to Gemini functionResponse: ${responseMeta.name}`
                        );
                    } else {
                        // Regular assistant messages belong to the same model turn as
                        // adjacent calls. User messages end the pending tool round.
                        const googleParts = [];

                        if (typeof item.content === "string") {
                            googleParts.push({ text: item.content });
                        } else if (Array.isArray(item.content)) {
                            // Multi-modal content
                            for (const contentPart of item.content) {
                                if (
                                    contentPart.type === "text" ||
                                    contentPart.type === "input_text" ||
                                    contentPart.type === "output_text"
                                ) {
                                    googleParts.push({ text: serializeResponseTextPart(contentPart) });
                                } else if (contentPart.type === "image_url" || contentPart.type === "input_image") {
                                    const imageUrl = this.normalizeImageUrl(contentPart.image_url);
                                    if (!imageUrl) {
                                        this.logger.warn(
                                            "[Adapter] Skipping Response API image part because no string URL was provided."
                                        );
                                        googleParts.push({
                                            text: "[System Note: Skipped an image input because image_url was not a string URL]",
                                        });
                                        continue;
                                    }
                                    if (imageUrl.startsWith("data:")) {
                                        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                                        if (match) {
                                            googleParts.push({
                                                inlineData: {
                                                    data: match[2],
                                                    mimeType: match[1],
                                                },
                                            });
                                        }
                                    } else if (imageUrl.match(/^https?:\/\//)) {
                                        try {
                                            this.logger.info(`[Adapter] Downloading image from URL: ${imageUrl}`);
                                            const response = await axios.get(imageUrl, {
                                                responseType: "arraybuffer",
                                            });
                                            const imageBuffer = Buffer.from(response.data, "binary");
                                            const base64Data = imageBuffer.toString("base64");
                                            let mimeType = response.headers["content-type"];
                                            if (!mimeType || mimeType === "application/octet-stream") {
                                                mimeType = mime.lookup(imageUrl) || "image/jpeg";
                                            }
                                            googleParts.push({
                                                inlineData: {
                                                    data: base64Data,
                                                    mimeType,
                                                },
                                            });
                                        } catch (error) {
                                            this.logger.error(
                                                `[Adapter] Failed to download image from URL: ${imageUrl}`,
                                                error
                                            );
                                            googleParts.push({
                                                text: `[System Note: Failed to load image from ${imageUrl}]`,
                                            });
                                        }
                                    } else {
                                        this.logger.warn(
                                            `[Adapter] Skipping Response API image part because URL format is unsupported: ${imageUrl}`
                                        );
                                        googleParts.push({
                                            text: "[System Note: Skipped an image input because image_url format was unsupported]",
                                        });
                                    }
                                } else if (contentPart.type === "input_file") {
                                    this.logger.debug(
                                        "[Adapter] input_file content detected but not supported by Gemini, skipping..."
                                    );
                                }
                            }
                        }

                        if (googleParts.length > 0) {
                            if (item.role === "assistant") {
                                if (pendingFunctionResponseParts.length > 0) {
                                    flushToolTurns();
                                }
                                pendingModelParts.push(...googleParts);
                            } else {
                                flushToolTurns();
                                googleContents.push({
                                    parts: googleParts,
                                    role: "user",
                                });
                            }
                        }
                    }
                }
            }
            // Flush any tool turns still open at the end of the input array.
            flushToolTurns();
        }

        // Build Google request
        const googleRequest = {
            contents: googleContents,
            ...(systemInstruction && {
                systemInstruction,
            }),
        };

        // Generation config
        const generationConfig = {
            maxOutputTokens: responseBody.max_output_tokens,
            temperature: responseBody.temperature,
            topP: responseBody.top_p,
        };

        // Handle reasoning config (for o-series models)
        const reasoning = responseBody.reasoning;
        let thinkingConfig = null;

        if (reasoning) {
            thinkingConfig = { includeThoughts: true };
        }

        // Force thinking mode (only set includeThoughts=true when missing)
        if (
            this.serverSystem.config.forceThinking &&
            (!thinkingConfig || thinkingConfig.includeThoughts === undefined)
        ) {
            this.logger.info(
                "[Adapter] ⚠️ Force thinking enabled, setting includeThoughts=true for OpenAI Response API request."
            );
            thinkingConfig = { ...(thinkingConfig || {}), includeThoughts: true };
        }

        this._applyThinkingConfig(generationConfig, thinkingConfig, modelThinkingLevel);

        googleRequest.generationConfig = generationConfig;

        const responseHostedToolTypes = new Set([
            "code_interpreter",
            "computer_use_preview",
            "file_search",
            "web_search",
            "web_search_preview",
        ]);

        // Convert tools
        const tools = effectiveTools;
        if (tools && Array.isArray(tools) && tools.length > 0) {
            const functionDeclarations = responseFunctionTools.functionDeclarations;
            let hasCodeExecution = false;
            let hasWebSearch = false;

            for (const tool of tools) {
                if (tool.type === "web_search_preview" || tool.type === "web_search") {
                    hasWebSearch = true;
                    if (tool.type === "web_search" && tool.external_web_access === false) {
                        // Gemini cannot preserve OpenAI's cache-only mode. Keep search available as a
                        // compatibility fallback and make the live-search behavior explicit in logs.
                        this.logger.warn(
                            "[Adapter] OpenAI web_search requested external_web_access=false, but Gemini " +
                                "googleSearch has no cache-only mode; enabling live search for compatibility."
                        );
                    }
                } else if (tool.type === "code_interpreter") {
                    hasCodeExecution = true;
                } else if (tool.type === "file_search") {
                    this.logger.debug("[Adapter] file_search tool detected but not supported by Gemini, skipping...");
                } else if (tool.type === "computer_use_preview") {
                    this.logger.debug(
                        "[Adapter] computer_use_preview tool detected but not supported by Gemini, skipping..."
                    );
                }
            }

            // Build tools array
            if (functionDeclarations.length > 0) {
                googleRequest.tools = [{ functionDeclarations }];
                this.logger.info(
                    `[Adapter] Converted ${functionDeclarations.length} OpenAI Response API tool(s) to Gemini format`
                );
                if (responseFunctionTools.namespaceFunctionCount > 0) {
                    this.logger.debug(
                        `[Adapter] Flattened ${responseFunctionTools.namespaceFunctionCount} namespaced Responses API function(s) for Gemini and enabled reversible name mapping`
                    );
                }
            }

            if (hasWebSearch) {
                if (!googleRequest.tools) {
                    googleRequest.tools = [];
                }
                if (!FormatConverter.hasGeminiGoogleSearchTool(googleRequest.tools)) {
                    googleRequest.tools.push({ googleSearch: {} });
                    this.logger.info("[Adapter] Added googleSearch tool for OpenAI Response API web_search");
                }
            }

            if (hasCodeExecution) {
                if (!googleRequest.tools) {
                    googleRequest.tools = [];
                }
                if (!FormatConverter.hasGeminiCodeExecutionTool(googleRequest.tools)) {
                    googleRequest.tools.push({ codeExecution: {} });
                    this.logger.info("[Adapter] Added codeExecution tool for OpenAI Response API code execution");
                }
            }
        }

        // Handle tool_choice
        if (toolChoice) {
            const functionCallingConfig = {};

            const ensureGoogleSearchTool = () => {
                if (!googleRequest.tools) googleRequest.tools = [];
                if (!FormatConverter.hasGeminiGoogleSearchTool(googleRequest.tools)) {
                    googleRequest.tools.push({ googleSearch: {} });
                }
            };

            const ensureCodeExecutionTool = () => {
                if (!googleRequest.tools) googleRequest.tools = [];
                if (!FormatConverter.hasGeminiCodeExecutionTool(googleRequest.tools)) {
                    googleRequest.tools.push({ codeExecution: {} });
                }
            };

            const hasFunctionDeclarations = () => this.hasGeminiFunctionDeclarations(googleRequest);

            // tool_choice can be a mode string ("none"|"auto"|"required"),
            // or an object selector (allowed_tools/custom/function/hosted tools).
            if (typeof toolChoice === "string") {
                if (toolChoice === "auto" && hasFunctionDeclarations()) {
                    functionCallingConfig.mode = "AUTO";
                } else if (toolChoice === "none" && hasFunctionDeclarations()) {
                    functionCallingConfig.mode = "NONE";
                } else if (toolChoice === "required" && hasFunctionDeclarations()) {
                    functionCallingConfig.mode = "ANY";
                } else if (toolChoice === "file_search" || toolChoice === "computer_use_preview") {
                    this.logger.debug(
                        `[Adapter] tool_choice forces unsupported hosted tool (${toolChoice}); ignoring.`
                    );
                } else {
                    this.logger.debug(
                        `[Adapter] Unsupported tool_choice for Responses API, ignoring: ${JSON.stringify(toolChoice)}`
                    );
                }
            } else if (typeof toolChoice === "object") {
                if (toolChoice.type === "allowed_tools") {
                    // Constrain available tools. effectiveTools contains the full definitions selected above.
                    // Gemini functionCallingConfig only applies to function declarations, not hosted/built-in tools.
                    const allowedToolsHaveHostedTool =
                        Array.isArray(tools) && tools.some(t => t && responseHostedToolTypes.has(t.type));
                    if (hasFunctionDeclarations() && !allowedToolsHaveHostedTool) {
                        if (toolChoice.mode === "auto") {
                            // Gemini only accepts allowedFunctionNames with ANY or VALIDATED.
                            // VALIDATED still permits both natural language and tool calls.
                            functionCallingConfig.mode = "VALIDATED";
                        } else if (toolChoice.mode === "required") {
                            functionCallingConfig.mode = "ANY";
                        }

                        const names = responseFunctionTools.functionDeclarations.map(declaration => declaration.name);
                        if (names.length > 0) {
                            functionCallingConfig.allowedFunctionNames = names;
                        }
                    }
                } else if (toolChoice.type === "custom") {
                    // Force a specific custom tool; map to Gemini "ANY" with allowed function name.
                    if (typeof toolChoice.name === "string" && toolChoice.name) {
                        functionCallingConfig.mode = "ANY";
                        const geminiName = toGeminiFunctionName(toolChoice.name, toolChoice.namespace);
                        if (
                            !responseFunctionTools.functionDeclarations.some(
                                declaration => declaration.name === geminiName
                            ) ||
                            responseFunctionTools.functionNameMap[geminiName]?.type !== "custom"
                        ) {
                            throw new Error(
                                `Custom tool_choice refers to an undeclared custom tool: ${toolChoice.name}`
                            );
                        }
                        functionCallingConfig.allowedFunctionNames = [geminiName];
                    }
                } else if (toolChoice.type === "function") {
                    // Back-compat with Chat Completions style: { type:"function", name:"..." }
                    const funcName = toolChoice.name;
                    if (typeof funcName === "string" && funcName) {
                        functionCallingConfig.mode = "ANY";
                        functionCallingConfig.allowedFunctionNames = [
                            toGeminiFunctionName(funcName, toolChoice.namespace),
                        ];
                    }
                } else if (toolChoice.type === "web_search_preview" || toolChoice.type === "web_search") {
                    ensureGoogleSearchTool();
                } else if (toolChoice.type === "code_interpreter") {
                    ensureCodeExecutionTool();
                } else if (toolChoice.type === "file_search" || toolChoice.type === "computer_use_preview") {
                    this.logger.debug(
                        `[Adapter] tool_choice forces unsupported hosted tool (${toolChoice.type}); ignoring.`
                    );
                } else {
                    this.logger.debug(
                        `[Adapter] Unsupported tool_choice for Responses API, ignoring: ${JSON.stringify(toolChoice)}`
                    );
                }
            }

            if (Object.keys(functionCallingConfig).length > 0) {
                googleRequest.toolConfig = { functionCallingConfig };
                this.logger.debug(
                    `[Adapter] Converted tool_choice to Gemini toolConfig: ${JSON.stringify(functionCallingConfig)}`
                );
            }
        }

        // Handle text format (structured output)
        const textFormat = responseBody.text;
        if (textFormat && textFormat.format) {
            const formatType =
                typeof textFormat.format === "string" ? textFormat.format : textFormat.format?.type || null;

            if (formatType === "json_schema" && typeof textFormat.format === "object") {
                // Follow the official Response API shape:
                // text.format = { type: "json_schema", name, schema, strict }
                const jsonSchemaConfig = textFormat.format;
                const schema = jsonSchemaConfig.schema;
                if (schema !== undefined && schema !== null) {
                    generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema } };
                    this.logger.info(
                        `[Adapter] Forwarded OpenAI Response API text.format as Gemini responseFormat.text.schema: ${jsonSchemaConfig.name || "unnamed"}`
                    );
                }
            } else if (formatType === "json_object") {
                generationConfig.responseFormat = {
                    text: { mimeType: "APPLICATION_JSON", schema: { additionalProperties: true, type: "object" } },
                };
                this.logger.info(
                    "[Adapter] Set responseFormat.text.mimeType to APPLICATION_JSON for OpenAI Response API json_object format"
                );
            }
        }

        this._applyTrailingUserTurnGuard(googleRequest, cleanModelName);
        this._finalizeGoogleRequest(googleRequest, {
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
        });
        this.logger.info("[Adapter] OpenAI Response API to Google translation complete.");
        return {
            cleanModelName,
            googleRequest,
            modelStreamingMode,
            responseFunctionNameMap: responseFunctionTools.functionNameMap,
        };
    }
}

module.exports = ResponsesRequestConverter;
