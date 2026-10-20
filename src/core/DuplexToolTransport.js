const AntiTruncation = require("./AntiTruncation");

/** Request-local, experimental text transport. No shared input store or fabricated tool history. */
class DuplexToolTransport {
    static prepare(body) {
        const request = AntiTruncation.normalizeRequest(body);
        AntiTruncation.validateRequest(request);
        // Native text requests may omit role; preserve their default user semantics.
        for (const turn of request.contents) {
            if (turn.role === undefined || turn.role === "function" || turn.role === "tool") turn.role = "user";
            // Client tools are dropped for aliases, so earlier tool calls and results stay in the
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
        // The protocol lives only in the tool declarations and acknowledgements: the client's system
        // instruction and conversation are sent unchanged.
        request.tools = [{ functionDeclarations: this.declarations(limit) }];
        request.toolConfig = {
            functionCallingConfig: { allowedFunctionNames: ["append_output", "finish_output"], mode: "ANY" },
        };
        request.generationConfig.candidateCount = 1;
        delete request.generationConfig.responseMimeType;
        return { request };
    }

    /**
     * Transport tool declarations. `notice` explains why the previous call was rejected; it is only
     * part of the declarations for the retry round.
     */
    static declarations(limit, notice = "") {
        return [
            {
                description:
                    (notice ? `${notice} ` : "") +
                    "Delivers your next reply in this conversation; the reply is written only through this tool. " +
                    "Write exactly the reply the conversation calls for, with the same content and format you would otherwise write directly. " +
                    "Send it in order with consecutive seq numbers starting at 1, one call per turn, and wait for the acknowledgement before the next segment. " +
                    `Keep each text segment within ${limit} characters, ending at a sentence or line boundary. ` +
                    "Preserve every character, newline and format; never repeat acknowledged text, never summarize to fit, and do not include private reasoning. " +
                    "Set done=true on the final segment once the whole reply is complete; otherwise set done=false.",
                name: "append_output",
                parameters: {
                    properties: {
                        done: {
                            description: "True only when this segment completes the entire reply.",
                            type: "BOOLEAN",
                        },
                        seq: { description: "Consecutive segment number, starting at 1.", type: "INTEGER" },
                        text: { description: "The next part of the reply text.", type: "STRING" },
                    },
                    required: ["seq", "text"],
                    type: "OBJECT",
                },
            },
            {
                description:
                    "Confirms the whole reply has been delivered when the final append_output segment did not set done=true. " +
                    "Never call it while reply text remains.",
                name: "finish_output",
                parameters: {
                    properties: {
                        last_seq: {
                            description: "The last acknowledged seq (0 for an empty reply).",
                            type: "INTEGER",
                        },
                    },
                    required: ["last_seq"],
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

    /**
     * Length of the longest run of trailing accepted segments that `text` repeats at its start.
     * Models sometimes resend acknowledged text before continuing; runs shorter than
     * MIN_REPEATED_CHARACTERS are kept so legitimately repeated short content is never trimmed.
     */
    static repeatedPrefixLength(segments, text) {
        let tail = "",
            repeated = 0;
        for (let i = segments.length - 1; i >= 0; i--) {
            tail = segments[i] + tail;
            if (tail.length > text.length) break;
            if (tail.length >= AntiTruncation.MIN_REPEATED_CHARACTERS && text.startsWith(tail)) repeated = tail.length;
        }
        return repeated;
    }

    /**
     * Runs the bounded segment protocol. `onFollowup(reason)` fires before every additional upstream
     * call ("continue" or "repair"), `onSegment` receives text that is safe to publish, and
     * `onDiagnostic` receives plain-text replies, trimmed repeats, rejected calls and interruptions
     * for logging.
     */
    static async generate(body, send, onFollowup = () => {}, onSegment = () => {}, onDiagnostic = () => {}) {
        const { request } = this.prepare(body);
        const stops = request.generationConfig.stopSequences;
        const stopOverlap = stops.reduce((longest, stop) => Math.max(longest, stop.length - 1), 0);
        delete request.generationConfig.stopSequences;
        const maxSegments = AntiTruncation.MAX_SEGMENTS;
        const maxCalls = maxSegments + 1 + AntiTruncation.MAX_TOOL_REPAIRS;
        const usage = {};
        // Accepted text per seq, and the text the model actually sent for it. They differ only when
        // a repeated prefix was dropped; an exact resend of either stays an idempotent acknowledgement.
        const segments = [],
            received = [];
        let text = "",
            published = 0,
            outputSeq = 0,
            repairs = 0,
            nextReason = "continue";
        let lastResponse = {},
            finishReason = "MAX_TOKENS";
        // True while the reply arrives as plain text instead of tool calls (Playground has no forced
        // function calling), so a plain-text continuation still belongs to the reply.
        let plainText = false;
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
        const notify = notice => {
            request.tools[0].functionDeclarations = this.declarations(limit, notice);
        };
        const repair = (issue, shrink, detail) => {
            if (repairs >= AntiTruncation.MAX_TOOL_REPAIRS) {
                onDiagnostic({ detail, issue, segments: segments.length, type: "repair_exhausted" });
                return false;
            }
            repairs++;
            // Only a round that ran out of output budget or broke its arguments gets a smaller segment;
            // halving after an ordering mistake would only add rounds to the rest of the reply.
            if (shrink) limit = Math.max(32, Math.floor(limit / 2));
            onDiagnostic({ detail, issue, segments: segments.length, type: "repair" });
            notify(
                `The previous call was rejected (${issue}) and nothing from it was accepted. Retry the current step only, with at most ${limit} text characters; the next seq is ${segments.length + 1}.`
            );
            return true;
        };
        // Appends new reply text and publishes what is safe; returns true when a stop sequence ends it.
        const accept = (segment, sent) => {
            segments.push(segment);
            received.push(sent);
            // The repair budget covers one step; maxCalls still bounds the whole reply.
            repairs = 0;
            // Earlier text has already been checked. Only rescan the overlap where a stop can span segments.
            const searchFrom = Math.max(0, text.length - stopOverlap);
            text += segment;
            const matches = stops.map(stop => text.indexOf(stop, searchFrom)).filter(index => index >= 0);
            if (matches.length) {
                text = text.slice(0, Math.min(...matches));
                return true;
            }
            publish(false);
            return false;
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
            const answered =
                Array.isArray(response.candidates) &&
                response.candidates.length === 1 &&
                ["STOP", "MAX_TOKENS"].includes(candidate?.finishReason);
            const replyText =
                answered && validParts && !calls.length
                    ? parts
                          .filter(part => part.thought !== true && typeof part.text === "string")
                          .map(part => part.text)
                          .join("")
                    : "";
            // A plain-text reply instead of a tool call. Before any segment, or while the reply keeps
            // arriving as text, it is the reply itself, exactly what the base model would return: STOP
            // completes it and MAX_TOKENS continues it through the tool. After a tool acknowledgement,
            // text outside the tool may be commentary, so it is repaired below instead.
            const textContinues = !!replyText.trim() && (!segments.length || plainText);
            const freshText = textContinues ? replyText.slice(this.repeatedPrefixLength(segments, replyText)) : "";
            if (textContinues && (freshText.length || stopped)) {
                if (freshText.length && segments.length >= maxSegments) break;
                lastResponse = response;
                // Only acknowledged text repeated before the reply stopped: nothing new, and complete.
                if (!freshText.length) {
                    finishReason = "STOP";
                    break;
                }
                onDiagnostic({
                    characters: replyText.length,
                    finishReason: candidate.finishReason,
                    segments: segments.length + 1,
                    type: "plain_text",
                });
                if (freshText.length < replyText.length) {
                    onDiagnostic({
                        characters: replyText.length - freshText.length,
                        segments: segments.length + 1,
                        type: "repeat_trimmed",
                    });
                }
                if (accept(freshText, replyText) || stopped) {
                    finishReason = "STOP";
                    break;
                }
                plainText = true;
                notify(
                    `Your previous reply was cut off by the output limit; all of its text was received. Continue it with append_output seq ${segments.length + 1}, starting exactly where it stopped, without repeating it.`
                );
                // The actual model turn keeps its signatures; the empty user turn matches the one added
                // after function turns.
                request.contents.push(candidate.content, { parts: [{ text: "\n" }], role: "user" });
                continue;
            }
            let issue;
            // A rejected round that ran out of output budget or broke its arguments retries smaller.
            const shrink = ["MALFORMED_FUNCTION_CALL", "MAX_TOKENS"].includes(candidate?.finishReason);
            // A completion signal without new text: an empty next segment, or acknowledged text
            // repeated, marked done=true. Both mean the same as finish_output(last_seq).
            let completesWithoutText = false;
            // New text of the next segment, without acknowledged text the model resent at its start.
            let fresh = "";
            if (candidate?.finishReason === "MALFORMED_FUNCTION_CALL") issue = "malformed tool arguments";
            else if (!answered) issue = "missing or unfinished candidate";
            else if (calls.length !== 1 || !args || typeof args !== "object" || Array.isArray(args))
                issue = !replyText.trim()
                    ? "expected one valid transport tool call"
                    : textContinues
                      ? "the segment only repeats acknowledged text"
                      : "reply text was sent outside append_output";
            else if (call.name === "append_output") {
                const doneValid = args.done === undefined || typeof args.done === "boolean";
                const next = args.seq === segments.length + 1;
                if (typeof args.text === "string")
                    fresh = next ? args.text.slice(this.repeatedPrefixLength(segments, args.text)) : args.text;
                const resendsLast =
                    segments.length > 0 &&
                    args.seq === segments.length &&
                    (segments.at(-1) === args.text || received.at(-1) === args.text);
                completesWithoutText =
                    doneValid &&
                    args.done === true &&
                    stopped &&
                    typeof args.text === "string" &&
                    ((next && !fresh.length) || resendsLast);
                if (completesWithoutText) issue = undefined;
                else if (
                    !Number.isSafeInteger(args.seq) ||
                    args.seq < 1 ||
                    typeof args.text !== "string" ||
                    !args.text.length ||
                    !doneValid
                )
                    issue = "invalid output sequence, text or completion flag";
                else if (next && !fresh.length) issue = "the segment only repeats acknowledged text";
                else if (
                    args.seq > segments.length + 1 ||
                    (args.seq <= segments.length &&
                        segments[args.seq - 1] !== args.text &&
                        received[args.seq - 1] !== args.text)
                )
                    issue = "out-of-order or conflicting output sequence";
                else if (args.seq <= segments.length && args.done === true)
                    issue = "completion may only follow the last accepted segment";
            } else if (call.name === "finish_output") {
                if (args.last_seq !== segments.length || !Number.isSafeInteger(args.last_seq) || !stopped)
                    issue = "invalid completion acknowledgement";
            } else issue = "unexpected output transport tool";
            if (issue) {
                // Before any text, a failed call (often an empty reply after long thinking) rarely
                // recovers, and each repair round can take minutes. Fail now instead of keeping the
                // client waiting; repairs only protect text that has already been accepted.
                if (!segments.length) {
                    onDiagnostic({ detail: this.describe(response), issue, segments: 0, type: "repair_exhausted" });
                    throw Object.assign(AntiTruncation.protocolError(`the model produced no output (${issue}).`), {
                        skipAccountSwitch: true,
                    });
                }
                if (repair(issue, shrink, this.describe(response))) {
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
                if (fresh.length < args.text.length) {
                    onDiagnostic({
                        characters: args.text.length - fresh.length,
                        segments: segments.length + 1,
                        type: "repeat_trimmed",
                    });
                }
                plainText = false;
                if (accept(fresh, args.text)) {
                    finishReason = "STOP";
                    break;
                }
                // MAX_TOKENS is not a successful completion, even if the model emitted done=true.
                if (args.done === true && stopped) {
                    finishReason = "STOP";
                    break;
                }
            }
            const nextSeq = segments.length + 1;
            const acknowledgement = {
                instruction:
                    `Continue the reply with append_output seq ${nextSeq} (at most ${limit} characters), ` +
                    `or call finish_output(${segments.length}) if the reply is already complete.`,
                next_seq: nextSeq,
                received: args.seq,
                status: "accepted",
            };
            // A successful call clears any retry notice from the declarations.
            request.tools[0].functionDeclarations = this.declarations(limit);
            // Keep the actual model turn intact, including call IDs and thought signatures. The empty
            // user turn is the same one the ordinary path adds after function turns for these models.
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
                { parts: [{ text: "\n" }], role: "user" }
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
