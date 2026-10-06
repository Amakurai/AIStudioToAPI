const AntiTruncation = require("./AntiTruncation");

/** Request-local, experimental text transport. No shared input store or fabricated tool history. */
class DuplexToolTransport {
    static prepare(body) {
        const request = AntiTruncation.normalizeRequest(body);
        AntiTruncation.validateRequest(request);
        // Native text requests may omit role; preserve their default user semantics.
        for (const turn of request.contents) {
            if (turn.role === undefined) turn.role = "user";
        }
        if (
            request.contents.some(
                turn =>
                    !["user", "model"].includes(turn.role) ||
                    turn.parts.some(
                        part => typeof part.text !== "string" || Object.keys(part).some(key => key !== "text")
                    )
            )
        ) {
            throw AntiTruncation.invalidRequest("duplex mode requires text-only conversation history.");
        }
        const limit = AntiTruncation.textChunkLimit(request.generationConfig.maxOutputTokens);
        // Preserve native conversation roles; these Flash models require a final user turn.
        if (request.contents.at(-1).role !== "user") {
            request.contents.push({ parts: [{ text: "\n" }], role: "user" });
        }
        request.tools = [
            {
                functionDeclarations: [
                    {
                        description: "Deliver the next contiguous answer segment; mark the final segment done=true.",
                        name: "append_output",
                        parameters: {
                            properties: {
                                done: {
                                    description: "True only when this segment completes the entire requested answer.",
                                    type: "BOOLEAN",
                                },
                                seq: { type: "INTEGER" },
                                text: { type: "STRING" },
                            },
                            required: ["seq", "text"],
                            type: "OBJECT",
                        },
                    },
                    {
                        description:
                            "Confirm the whole requested answer has been delivered. Do not finish while text remains.",
                        name: "finish_output",
                        parameters: {
                            properties: { last_seq: { type: "INTEGER" } },
                            required: ["last_seq"],
                            type: "OBJECT",
                        },
                    },
                ],
            },
        ];
        request.toolConfig = {
            functionCallingConfig: { allowedFunctionNames: ["append_output", "finish_output"], mode: "ANY" },
        };
        request.systemInstruction = {
            ...(request.systemInstruction || {}),
            parts: [
                ...(request.systemInstruction?.parts || []),
                {
                    text:
                        "Answer the latest user request in the conversation above, following the system instructions. Use the text transport tools to deliver the answer. " +
                        "Call append_output(seq, text, done) with consecutive integer sequence numbers starting at 1. " +
                        "Call exactly one tool per turn and wait for its acknowledgement. Preserve every character, newline and requested format. " +
                        "Only output user-facing answer text, not private reasoning. Do not repeat acknowledged text. " +
                        `Keep each text segment within ${limit} characters, ending at a sentence or line boundary. ` +
                        "Set done=true on the final text segment only when the entire requested answer is complete; this also confirms completion without an extra tool call. Otherwise set done=false and continue after acknowledgement. " +
                        "If completion was not marked on the final segment, call finish_output(last_seq) using the last acknowledged sequence number (0 for an empty answer). Do not summarize to fit a segment.",
                },
            ],
        };
        request.generationConfig.candidateCount = 1;
        delete request.generationConfig.responseMimeType;
        return { request };
    }

    static async generate(body, send, onFollowup = () => {}, onSegment = () => {}) {
        const { request } = this.prepare(body);
        const stops = request.generationConfig.stopSequences;
        const stopOverlap = stops.reduce((longest, stop) => Math.max(longest, stop.length - 1), 0);
        delete request.generationConfig.stopSequences;
        const maxSegments =
            1 +
            (request.generationConfig.maxOutputTokens <= 8192
                ? AntiTruncation.MAX_SMALL_BUDGET_FOLLOWUPS
                : AntiTruncation.MAX_FOLLOWUPS);
        const maxCalls = maxSegments + 1 + AntiTruncation.MAX_TOOL_REPAIRS;
        const usage = {};
        const segments = [];
        let text = "",
            published = 0,
            outputSeq = 0,
            repairs = 0;
        let lastResponse = {},
            finishReason = "MAX_TOKENS";
        let limit = AntiTruncation.textChunkLimit(request.generationConfig.maxOutputTokens);
        const publish = final => {
            let end = text.length;
            if (!final) {
                for (const stop of stops) {
                    for (let size = Math.min(stop.length - 1, text.length); size > 0; size--) {
                        if (text.endsWith(stop.slice(0, size))) {
                            end = Math.min(end, text.length - size);
                            break;
                        }
                    }
                }
                // Do not encode half an emoji when a model splits a surrogate pair across calls.
                if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            }
            if (end > published) {
                onSegment({ seq: ++outputSeq, text: text.slice(published, end) });
                published = end;
            }
        };
        const repair = message => {
            if (repairs >= AntiTruncation.MAX_TOOL_REPAIRS) return false;
            repairs++;
            limit = Math.max(32, Math.floor(limit / 2));
            request.systemInstruction.parts.push({
                text: `Transport validation failed: ${message}. No part of that call was accepted. Retry the current step only, using at most ${limit} text characters. Next output sequence: ${segments.length + 1}.`,
            });
            return true;
        };
        for (let round = 0; round < maxCalls; round++) {
            if (round) onFollowup();
            const response = await send(request);
            if (!response || typeof response !== "object" || Array.isArray(response))
                throw AntiTruncation.protocolError("invalid duplex response.");
            if (response.error)
                throw Object.assign(new Error(response.error.message || "Upstream generation failed"), {
                    status: response.error.code,
                });
            lastResponse = response;
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
            const promptBlocked =
                response.promptFeedback?.blockReason &&
                response.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED";
            if (promptBlocked || AntiTruncation.BLOCKED_FINISH_REASONS.includes(candidate?.finishReason)) {
                finishReason = promptBlocked ? "SAFETY" : candidate.finishReason;
                break; // Preserve accepted text and report the block; never retry it as a transport failure.
            }
            const parts = candidate?.content?.parts;
            const validParts =
                Array.isArray(parts) && parts.every(part => part && typeof part === "object" && !Array.isArray(part));
            const calls = validParts ? parts.filter(part => part.functionCall) : [];
            const call = calls[0]?.functionCall;
            const args = call?.args;
            let issue;
            if (candidate?.finishReason === "MALFORMED_FUNCTION_CALL") issue = "malformed tool arguments";
            else if (
                !Array.isArray(response.candidates) ||
                response.candidates.length !== 1 ||
                !["STOP", "MAX_TOKENS"].includes(candidate?.finishReason)
            )
                issue = "missing or unfinished candidate";
            else if (calls.length !== 1 || !args || typeof args !== "object" || Array.isArray(args))
                issue = "expected one valid transport tool call";
            else if (call.name === "append_output") {
                if (
                    !Number.isSafeInteger(args.seq) ||
                    args.seq < 1 ||
                    typeof args.text !== "string" ||
                    !args.text.length ||
                    (args.done !== undefined && typeof args.done !== "boolean")
                )
                    issue = "invalid output sequence, text or completion flag";
                else if (
                    args.seq > segments.length + 1 ||
                    (args.seq <= segments.length && segments[args.seq - 1] !== args.text)
                )
                    issue = "out-of-order or conflicting output sequence";
                else if (args.seq <= segments.length && args.done === true)
                    issue = "completion must accompany a new segment or use finish_output";
            } else if (call.name === "finish_output") {
                if (
                    args.last_seq !== segments.length ||
                    !Number.isSafeInteger(args.last_seq) ||
                    candidate.finishReason !== "STOP"
                )
                    issue = "invalid completion acknowledgement";
            } else issue = "unexpected output transport tool";
            if (issue) {
                if (repair(issue)) continue;
                if (!text) throw AntiTruncation.protocolError(`duplex repair exhausted: ${issue}.`);
                break;
            }
            let acknowledgement;
            if (call.name === "finish_output") {
                finishReason = "STOP";
                break;
            } else {
                if (args.seq === segments.length + 1) {
                    if (segments.length >= maxSegments) break;
                    segments.push(args.text);
                    // Earlier text has already been checked. Only rescan the overlap where a stop can span segments.
                    const searchFrom = Math.max(0, text.length - stopOverlap);
                    text += args.text;
                    const matches = stops.map(stop => text.indexOf(stop, searchFrom)).filter(index => index >= 0);
                    if (matches.length) {
                        text = text.slice(0, Math.min(...matches));
                        finishReason = "STOP";
                        break;
                    }
                    publish(false);
                    // MAX_TOKENS is not a successful completion, even if the model emitted done=true.
                    if (args.done === true && candidate.finishReason === "STOP") {
                        finishReason = "STOP";
                        break;
                    }
                }
                acknowledgement = { next_seq: segments.length + 1, received: args.seq };
            }
            // Keep the actual model turn intact, including call IDs and thought signatures.
            request.contents.push(
                candidate.content,
                {
                    parts: [
                        {
                            functionResponse: {
                                name: call.name,
                                ...(call.id ? { id: call.id } : {}),
                                response: acknowledgement,
                            },
                        },
                    ],
                    role: "user",
                },
                { parts: [{ text: "Continue the current transport task using the next tool call." }], role: "user" }
            );
        }
        publish(true);
        return {
            ...lastResponse,
            candidates: [
                {
                    ...(lastResponse.candidates?.[0] || {}),
                    content: { parts: [{ text }], role: "model" },
                    finishReason,
                    index: 0,
                },
            ],
            usageMetadata: usage,
        };
    }
}

module.exports = DuplexToolTransport;
