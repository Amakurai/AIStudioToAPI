const AntiTruncation = require("./AntiTruncation");
const DuplexToolTransport = require("./DuplexToolTransport");

/** Suffix-selected OpenAI endpoint, with optional client-side tool decoding. */
class DuplexOpenAI {
    static HEARTBEAT_INTERVAL_MS = 10000;

    static async handle(handler, req, res) {
        const requestId = handler._generateRequestId();
        const stream = req.body?.stream === true;
        const streamMode = stream ? (handler.config.antiTruncationStreamingMode === "fake" ? "fake" : "real") : null;
        const fakeStream = streamMode === "fake";
        const output = req.headers?.["x-anti-truncation-output"] || "text";
        const model = req.body?.model;
        let keepAlive,
            active = false;
        handler._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: stream,
            model,
            requestCategory: "generation",
            streamMode,
        });
        handler._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = streamMode;
        try {
            if (!["text", "tools"].includes(output)) {
                throw AntiTruncation.invalidRequest("output must be text or tools when explicitly requested.");
            }
            if (!AntiTruncation.baseModel(model))
                throw AntiTruncation.invalidRequest("duplex mode only supports the supported anti-truncation aliases.");
            if (req.body.stream !== undefined && typeof req.body.stream !== "boolean")
                throw AntiTruncation.invalidRequest("stream must be boolean.");
            const { googleRequest, cleanModelName } = await handler.formatConverter.translateOpenAIToGoogle(req.body);
            DuplexToolTransport.prepare(googleRequest); // Reject unsupported input before account usage or network calls.
            res.set("X-Anti-Truncation-Mode", "duplex");
            res.set("X-Anti-Truncation-Output", output);
            const ensureStream = () => {
                if (!res.headersSent)
                    res.status(200).set({
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Content-Type": "text/event-stream",
                        "X-Accel-Buffering": "no",
                    });
            };
            const created = Math.floor(Date.now() / 1000);
            const frame = (delta, reason = null, usage) => ({
                choices: [{ delta, finish_reason: reason, index: 0 }],
                created,
                id: `chatcmpl-${requestId}`,
                model,
                object: "chat.completion.chunk",
                ...(usage ? { usage } : {}),
            });
            const write = async data => {
                if (!handler._isResponseWritable(res)) throw new Error("Client disconnected during duplex output.");
                ensureStream();
                if (res.write(`data: ${JSON.stringify(data)}\n\n`) === false) {
                    await new Promise((resolve, reject) => {
                        const cleanup = () => {
                            clearTimeout(timer);
                            res.removeListener("drain", drain);
                            res.removeListener("close", close);
                        };
                        const drain = () => {
                            cleanup();
                            resolve();
                        };
                        const close = () => {
                            cleanup();
                            reject(new Error("Client disconnected during duplex output."));
                        };
                        const timer = setTimeout(
                            () => {
                                cleanup();
                                reject(Object.assign(new Error("Duplex client write timed out."), { status: 504 }));
                            },
                            Math.min(handler.timeouts.FAKE_STREAM, 30000)
                        );
                        res.once("drain", drain);
                        res.once("close", close);
                    });
                }
            };
            if (stream) {
                ensureStream();
                res.flushHeaders?.();
                await write(frame({ content: "", role: "assistant" }));
                // Relays such as new-api retain the latest frame to inspect final usage.
                // An immediate empty frame releases the opening role frame downstream.
                await write(frame({ content: "" }));
                keepAlive = setInterval(() => {
                    if (handler._isResponseWritable(res) && !res.writableNeedDrain) {
                        res.write(": keep-alive\n\n");
                        // Some SSE clients ignore comments when measuring response activity.
                        res.write(`data: ${JSON.stringify(frame({ content: "" }))}\n\n`);
                    }
                }, this.HEARTBEAT_INTERVAL_MS);
            }
            // Keep the SSE connection alive while shared browser recovery is pending.
            // A disconnected client must never dispatch a new generation after recovery.
            let waitingDisconnected = false;
            let onWaitingClose;
            const disconnected = new Promise(resolve => {
                onWaitingClose = () => {
                    waitingDisconnected = true;
                    handler._markTrackedClientAbort(res);
                    resolve(false);
                };
                res.once("close", onWaitingClose);
            });
            try {
                const ready = await Promise.race([
                    handler._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }),
                    disconnected,
                ]);
                if (waitingDisconnected || !handler._isResponseWritable(res)) return;
                if (!ready) {
                    throw Object.assign(
                        new Error(
                            res.__usageTrackingErrorMessage || "Service temporarily unavailable: Browser not ready."
                        ),
                        { status: res.__usageTrackingErrorStatus || 503 }
                    );
                }
            } finally {
                res.removeListener("close", onWaitingClose);
            }
            const authIndex = handler._selectDispatchAuthIndex();
            const spec = {
                anti_truncation_mode: "duplex",
                anti_truncation_output: output,
                anti_truncation_segments: true,
                body: JSON.stringify(googleRequest),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${cleanModelName}:generateContent`,
                query_params: {},
                request_id: requestId,
                streaming_mode: "fake",
            };
            handler._initializeProxyRequestAttempt(spec);
            const queue = handler.connectionRegistry.createMessageQueue(requestId, authIndex, spec.request_attempt_id);
            active = true;
            handler._setupClientDisconnectHandler(res, requestId);
            handler.authSwitcher.incrementUsageCount();
            if (handler.authSwitcher.shouldSwitchByUsage()) handler.needsSwitchingAfterRequest = true;
            handler
                ._getUsageStatsService()
                ?.recordAttempt(requestId, authIndex, handler._getAccountNameForIndex(authIndex));
            const calls = [];
            let fullBody = "",
                seq = 0;
            const tool = (name, args) => ({
                function: { arguments: JSON.stringify(args), name },
                id: `${requestId}-tool-${calls.length + 1}`,
                type: "function",
            });
            handler._forwardRequest(spec, authIndex);
            while (!queue.closed) {
                const message = await queue.dequeue(AntiTruncation.maxWaitMs(handler.timeouts.FAKE_STREAM));
                if (message.event_type === "error")
                    throw Object.assign(new Error(message.message), { status: message.status });
                if (message.type === "STREAM_END") break;
                if (message.event_type === "tool_output") {
                    if (message.seq !== seq + 1)
                        throw AntiTruncation.protocolError("non-contiguous published sequence.");
                    seq = message.seq;
                    const call = tool("append_output", { seq, text: message.text });
                    calls.push(call);
                    if (stream && !fakeStream) {
                        await write(
                            frame(
                                output === "tools"
                                    ? { tool_calls: [{ index: calls.length - 1, ...call }] }
                                    : message.thought
                                      ? { reasoning_content: message.text }
                                      : { content: message.text }
                            )
                        );
                    }
                } else if (message.event_type === "chunk") fullBody += message.data || "";
            }
            const response = JSON.parse(fullBody);
            const converted = handler.formatConverter.convertGoogleToOpenAINonStream(response, cleanModelName);
            handler.authSwitcher.failureCount = 0;
            let reason = converted.choices[0].finish_reason;
            if (output === "tools" && reason === "stop") {
                const call = tool("finish_output", { last_seq: seq });
                calls.push(call);
                if (stream && !fakeStream) await write(frame({ tool_calls: [{ index: calls.length - 1, ...call }] }));
                reason = "tool_calls";
            }
            handler.logger.info(
                `[Duplex] Finished ${requestId}: reason=${response.candidates?.[0]?.finishReason}, segments=${seq}, output=${output}`
            );
            if (stream) {
                if (fakeStream) {
                    if (output === "tools") {
                        for (const [index, call] of calls.entries()) {
                            await write(frame({ tool_calls: [{ index, ...call }] }));
                        }
                    } else {
                        // The upstream answer is complete. Pace Unicode-safe SSE chunks so
                        // clients still display a visible stream in fake mode; reasoning comes first.
                        const { content, reasoning_content: reasoning } = converted.choices[0].message;
                        for (const [field, text] of [
                            ["reasoning_content", reasoning],
                            ["content", content],
                        ]) {
                            const characters = Array.from(text || "");
                            for (let i = 0; i < characters.length; i += 128) {
                                await write(frame({ [field]: characters.slice(i, i + 128).join("") }));
                                if (i + 128 < characters.length) await new Promise(resolve => setTimeout(resolve, 20));
                            }
                        }
                    }
                }
                await write(frame({}, reason, converted.usage));
                res.write("data: [DONE]\n\n");
            } else {
                if (output === "tools") {
                    converted.choices[0].message = { content: null, role: "assistant", tool_calls: calls };
                    converted.choices[0].finish_reason = reason;
                }
                res.status(200).json(converted);
            }
        } catch (error) {
            const status = Number(error.status) || (error.code === "QUEUE_TIMEOUT" ? 504 : 502);
            handler._markTrackedResponseError(res, error.message, status);
            if (handler._isResponseWritable(res)) {
                if (res.headersSent) {
                    res.write(
                        `data: ${JSON.stringify({ error: { code: status, message: error.message, type: "api_error" } })}\n\n`
                    );
                    res.write("data: [DONE]\n\n");
                } else {
                    handler._sendErrorResponse(
                        res,
                        status,
                        error.message,
                        status === 400 ? "invalid_request_error" : null
                    );
                }
            }
        } finally {
            clearInterval(keepAlive);
            if (active) handler.connectionRegistry.removeMessageQueue(requestId, "request_complete");
            if (active && handler.needsSwitchingAfterRequest) {
                handler.needsSwitchingAfterRequest = false;
                handler.authSwitcher
                    .switchToNextAuth()
                    .catch(error => handler.logger.error(`[Duplex] Account rotation failed: ${error.message}`));
            }
            if (!res.writableEnded) res.end();
            handler._finalizeTrackedRequest(requestId, res);
        }
    }
}
module.exports = DuplexOpenAI;
