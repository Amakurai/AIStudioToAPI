const AntiTruncation = require("./AntiTruncation");

/** Request-local, experimental text transport. No shared input store or fabricated tool history. */
class DuplexToolTransport {
    static prepare(body) {
        const request = AntiTruncation.normalizeRequest(body);
        AntiTruncation.validateRequest(request);
        // Native text requests may omit role; preserve their default user semantics.
        for (const turn of request.contents) {
            if (turn.role === undefined) turn.role = "user";
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
            throw AntiTruncation.invalidRequest("duplex mode requires text-only conversation history.");
        }
        const limit = AntiTruncation.textChunkLimit(
            request.generationConfig.maxOutputTokens,
            request.generationConfig.thinkingConfig?.thinkingBudget
        );
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

    /**
     * Runs the bounded segment protocol. `onFollowup(reason)` fires before every additional upstream
     * call ("continue" or "repair"), `onSegment` receives text that is safe to publish, and
     * `onDiagnostic` receives rejected calls and interruptions for logging.
     */
    static async generate(body, send, onFollowup = () => {}, onSegment = () => {}, onDiagnostic = () => {}) {
        const { request } = this.prepare(body);
        const stops = request.generationConfig.stopSequences;
        const stopOverlap = stops.reduce((longest, stop) => Math.max(longest, stop.length - 1), 0);
        delete request.generationConfig.stopSequences;
        const maxSegments = AntiTruncation.MAX_SEGMENTS;
        const maxCalls = maxSegments + 1 + AntiTruncation.MAX_TOOL_REPAIRS;
        const usage = {};
        const segments = [];
        let text = "",
            published = 0,
            outputSeq = 0,
            repairs = 0,
            nextReason = "continue";
        let lastResponse = {},
            finishReason = "MAX_TOKENS";
        let limit = AntiTruncation.textChunkLimit(
            request.generationConfig.maxOutputTokens,
            request.generationConfig.thinkingConfig?.thinkingBudget
        );
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
        const repair = issue => {
            if (repairs >= AntiTruncation.MAX_TOOL_REPAIRS) {
                onDiagnostic({ issue, segments: segments.length, type: "repair_exhausted" });
                return false;
            }
            repairs++;
            limit = Math.max(32, Math.floor(limit / 2));
            onDiagnostic({ issue, segments: segments.length, type: "repair" });
            request.systemInstruction.parts.push({
                text: `Transport validation failed: ${issue}. No part of that call was accepted. Retry the current step only, using at most ${limit} text characters. Next output sequence: ${segments.length + 1}.`,
            });
            return true;
        };
        for (let round = 0; round < maxCalls; round++) {
            if (round) onFollowup(nextReason);
            nextReason = "continue";
            let response;
            try {
                response = await send(request);
                if (!response || typeof response !== "object" || Array.isArray(response))
                    throw AntiTruncation.protocolError("invalid duplex response.");
                if (response.error)
                    throw Object.assign(new Error(response.error.message || "Upstream generation failed"), {
                        status: response.error.code,
                    });
            } catch (error) {
                // Before any accepted text, the caller may still retry the whole request. Afterwards,
                // keep the accepted prefix and report it as incomplete instead of discarding it.
                if (error?.cancelled || !segments.length) throw error;
                onDiagnostic({
                    message: error?.message,
                    segments: segments.length,
                    status: error?.status,
                    type: "interrupted",
                });
                break;
            }
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
                lastResponse = response;
                finishReason = promptBlocked ? "SAFETY" : candidate.finishReason;
                break; // Preserve accepted text and report the block; never retry it as a transport failure.
            }
            const parts = candidate?.content?.parts;
            const validParts =
                Array.isArray(parts) && parts.every(part => part && typeof part === "object" && !Array.isArray(part));
            const calls = validParts ? parts.filter(part => part.functionCall) : [];
            const call = calls[0]?.functionCall;
            const args = call?.args;
            const stopped = candidate?.finishReason === "STOP";
            let issue;
            // A completion signal without new text: an empty next segment, or the last accepted
            // segment repeated, marked done=true. Both mean the same as finish_output(last_seq).
            let completesWithoutText = false;
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
                const doneValid = args.done === undefined || typeof args.done === "boolean";
                completesWithoutText =
                    doneValid &&
                    args.done === true &&
                    stopped &&
                    typeof args.text === "string" &&
                    ((args.seq === segments.length + 1 && !args.text.length) ||
                        (args.seq === segments.length && segments.length > 0 && segments.at(-1) === args.text));
                if (completesWithoutText) issue = undefined;
                else if (
                    !Number.isSafeInteger(args.seq) ||
                    args.seq < 1 ||
                    typeof args.text !== "string" ||
                    !args.text.length ||
                    !doneValid
                )
                    issue = "invalid output sequence, text or completion flag";
                else if (
                    args.seq > segments.length + 1 ||
                    (args.seq <= segments.length && segments[args.seq - 1] !== args.text)
                )
                    issue = "out-of-order or conflicting output sequence";
                else if (args.seq <= segments.length && args.done === true)
                    issue = "completion may only follow the last accepted segment";
            } else if (call.name === "finish_output") {
                if (args.last_seq !== segments.length || !Number.isSafeInteger(args.last_seq) || !stopped)
                    issue = "invalid completion acknowledgement";
            } else issue = "unexpected output transport tool";
            if (issue) {
                if (repair(issue)) {
                    nextReason = "repair";
                    continue;
                }
                if (!text) throw AntiTruncation.protocolError(`duplex repair exhausted: ${issue}.`);
                break;
            }
            // Only accepted calls supply response metadata; rejected calls may carry private diagnostics.
            lastResponse = response;
            if (call.name === "finish_output" || completesWithoutText) {
                finishReason = "STOP";
                break;
            }
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
                if (args.done === true && stopped) {
                    finishReason = "STOP";
                    break;
                }
            }
            const acknowledgement = { next_seq: segments.length + 1, received: args.seq };
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
