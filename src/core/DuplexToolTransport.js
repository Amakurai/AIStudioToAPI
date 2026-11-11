const AntiTruncation = require("./AntiTruncation");

/** Single-call output wrapper. The legacy module path is retained for existing imports. */
class DuplexToolTransport {
    static prepare(body) {
        const request = AntiTruncation.normalizeRequest(body);
        AntiTruncation.validateRequest(request);
        // Native text requests may omit role; preserve their default user semantics.
        for (const turn of request.contents) {
            if (turn.role === undefined || turn.role === "function" || turn.role === "tool") turn.role = "user";
            // Client tools use the original model; earlier tool calls and results stay in the
            // conversation as plain text instead of rejecting the whole request.
            if (Array.isArray(turn.parts)) turn.parts = turn.parts.map(part => this.toolPartAsText(part));
            // Earlier reasoning (for example Claude thinking blocks) is not answer history. Drop it
            // instead of rejecting multi-turn conversations from clients that echo it back.
            if (turn.role === "model") turn.parts = turn.parts.filter(part => part.thought !== true);
        }
        request.contents = request.contents.filter(turn => turn.parts.length);
        if (
            !request.contents.length ||
            request.contents.some(
                turn =>
                    !["user", "model"].includes(turn.role) ||
                    turn.parts.some(
                        part =>
                            typeof part.text !== "string" ||
                            Object.keys(part).some(key => key !== "text" && key !== "thoughtSignature")
                    )
            )
        ) {
            throw AntiTruncation.invalidRequest("tool output requires text-only conversation history.");
        }
        // Keep the preset's system instruction and reply format intact. Only the output method changes.
        const hint = { text: "本轮请通过 output_content 工具提交完整回复，保持上述内容和格式要求。" };
        if (request.contents.at(-1).role === "user") request.contents.at(-1).parts.push(hint);
        else request.contents.push({ parts: [hint], role: "user" });
        request.tools = [{ functionDeclarations: this.declarations() }];
        request.toolConfig = {
            functionCallingConfig: { allowedFunctionNames: ["output_content"], mode: "ANY" },
        };
        request.generationConfig.candidateCount = 1;
        delete request.generationConfig.responseMimeType;
        return { request };
    }

    static declarations() {
        return [
            {
                description: "将本轮完整回复写入 content，保持当前对话要求的内容、格式和顺序。",
                name: "output_content",
                parameters: {
                    properties: { content: { type: "STRING" } },
                    required: ["content"],
                    type: "OBJECT",
                },
            },
        ];
    }

    /**
     * A function call becomes its argument text (string arguments joined, otherwise JSON); a
     * function result becomes its JSON response. Other parts are returned unchanged.
     */
    static toolPartAsText(part) {
        if (!part || typeof part !== "object" || Array.isArray(part)) return part;
        if (part.functionCall) {
            const args = part.functionCall.args;
            const values = args && typeof args === "object" && !Array.isArray(args) ? Object.values(args) : [];
            const text =
                values.length && values.every(value => typeof value === "string")
                    ? values.join("\n\n")
                    : JSON.stringify(args ?? {});
            return { text };
        }
        if (part.functionResponse) return { text: JSON.stringify(part.functionResponse.response ?? {}) };
        return part;
    }

    /** Summary of a rejected round for logs: finish reason, part kinds and token usage. */
    static describe(response) {
        const candidate = response?.candidates?.[0];
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const kinds = parts.map(part =>
            part?.functionCall
                ? `call:${part.functionCall.name}`
                : typeof part?.text === "string"
                  ? `${part.thought ? "thought" : "text"}:${part.text.length}`
                  : Object.keys(part || {}).join("+") || "empty"
        );
        const usage = response?.usageMetadata || {};
        return (
            `finishReason=${candidate?.finishReason ?? "none"}, parts=[${kinds.join(", ")}], ` +
            `outputTokens=${usage.candidatesTokenCount ?? "?"}, thoughtTokens=${usage.thoughtsTokenCount ?? "?"}`
        );
    }

    /** One generation only: unwrap the complete tool argument or accept a direct text reply. */
    static async generate(body, send) {
        const { request } = this.prepare(body);
        // A stop string applies to the reply, not to the JSON envelope carrying it.
        const stops = request.generationConfig.stopSequences;
        delete request.generationConfig.stopSequences;
        const response = await send(request);
        if (!response || typeof response !== "object" || Array.isArray(response))
            throw AntiTruncation.protocolError("invalid upstream response.");
        if (response.error)
            throw Object.assign(new Error(response.error.message || "Upstream generation failed"), {
                status: Number(response.error.code) || 502,
            });
        const candidate = response.candidates?.[0];
        const blocked =
            response.promptFeedback?.blockReason && response.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED";
        if (blocked || AntiTruncation.BLOCKED_FINISH_REASONS.includes(candidate?.finishReason)) {
            return {
                ...response,
                candidates: [
                    {
                        ...candidate,
                        content: { parts: [{ text: "" }], role: "model" },
                        finishReason: blocked ? "SAFETY" : candidate.finishReason,
                        index: 0,
                    },
                ],
            };
        }
        const reject = issue => {
            throw AntiTruncation.protocolError(`${issue} (${this.describe(response)}).`);
        };
        if (
            !Array.isArray(response.candidates) ||
            response.candidates.length !== 1 ||
            !["STOP", "MAX_TOKENS"].includes(candidate?.finishReason)
        )
            reject("invalid generation result");
        const parts = candidate.content?.parts;
        if (!Array.isArray(parts) || parts.some(part => !part || typeof part !== "object" || Array.isArray(part)))
            reject("invalid response parts");
        const calls = parts.filter(part => part.functionCall);
        let text;
        if (calls.length) {
            const call = calls[0].functionCall;
            const args = call.args;
            if (
                calls.length !== 1 ||
                call.name !== "output_content" ||
                !args ||
                typeof args !== "object" ||
                Array.isArray(args) ||
                typeof args.content !== "string"
            )
                reject("invalid output_content arguments");
            text = args.content;
        } else {
            if (parts.some(part => typeof part.text !== "string")) reject("unsupported response part");
            text = parts
                .filter(part => part.thought !== true)
                .map(part => part.text)
                .join("");
        }
        if (!text.trim()) reject("the model produced no output");
        let finishReason = candidate.finishReason;
        const matches = stops.map(stop => text.indexOf(stop)).filter(index => index >= 0);
        if (matches.length) {
            text = text.slice(0, Math.min(...matches));
            finishReason = "STOP";
        }
        return {
            ...response,
            candidates: [
                {
                    ...candidate,
                    content: {
                        parts: [
                            ...parts.filter(part => part.thought === true && typeof part.text === "string"),
                            { text },
                        ],
                        role: "model",
                    },
                    finishReason,
                },
            ],
        };
    }
}

module.exports = DuplexToolTransport;
