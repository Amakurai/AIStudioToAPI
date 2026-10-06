/** Optional client adapter for direct OpenAI-compatible requests to AIStudioToAPI. */
(function (root) {
    class Decoder {
        constructor() {
            this.segments = [];
            this.finished = false;
            this.terminal = false;
            this.failed = false;
        }
        call(call) {
            const args = JSON.parse(call.function?.arguments || "{}");
            if (call.function?.name === "append_output") {
                if (this.finished || !Number.isSafeInteger(args.seq) || args.seq < 1 || typeof args.text !== "string")
                    throw new Error("Invalid duplex output sequence.");
                if (args.seq <= this.segments.length) {
                    if (this.segments[args.seq - 1] !== args.text)
                        throw new Error("Conflicting duplex output segment.");
                    return "";
                }
                if (args.seq !== this.segments.length + 1) throw new Error("Missing duplex output segment.");
                this.segments.push(args.text);
                return args.text;
            }
            if (
                call.function?.name === "finish_output" &&
                Number.isSafeInteger(args.last_seq) &&
                args.last_seq === this.segments.length
            ) {
                this.finished = true;
                return "";
            }
            throw new Error("Unexpected duplex transport tool.");
        }
        reason(reason) {
            if (!reason) return reason;
            this.terminal = true;
            if (reason === "tool_calls" || reason === "stop") {
                if (!this.finished) throw new Error("Duplex response ended without a completion acknowledgement.");
                return "stop";
            }
            return reason; // Keep length and content_filter visible to the client.
        }
        event(value) {
            if (value.error) {
                this.failed = true;
                return value;
            }
            for (const choice of value.choices || []) {
                const delta = choice.delta || {};
                if (delta.tool_calls) {
                    const text = delta.tool_calls.map(call => this.call(call)).join("");
                    delete delta.tool_calls;
                    if (text) delta.content = text;
                }
                choice.finish_reason = this.reason(choice.finish_reason);
            }
            return value;
        }
    }

    function responseHeaders(response) {
        const headers = new Headers(response.headers);
        for (const key of ["content-length", "content-encoding", "etag"]) headers.delete(key);
        return headers;
    }

    async function decodeResponse(response) {
        if (!response.ok || response.headers.get("x-anti-truncation-output") !== "tools") return response;
        const state = new Decoder();
        const headers = responseHeaders(response);
        const type = headers.get("content-type") || "";
        if (type.includes("application/json")) {
            const value = await response.json();
            for (const choice of value.choices || []) {
                const calls = choice.message?.tool_calls || [];
                const text = calls.map(call => state.call(call)).join("");
                choice.message = { ...choice.message, content: text };
                delete choice.message.tool_calls;
                choice.finish_reason = state.reason(choice.finish_reason);
            }
            return new Response(JSON.stringify(value), { headers, status: response.status });
        }
        if (!type.includes("text/event-stream") || !response.body)
            throw new Error("Unsupported duplex response format.");
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "",
            done = false;
        const event = (raw, controller) => {
            const data = raw
                .split(/\r?\n/)
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).replace(/^ /, ""))
                .join("\n");
            if (!data) {
                controller.enqueue(encoder.encode(raw + "\n\n"));
                return;
            }
            if (done) throw new Error("Unexpected data after duplex stream end.");
            if (data.trim() === "[DONE]") {
                if (!state.terminal && !state.failed) throw new Error("Duplex stream closed before its final status.");
                done = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                return;
            }
            controller.enqueue(encoder.encode("data: " + JSON.stringify(state.event(JSON.parse(data))) + "\n\n"));
        };
        const consume = controller => {
            let match;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const raw = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                event(raw, controller);
            }
            if (buffer.length > 1024 * 1024) throw new Error("Duplex event exceeds the client buffer limit.");
        };
        const body = response.body.pipeThrough(
            new TransformStream({
                flush(controller) {
                    buffer += decoder.decode();
                    consume(controller);
                    if (buffer.trim()) event(buffer, controller);
                    if (!done) throw new Error("Duplex stream disconnected before [DONE].");
                },
                transform(chunk, controller) {
                    buffer += decoder.decode(chunk, { stream: true });
                    consume(controller);
                },
            })
        );
        return new Response(body, { headers, status: response.status });
    }

    function createFetch(nativeFetch = root.fetch.bind(root)) {
        return async (input, init) => {
            const request = new Request(typeof input === "string" ? new URL(input, root.location?.href) : input, init);
            if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v1/chat/completions"))
                return nativeFetch(request);
            let payload;
            try {
                payload = await request.clone().json();
            } catch {
                return nativeFetch(request);
            }
            if (!/^gemini-3\.[78]-flash-抗截断$/.test(payload.model || "")) return nativeFetch(request);
            const headers = new Headers(request.headers);
            headers.set("X-Anti-Truncation-Output", "tools");
            const response = await nativeFetch(new Request(request, { headers }));
            if (response.ok && response.headers.get("x-anti-truncation-output") !== "tools") {
                await response.body?.cancel();
                throw new Error("Server did not enable duplex tools mode; check deployment and header forwarding.");
            }
            return decodeResponse(response);
        };
    }
    const api = { createFetch, decodeResponse };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.AIStudioDuplex = api;
})(globalThis);
