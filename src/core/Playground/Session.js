/* global window */
const { WireCodec } = require("./WireCodec");

const RPC_ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC_PATH = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const cancelled = () => Object.assign(new Error("Playground request cancelled"), { retryable: false, status: 499 });

/** Uses an existing BrowserManager context. No cookie import, extraction, or second login. */
class PlaygroundSession {
    constructor(context, onModels) {
        this.context = context;
        this.onModels = onModels;
        this.page = null;
        this.pending = Promise.resolve();
    }

    async request(model, body, { signal, onData, timeoutMs }) {
        // Each account has one temporary UI used to obtain fresh native request credentials.
        // Separate account contexts remain independent and can run concurrently.
        if (signal.aborted) throw cancelled();
        const run = this.pending.then(() => {
            if (signal.aborted) throw cancelled();
            return this._request(model, body, { onData, signal, timeoutMs });
        });
        // Keep the account lock until the active operation has actually stopped, even if
        // its caller has cancelled. A cancelled waiter must never open a page later.
        this.pending = run.catch(() => {});
        let abort;
        const interrupted = new Promise((_, reject) => {
            abort = () => reject(cancelled());
            signal.addEventListener("abort", abort, { once: true });
        });
        try {
            return await Promise.race([run, interrupted]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }

    async _request(model, body, { signal, onData, timeoutMs }) {
        const wire = WireCodec.encode(model, body);
        if (!this.page || this.page.isClosed()) {
            this.page = await this.context.newPage();
            this.page.on("response", async response => {
                if (response.url() === `${RPC_ORIGIN}${RPC_PATH.replace("GenerateContent", "ListModels")}`) {
                    try {
                        this.onModels(await response.json());
                    } catch {
                        /* Discovery is best effort. */
                    }
                }
            });
            await this.page.route("**/*", async route => {
                const request = route.request();
                const url = new URL(request.url());
                if (url.origin === RPC_ORIGIN && /\/(SavePrompt|CreatePrompt)$/.test(url.pathname)) {
                    return route.fulfill({ body: "[]", contentType: "application/json+protobuf", status: 200 });
                }
                if (url.origin === RPC_ORIGIN && url.pathname === RPC_PATH && this.capture) {
                    const capture = this.capture;
                    this.capture = null;
                    try {
                        capture.resolve({ body: JSON.parse(request.postData()), headers: await request.allHeaders() });
                        // Bootstrap only obtains a native signed envelope; it never reaches inference.
                        return await route.fulfill({
                            body: "[[]]",
                            contentType: "application/json+protobuf",
                            status: 200,
                        });
                    } catch (error) {
                        capture.reject(error);
                        return route.abort().catch(() => {});
                    }
                }
                return route.continue();
            });
        }
        const page = this.page;
        const abort = () => {
            // Closing this dedicated page interrupts navigation, signing, and an active fetch.
            this.capture?.reject(cancelled());
            this.capture = null;
            void page.close().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            if (signal.aborted) throw cancelled();
            await page.goto(
                `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model)}&temporary=true&hl=en`,
                {
                    timeout: Math.min(timeoutMs, 60000),
                    waitUntil: "domcontentloaded",
                }
            );
            if (new URL(page.url()).hostname !== "aistudio.google.com") {
                throw Object.assign(
                    new Error(
                        "Playground login has expired; refresh this account through existing account management."
                    ),
                    { status: 401 }
                );
            }
            const input = page.getByRole("textbox", { exact: true, name: "Enter a prompt" });
            await input.waitFor({ timeout: Math.min(timeoutMs, 30000) });
            const cookieNotice = page.getByRole("button", { exact: true, name: "OK, got it" });
            if (await cookieNotice.isVisible()) await cookieNotice.click();
            const envelope = new Promise((resolve, reject) => {
                this.capture = { reject, resolve };
            });
            // Attach immediately so aborting during a UI operation cannot reject an unobserved promise.
            envelope.catch(() => {});
            const hashText = wire[1]
                .flatMap(c => c[0].map(p => p[1] ?? p[2]?.[1] ?? p[5]?.[0] ?? p[8] ?? p[9] ?? ""))
                .join(" ");
            // The native signer hashes this same space-joined content, including tool-only parts.
            await input.fill(hashText || " ");
            await page.getByRole("button", { name: /^Run(?:\s|$)/ }).click({ timeout: Math.min(timeoutMs, 30000) });
            const template = await envelope;
            if (signal.aborted) throw cancelled();
            if (WireCodec.hash(template.body) !== WireCodec.hash(wire)) {
                throw Object.assign(new Error("Playground could not sign this prompt without changing its content"), {
                    retryable: false,
                    status: 400,
                });
            }
            const payload = template.body;
            for (const index of [0, 1, 2, 5, 6, 11, 13]) payload[index] = wire[index] ?? null;
            const generation = payload[3] || [];
            // Discard UI tools/format while preserving protocol-only defaults from the native envelope.
            generation[7] = null;
            generation[8] = null;
            wire[3].forEach((value, index) => {
                if (value !== undefined && value !== null) generation[index] = value;
            });
            payload[3] = generation;
            const forbidden = new Set([
                "cookie",
                "host",
                "content-length",
                "connection",
                "origin",
                "referer",
                "user-agent",
                "accept-encoding",
            ]);
            const headers = Object.fromEntries(
                Object.entries(template.headers).filter(([name]) => !forbidden.has(name) && !name.startsWith("sec-"))
            );
            // In particular preserve x-aistudio-g1-tier and the native entitlement headers.
            await page.evaluate(
                ({ headers, payload, url }) => {
                    const state = { chunks: [], done: false, error: null, status: 0 };
                    window.__gatewayStream = state;
                    void (async () => {
                        try {
                            const response = await fetch(url, {
                                body: JSON.stringify(payload),
                                credentials: "include",
                                headers,
                                method: "POST",
                            });
                            state.status = response.status;
                            if (!response.ok) {
                                state.error = await response.text();
                                return;
                            }
                            const reader = response.body.getReader();
                            const decoder = new TextDecoder();
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                state.chunks.push(decoder.decode(value, { stream: true }));
                            }
                            const tail = decoder.decode();
                            if (tail) state.chunks.push(tail);
                        } catch (error) {
                            state.error = error.message;
                        } finally {
                            state.done = true;
                        }
                    })();
                },
                { headers, payload, url: `${RPC_ORIGIN}${RPC_PATH}` }
            );
            // Camoufox's isolated evaluation world cannot call main-world exposeBinding functions.
            // Drain its own queue; this preserves incremental output without page-global hooks.
            let result;
            do {
                if (signal.aborted) throw cancelled();
                result = await page.evaluate(() => {
                    const state = window.__gatewayStream;
                    return {
                        chunks: state.chunks.splice(0),
                        done: state.done,
                        error: state.error,
                        status: state.status,
                    };
                });
                for (const chunk of result.chunks) onData(chunk);
                if (!result.done) await new Promise(resolve => setTimeout(resolve, 40));
            } while (!result.done);
            if (result.error && result.status < 400) throw new Error(`Playground network failure: ${result.error}`);
            if (result.status >= 400) {
                // Include server error, never headers, cookies, snapshots or the request body.
                throw Object.assign(
                    new Error(`Playground HTTP ${result.status}: ${String(result.error).slice(0, 1500)}`),
                    { status: result.status }
                );
            }
            return result;
        } catch (error) {
            // Also stop the browser fetch when decoding or the downstream consumer fails.
            await page.close().catch(() => {});
            throw error;
        } finally {
            this.capture = null;
            signal.removeEventListener("abort", abort);
        }
    }
}
module.exports = PlaygroundSession;
