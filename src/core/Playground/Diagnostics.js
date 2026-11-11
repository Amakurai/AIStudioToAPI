const crypto = require("crypto");

const pick = (obj, camel) => obj?.[camel] ?? obj?.[camel.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
const hash = value =>
    crypto
        .createHash("sha256")
        .update(JSON.stringify(value ?? null))
        .digest("hex");

/** Bounded comparison metadata only: never retain prompts, tool arguments or credentials. */
class PlaygroundDiagnostics {
    constructor(request) {
        const gc = pick(request, "generationConfig");
        const thinking = pick(gc, "thinkingConfig");
        const fc = pick(pick(request, "toolConfig"), "functionCallingConfig");
        const declarations = (request.tools || []).flatMap(tool => pick(tool, "functionDeclarations") || []);
        this.request = {
            contentsHash: hash(request.contents),
            functionCallingMode: fc?.mode || "AUTO",
            maxOutputTokens: pick(gc, "maxOutputTokens") ?? null,
            messageCount: request.contents?.length || 0,
            stopSequenceCount: pick(gc, "stopSequences")?.length || 0,
            stopSequencesHash: hash(pick(gc, "stopSequences") || []),
            systemInstructionHash: hash(pick(request, "systemInstruction")),
            thinkingBudget: pick(thinking, "thinkingBudget") ?? null,
            thinkingLevel: pick(thinking, "thinkingLevel") ?? null,
            toolCount: declarations.length,
            tools: declarations.slice(0, 128).map(tool => ({
                definitionHash: hash(tool),
                name: String(tool.name || "").slice(0, 128),
            })),
            toolsHash: hash({ toolConfig: pick(request, "toolConfig"), tools: request.tools }),
        };
        this.response = { candidates: [], usage: {} };
    }

    observe(chunk) {
        if (chunk.usageMetadata) Object.assign(this.response.usage, chunk.usageMetadata);
        if (chunk.promptFeedback?.blockReason) this.response.blockReason = chunk.promptFeedback.blockReason;
        for (const candidate of chunk.candidates || []) {
            const index = candidate.index ?? 0;
            let summary = this.response.candidates.find(item => item.index === index);
            if (!summary) {
                summary = { functionCallCount: 0, functionNames: [], index, textChars: 0, thoughtChars: 0 };
                this.response.candidates.push(summary);
            }
            if (candidate.finishReason) summary.finishReason = candidate.finishReason;
            for (const part of candidate.content?.parts || []) {
                if (typeof part.text === "string")
                    summary[part.thought ? "thoughtChars" : "textChars"] += part.text.length;
                if (part.functionCall) {
                    summary.functionCallCount++;
                    const name = String(part.functionCall.name || "").slice(0, 128);
                    if (summary.functionNames.length < 128 && !summary.functionNames.includes(name))
                        summary.functionNames.push(name);
                }
            }
        }
    }

    snapshot() {
        return JSON.parse(JSON.stringify({ request: this.request, response: this.response }));
    }
}

module.exports = PlaygroundDiagnostics;
