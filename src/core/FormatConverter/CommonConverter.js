/**
 * File: src/core/FormatConverter/CommonConverter.js
 * Description: Shared converter context, model suffixes, Gemini tools/schemas, media loading, and usage parsing.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const AntiTruncation = require("../AntiTruncation");

const axios = require("axios");
const mime = require("mime-types");

class FormatConverter {
    static CLAUDE_CODE_EXECUTION_TOOL_TYPES = new Set([
        "code_execution_20250825",
        "code_execution_20260120",
        "code_execution_20260521",
    ]);

    // Placeholder signature for Gemini 3 functionCall validation
    static DUMMY_THOUGHT_SIGNATURE = "context_engineering_is_the_way_to_go";
    static GEMINI_BUILT_IN_TOOL_KEYS = [
        "codeExecution",
        "code_execution",
        "googleMaps",
        "google_maps",
        "googleSearch",
        "google_search",
        "googleSearchRetrieval",
        "google_search_retrieval",
        "urlContext",
        "url_context",
    ];

    // ThinkingLevel suffix mapping (lowercase -> uppercase API value)
    static THINKING_LEVEL_MAP = {
        high: "HIGH",
        low: "LOW",
        medium: "MEDIUM",
        minimal: "MINIMAL",
    };

    /**
     * Parse web search suffix from model name.
     * Only supports the LAST hyphen token: `-search` (case-insensitive).
     *
     * Examples:
     * - gemini-3-flash-preview-minimal-search -> { cleanModelName: "gemini-3-flash-preview-minimal", forceWebSearch: true }
     * - gemini-3-flash-preview-search-minimal -> no match (search suffix must be last)
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, forceWebSearch: boolean }}
     */
    static parseModelWebSearchSuffix(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, forceWebSearch: false };
        }

        const match = modelName.match(/^(.+)-search$/i);
        if (!match) {
            return { cleanModelName: modelName, forceWebSearch: false };
        }

        return { cleanModelName: match[1], forceWebSearch: true };
    }

    /**
     * Parse trailing built-in tool suffixes from model name.
     * Tool suffixes may be chained at the end of the model name, for example:
     * `gemini-3-flash-preview-minimal-search-code`.
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, forceWebSearch: boolean, forceCodeExecution: boolean }}
     */
    static parseModelBuiltInToolSuffixes(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return {
                cleanModelName: modelName,
                forceCodeExecution: false,
                forceWebSearch: false,
            };
        }

        let cleanModelName = modelName;
        let forceCodeExecution = false;
        let forceWebSearch = false;

        let match = cleanModelName.match(/^(.+)-(search|code)$/i);
        while (match) {
            cleanModelName = match[1];
            const suffix = match[2].toLowerCase();
            if (suffix === "code") {
                forceCodeExecution = true;
            } else {
                forceWebSearch = true;
            }
            match = cleanModelName.match(/^(.+)-(search|code)$/i);
        }

        return { cleanModelName, forceCodeExecution, forceWebSearch };
    }

    /**
     * Parse streaming mode suffix from model name.
     * Only matches a trailing `-real` or `-fake` (case-insensitive).
     * Callers should strip trailing built-in tool suffixes before invoking this helper, so the
     * combined suffix order remains: thinking -> streaming -> built-in tools.
     *
     * Examples:
     * - gemini-3-flash-preview-minimal-fake -> { cleanModelName: "gemini-3-flash-preview-minimal", streamingMode: "fake" }
     * - gemini-3-flash-preview(minimal)-fake -> { cleanModelName: "gemini-3-flash-preview(minimal)", streamingMode: "fake" }
     * - gemini-3-flash-preview-fake-minimal -> no match (thinking must come before streaming)
     * - gemini-3-flash-preview(minimal)-fake-search-code -> no direct match here; callers strip tool suffixes first
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, streamingMode: ("real"|"fake"|null) }}
     */
    static parseModelStreamingModeSuffix(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, streamingMode: null };
        }

        const match = modelName.match(/^(.+)-(real|fake)$/i);
        if (!match) {
            return { cleanModelName: modelName, streamingMode: null };
        }

        return { cleanModelName: match[1], streamingMode: match[2].toLowerCase() };
    }

    /**
     * Parse thinkingLevel suffix from model name
     * Supports two formats:
     *   - Parenthesis format: gemini-3-flash-preview(minimal), gemini-3-pro-preview(high)
     *   - Hyphen format: gemini-3-flash-preview-minimal, gemini-3-pro-preview-high
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, thinkingLevel: string|null }}
     *          - cleanModelName: Model name with suffix removed
     *          - thinkingLevel: Uppercase thinkingLevel value, or null if no suffix
     */
    static parseModelThinkingLevel(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, thinkingLevel: null };
        }

        const levels = Object.keys(FormatConverter.THINKING_LEVEL_MAP);

        // Check parenthesis format: model(level)
        const parenMatch = modelName.match(new RegExp(`^(.+)\\((${levels.join("|")})\\)$`, "i"));
        if (parenMatch) {
            const baseModel = parenMatch[1];
            const levelKey = parenMatch[2].toLowerCase();
            return {
                cleanModelName: baseModel,
                thinkingLevel: FormatConverter.THINKING_LEVEL_MAP[levelKey],
            };
        }

        // Check hyphen format: model-level
        const hyphenMatch = modelName.match(new RegExp(`^(.+)-(${levels.join("|")})$`, "i"));
        if (hyphenMatch) {
            const baseModel = hyphenMatch[1];
            const levelKey = hyphenMatch[2].toLowerCase();
            return {
                cleanModelName: baseModel,
                thinkingLevel: FormatConverter.THINKING_LEVEL_MAP[levelKey],
            };
        }

        // No matching suffix
        return { cleanModelName: modelName, thinkingLevel: null };
    }

    /**
     * Parse all supported model-name suffixes in their required stripping order
     * and log any detected overrides.
     *
     * @param {string} modelName - Original model name
     * @param {{ logPrefix?: string, modelSource?: string }} [options] - Log message context
     * @returns {{
     *   cleanModelName: string,
     *   forceCodeExecution: boolean,
     *   forceWebSearch: boolean,
     *   streamingMode: ("real"|"fake"|null),
     *   thinkingLevel: string|null
     * }} Parsed model name and overrides
     */
    parseModelSuffixes(modelName, { logPrefix = "[Adapter]", modelSource = "model name" } = {}) {
        const {
            cleanModelName: toolStrippedModel,
            forceCodeExecution,
            forceWebSearch,
        } = FormatConverter.parseModelBuiltInToolSuffixes(modelName);
        const { cleanModelName: streamStrippedModel, streamingMode } =
            FormatConverter.parseModelStreamingModeSuffix(toolStrippedModel);
        const { cleanModelName, thinkingLevel } = FormatConverter.parseModelThinkingLevel(streamStrippedModel);

        const forceToolFlags = [];
        if (forceWebSearch) forceToolFlags.push("forceWebSearch=true");
        if (forceCodeExecution) forceToolFlags.push("forceCodeExecution=true");
        if (forceToolFlags.length > 0) {
            this.logger.info(
                `${logPrefix} Detected built-in tool suffixes in ${modelSource}: "${modelName}" -> model="${toolStrippedModel}", ${forceToolFlags.join(", ")}`
            );
        }
        if (streamingMode) {
            this.logger.info(
                `${logPrefix} Detected streamingMode suffix in ${modelSource}: "${toolStrippedModel}" -> model="${streamStrippedModel}", streamingMode="${streamingMode}"`
            );
        }
        if (thinkingLevel) {
            this.logger.info(
                `${logPrefix} Detected thinkingLevel suffix in ${modelSource}: "${streamStrippedModel}" -> model="${cleanModelName}", thinkingLevel="${thinkingLevel}"`
            );
        }

        return {
            cleanModelName,
            forceCodeExecution,
            forceWebSearch,
            streamingMode,
            thinkingLevel,
        };
    }

    constructor(logger, serverSystem) {
        this.logger = logger;
        this.serverSystem = serverSystem;
    }

    /**
     * Accumulate Gemini content parts for one role and append them as a single
     * content turn when flushed.
     *
     * @param {Array<object>} contents - Target Gemini contents array
     * @param {"model"|"user"} role - Role assigned to flushed content
     * @returns {{
     *   readonly length: number,
     *   flush: () => void,
     *   push: (...parts: object[]) => number,
     *   some: (predicate: (part: object) => boolean) => boolean
     * }} Mutable content-parts buffer
     * @protected
     */
    _createGoogleContentPartsBuffer(contents, role) {
        let parts = [];
        return {
            flush() {
                if (parts.length === 0) return;
                contents.push({ parts, role });
                parts = [];
            },
            get length() {
                return parts.length;
            },
            push(...newParts) {
                return parts.push(...newParts);
            },
            some(predicate) {
                return parts.some(predicate);
            },
        };
    }

    /**
     * Apply the model-name thinking level override and attach the resulting
     * thinking config to a Gemini generation config.
     *
     * @param {object} generationConfig - Gemini generation config
     * @param {object|null} thinkingConfig - Previously resolved thinking config
     * @param {string|null} modelThinkingLevel - Model suffix override
     * @protected
     */
    _applyThinkingConfig(generationConfig, thinkingConfig, modelThinkingLevel) {
        if (modelThinkingLevel) {
            if (!thinkingConfig) thinkingConfig = {};
            thinkingConfig.thinkingLevel = modelThinkingLevel;
        }

        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    }

    getDefaultSafetySettings() {
        const threshold = this.serverSystem.config.safetySettingsThreshold || "OFF";
        return [
            { category: "HARM_CATEGORY_HARASSMENT", threshold },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold },
        ];
    }

    normalizeImageUrl(imageSource) {
        if (typeof imageSource === "string") {
            return imageSource;
        }

        if (imageSource && typeof imageSource.url === "string") {
            return imageSource.url;
        }

        return null;
    }

    _getGeminiPromptBlockMessage(promptFeedback) {
        const reason = promptFeedback?.blockReason;
        if (typeof reason !== "string" || !reason || reason === "BLOCK_REASON_UNSPECIFIED") return null;
        const detail = promptFeedback.blockReasonMessage;
        return `Gemini blocked the request (${reason}).${typeof detail === "string" && detail ? ` ${detail}` : ""}`;
    }

    // Shared media loading for Responses outputs and Claude images/documents.
    async _loadFunctionResponseMedia(contentPart, itemIndex, { functionResponse = true } = {}) {
        const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]);
        const isImage = contentPart?.type === "input_image" || contentPart?.type === "image";
        const claudeSource = ["image", "document"].includes(contentPart?.type) ? contentPart.source : null;
        const source = claudeSource
            ? claudeSource.url
            : isImage
              ? this.normalizeImageUrl(contentPart.image_url)
              : contentPart?.file_data || contentPart?.file_url;

        let data;
        let mimeType;
        if (claudeSource?.type === "base64" || claudeSource?.type === "text") {
            if (typeof claudeSource.data !== "string" || !claudeSource.data) {
                this.logger.warn("[Adapter] Skipping Claude media with no data.");
                return null;
            }
            data =
                claudeSource.type === "text"
                    ? Buffer.from(claudeSource.data, "utf8").toString("base64")
                    : claudeSource.data;
            mimeType = claudeSource.media_type;
        } else if (typeof source !== "string" || !source) {
            this.logger.warn(
                `[Adapter] Skipping ${contentPart?.type || "unknown"} media because it has no supported data source.`
            );
            return null;
        } else if (source.startsWith("data:")) {
            const match = source.match(/^data:([^;,]+);base64,(.+)$/s);
            if (!match) {
                this.logger.warn("[Adapter] Skipping malformed media data URL.");
                return null;
            }
            [, mimeType, data] = match;
        } else if (/^https?:\/\//.test(source)) {
            try {
                const response = await axios.get(source, { responseType: "arraybuffer" });
                data = Buffer.from(response.data, "binary").toString("base64");
                mimeType = response.headers["content-type"]?.split(";", 1)[0];
                if (!mimeType || mimeType === "application/octet-stream") {
                    mimeType = mime.lookup(contentPart.filename || source) || undefined;
                }
            } catch (error) {
                this.logger.warn(`[Adapter] Failed to download media from ${source}: ${error.message}`);
                return null;
            }
        } else if (!claudeSource && !isImage && contentPart.file_data) {
            data = contentPart.file_data;
            mimeType = mime.lookup(contentPart.filename || "") || "application/octet-stream";
        } else {
            this.logger.warn("[Adapter] Skipping unsupported media URL.");
            return null;
        }

        if (!data) {
            this.logger.warn("[Adapter] Skipping empty media data.");
            return null;
        }
        if (!mimeType || (functionResponse && !supportedMimeTypes.has(mimeType))) {
            this.logger.warn(`[Adapter] Skipping media with unsupported MIME type: ${mimeType || "unknown"}`);
            return null;
        }

        const extension = mime.extension(mimeType);
        // Reference names are unique by output position; callers preserve original filenames/metadata.
        const displayName = `function-output-${itemIndex + 1}${extension ? `.${extension}` : ""}`;
        return { displayName, part: { inlineData: { data, displayName, mimeType } } };
    }

    /**
     * Ensure thoughtSignature is present in Gemini native format requests
     * This handles direct Gemini API calls where functionCall may lack thoughtSignature
     * Note: Only functionCall needs thoughtSignature, functionResponse does NOT need it
     * @param {object} geminiBody - Gemini API request body
     * @returns {object} - Modified request body with thoughtSignature placeholders
     */
    ensureThoughtSignature(geminiBody) {
        if (!geminiBody || !geminiBody.contents || !Array.isArray(geminiBody.contents)) {
            return geminiBody;
        }

        const DUMMY_SIGNATURE = FormatConverter.DUMMY_THOUGHT_SIGNATURE;

        for (const content of geminiBody.contents) {
            if (!content.parts || !Array.isArray(content.parts)) continue;

            // Only add signature to functionCall, not functionResponse
            let signatureAdded = false;
            for (const part of content.parts) {
                // Check for functionCall without thoughtSignature
                if (part.functionCall && !part.thoughtSignature) {
                    if (!signatureAdded) {
                        part.thoughtSignature = DUMMY_SIGNATURE;
                        signatureAdded = true;
                        this.logger.debug(
                            `[Adapter] Added dummy thoughtSignature for functionCall: ${part.functionCall.name}`
                        );
                    }
                }
                // Note: functionResponse does NOT need thoughtSignature per official docs
            }
        }

        return geminiBody;
    }

    hasGeminiBuiltInTools(geminiBody) {
        return !!(
            geminiBody &&
            Array.isArray(geminiBody.tools) &&
            geminiBody.tools.some(
                tool =>
                    tool &&
                    typeof tool === "object" &&
                    FormatConverter.GEMINI_BUILT_IN_TOOL_KEYS.some(toolKey =>
                        Object.prototype.hasOwnProperty.call(tool, toolKey)
                    )
            )
        );
    }

    static hasGeminiToolKey(tool, keys) {
        return !!(
            tool &&
            typeof tool === "object" &&
            keys.some(toolKey => Object.prototype.hasOwnProperty.call(tool, toolKey))
        );
    }

    static hasGeminiGoogleSearchTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["googleSearch", "google_search"]))
        );
    }

    static hasGeminiUrlContextTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["urlContext", "url_context"]))
        );
    }

    static hasGeminiCodeExecutionTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["codeExecution", "code_execution"]))
        );
    }

    hasGeminiFunctionDeclarations(geminiBody) {
        return !!(
            geminiBody &&
            Array.isArray(geminiBody.tools) &&
            geminiBody.tools.some(
                tool =>
                    tool &&
                    typeof tool === "object" &&
                    ((Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) ||
                        (Array.isArray(tool.function_declarations) && tool.function_declarations.length > 0))
            )
        );
    }

    ensureServerSideToolInvocations(geminiBody) {
        const hasMixedTools = this.hasGeminiBuiltInTools(geminiBody) && this.hasGeminiFunctionDeclarations(geminiBody);
        if (!hasMixedTools && geminiBody?.toolConfig?.includeServerSideToolInvocations !== true) {
            return geminiBody;
        }

        if (
            !geminiBody.toolConfig ||
            typeof geminiBody.toolConfig !== "object" ||
            Array.isArray(geminiBody.toolConfig)
        ) {
            geminiBody.toolConfig = {};
        }

        if (geminiBody.toolConfig.includeServerSideToolInvocations !== true) {
            geminiBody.toolConfig.includeServerSideToolInvocations = true;
        }

        // Tool context circulation does not support AUTO. VALIDATED still allows
        // both natural language and tool calls; keep explicit NONE/ANY unchanged.
        const functionCallingConfig = geminiBody.toolConfig.functionCallingConfig;
        if (functionCallingConfig?.mode === "AUTO") {
            functionCallingConfig.mode = "VALIDATED";
        }

        return geminiBody;
    }

    /**
     * Copy a legacy Google Schema and normalize only schema-node Type enums.
     * Instance values (default/example/enum) and JSON Schema extensions remain untouched.
     */
    _normalizeGeminiSchemaTypes(schema) {
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
            return schema;
        }

        const normalized = { ...schema };
        if (typeof schema.type === "string") {
            normalized.type = schema.type.toUpperCase();
        }

        // Schema.properties is a map of names to schemas, not a schema itself.
        if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
            normalized.properties = Object.fromEntries(
                Object.entries(schema.properties).map(([name, child]) => [
                    name,
                    this._normalizeGeminiSchemaTypes(child),
                ])
            );
        }
        if (schema.items) {
            normalized.items = this._normalizeGeminiSchemaTypes(schema.items);
        }
        for (const key of ["anyOf", "any_of"]) {
            if (Array.isArray(schema[key])) {
                normalized[key] = schema[key].map(child => this._normalizeGeminiSchemaTypes(child));
            }
        }

        return normalized;
    }

    /**
     * Normalize legacy parameter and response schemas in native Gemini tool declarations.
     * @param {object} geminiBody - Gemini format request body
     * @returns {object} - Modified request body with normalized tool schema types
     */
    sanitizeGeminiTools(geminiBody) {
        if (!geminiBody || !geminiBody.tools || !Array.isArray(geminiBody.tools)) {
            return geminiBody;
        }

        // Process each tool
        for (const tool of geminiBody.tools) {
            const declarations =
                Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
                    ? tool.functionDeclarations
                    : tool.function_declarations;
            if (declarations && Array.isArray(declarations)) {
                for (const funcDecl of declarations) {
                    if (!funcDecl || typeof funcDecl !== "object") continue;
                    for (const key of ["parameters", "response"]) {
                        if (funcDecl[key]) {
                            funcDecl[key] = this._normalizeGeminiSchemaTypes(funcDecl[key]);
                        }
                    }
                }
            }
        }

        return geminiBody;
    }

    /**
     * Normalize type values in a native Gemini responseSchema to Google's Type enum values.
     * @param {object} geminiBody - Gemini format request body
     * @returns {object} - Modified request body with normalized responseSchema types
     */
    normalizeGeminiResponseSchema(geminiBody) {
        const responseSchema = geminiBody?.generationConfig?.responseSchema;
        if (!responseSchema || typeof responseSchema !== "object") {
            return geminiBody;
        }

        geminiBody.generationConfig.responseSchema = this._normalizeGeminiSchemaTypes(responseSchema);
        return geminiBody;
    }

    /**
     * Common final processing for Gemini requests:
     * 1. Inject force features (Search, URL Context)
     * 2. Apply safety settings
     * 3. Log final request body
     * @param {object} googleRequest - The Gemini request object to finalize
     * @param {object} [options={}] - Per-request tool injection overrides.
     * @param {boolean} [options.forceCodeExecution] - When truthy, force-enable `codeExecution` for this request
     * even if `config.forceCodeExecution` is disabled.
     * @param {boolean} [options.forceWebSearch] - When truthy, force-enable `googleSearch` for this request even
     * if `config.forceWebSearch` is disabled. Falsy values fall back to the global setting. Current callers
     * use this for model-name-driven overrides such as the `-search` suffix.
     * @param {boolean} [options.forceUrlContext] - When truthy, force-enable `urlContext` for this request even if
     * `config.forceUrlContext` is disabled. Falsy values fall back to the global setting.
     * @protected
     */
    _finalizeGoogleRequest(googleRequest, options = {}) {
        const forceCodeExecution = options.forceCodeExecution || this.serverSystem.config.forceCodeExecution;
        const forceWebSearch = options.forceWebSearch || this.serverSystem.config.forceWebSearch;
        const forceUrlContext = options.forceUrlContext || this.serverSystem.config.forceUrlContext;

        // Force built-in tools
        if (forceWebSearch || forceUrlContext || forceCodeExecution) {
            if (!googleRequest.tools) {
                googleRequest.tools = [];
            }

            const toolsToAdd = [];

            // Handle Google Search
            if (forceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(googleRequest.tools);
                if (!hasSearch) {
                    googleRequest.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                }
            }

            // Handle URL Context
            if (forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(googleRequest.tools);
                if (!hasUrlContext) {
                    googleRequest.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                }
            }

            // Handle Code Execution
            if (forceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(googleRequest.tools);
                if (!hasCodeExecution) {
                    googleRequest.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(`[Adapter] ⚠️ Force features enabled, injecting tools: [${toolsToAdd.join(", ")}]`);
            }
        }

        this.ensureServerSideToolInvocations(googleRequest);

        // Safety settings
        googleRequest.safetySettings = this.getDefaultSafetySettings();

        this.logger.debug(`[Adapter] Debug: Final Gemini Request = ${JSON.stringify(googleRequest, null, 2)}`);
    }

    /**
     * Map Gemini finishReason to OpenAI format
     * @param {string} geminiReason - Gemini finish reason
     * @returns {string} - OpenAI finish reason
     */
    _mapFinishReason(geminiReason, modelName = null) {
        if (AntiTruncation.baseModel(modelName) && AntiTruncation.BLOCKED_FINISH_REASONS.includes(geminiReason)) {
            return "content_filter";
        }
        const reasonMap = {
            max_tokens: "length",
            other: "stop",
            recitation: "stop",
            safety: "content_filter",
            stop: "stop",
        };
        return reasonMap[(geminiReason || "stop").toLowerCase()] || "stop";
    }

    _generateRequestId() {
        return `${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    }

    _normalizeWebSearchQueries(value) {
        const queries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        return [
            ...new Set(queries.filter(query => typeof query === "string" && query.trim()).map(query => query.trim())),
        ];
    }

    _extractUrlContextMetadataEntries(metadata) {
        const entries =
            metadata?.urlMetadata || metadata?.url_metadata || metadata?.urlsMetadata || metadata?.urls_metadata || [];
        return Array.isArray(entries) ? entries : [];
    }

    _utf8ByteOffsetToStringIndex(value, byteOffset) {
        const targetOffset = Number.isFinite(byteOffset) ? Math.max(0, byteOffset) : 0;
        let currentByteOffset = 0;
        let stringIndex = 0;

        for (const character of value) {
            const characterBytes = Buffer.byteLength(character, "utf8");
            if (currentByteOffset + characterBytes > targetOffset) break;
            currentByteOffset += characterBytes;
            stringIndex += character.length;
            if (currentByteOffset === targetOffset) break;
        }

        return stringIndex;
    }

    _parseUsage(googleResponse) {
        const usage = googleResponse.usageMetadata || {};

        const inputTokens = usage.promptTokenCount || 0;
        const toolPromptTokens = usage.toolUsePromptTokenCount || 0;
        let cachedTokens = Number.isFinite(usage.cachedContentTokenCount)
            ? Math.max(0, usage.cachedContentTokenCount)
            : 0;

        if (!Number.isFinite(usage.cachedContentTokenCount) && Array.isArray(usage.cacheTokensDetails)) {
            cachedTokens = usage.cacheTokensDetails.reduce(
                (sum, detail) => sum + (Number.isFinite(detail?.tokenCount) ? Math.max(0, detail.tokenCount) : 0),
                0
            );
        }

        const completionTextTokens = usage.candidatesTokenCount || 0;
        const reasoningTokens = usage.thoughtsTokenCount || 0;
        let completionImageTokens = 0;

        if (Array.isArray(usage.candidatesTokensDetails)) {
            for (const d of usage.candidatesTokensDetails) {
                if (d?.modality === "IMAGE") {
                    completionImageTokens += d.tokenCount || 0;
                }
            }
        }

        const promptTokens = inputTokens + toolPromptTokens;
        cachedTokens = Math.min(cachedTokens, promptTokens);
        const totalCompletionTokens = completionTextTokens + reasoningTokens;
        const totalTokens = googleResponse.usageMetadata?.totalTokenCount || 0;

        return {
            completion_tokens: totalCompletionTokens,
            completion_tokens_details: {
                image_tokens: completionImageTokens,
                output_text_tokens: completionTextTokens,
                reasoning_tokens: reasoningTokens,
            },
            prompt_tokens: promptTokens,
            prompt_tokens_details: {
                cached_tokens: cachedTokens,
                text_tokens: inputTokens,
                tool_tokens: toolPromptTokens,
            },
            total_tokens: totalTokens,
        };
    }
    _antiTruncationIncompleteReason(candidate, modelName) {
        if (!AntiTruncation.baseModel(modelName)) return null;
        if (candidate?.finishReason === "MAX_TOKENS") return "max_output_tokens";
        if (AntiTruncation.BLOCKED_FINISH_REASONS.includes(candidate?.finishReason)) return "content_filter";
        return null;
    }

    // Preserve Flash/Argon assistant-prefill compatibility by making the next user turn explicit.
    _applyTrailingUserTurnGuard(googleRequest, model) {
        if (!googleRequest || !Array.isArray(googleRequest.contents)) return;
        const modelLower = (AntiTruncation.baseModel(model) || String(model || "")).toLowerCase();
        if (!["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"].includes(modelLower))
            return;
        if (googleRequest.contents.length === 0) return;

        const last = googleRequest.contents[googleRequest.contents.length - 1];
        if (!last || typeof last !== "object") return;
        const role = String(last.role || "").toLowerCase();
        const parts = Array.isArray(last.parts) ? last.parts : [];
        const hasFunctionTurn = parts.some(part => part && (part.functionCall || part.functionResponse));
        if (role !== "user" || hasFunctionTurn) {
            googleRequest.contents.push({ parts: [{ text: "\n" }], role: "user" });
            this.logger.debug(`[Adapter] Added trailing user turn for ${model} compatibility.`);
        }
    }
}

module.exports = FormatConverter;
