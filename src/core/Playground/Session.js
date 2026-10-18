/* global window */
const PlaygroundCatalog = require("./Catalog");
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

    async request(model, body, { signal, onData, timeoutMs, onStage = () => {} }) {
        // Each account has one temporary UI used to obtain fresh native request credentials.
        // Separate account contexts remain independent and can run concurrently.
        if (signal.aborted) throw cancelled();
        onStage("queued");
        const run = this.pending.then(() => {
            if (signal.aborted) throw cancelled();
            return this._request(model, body, { onData, onStage, signal, timeoutMs }).catch(error => {
                // Only retry preparation; never repeat an inference which may have produced output.
                if (error.resetFailed && !signal.aborted)
                    return this._request(model, body, { onData, onStage, signal, timeoutMs });
                throw error;
            });
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

    async _request(model, body, { signal, onData, timeoutMs, onStage }) {
        onStage("prepare_page");
        const wire = WireCodec.encode(model, body);
        const speech = PlaygroundCatalog.isSpeech(model);
        if (!this.page || this.page.isClosed()) {
            this.page = await this.context.newPage();
            this.pageModel = null;
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
        let preparationTimer;
        const abort = () => {
            // Closing this dedicated page interrupts navigation, signing, and an active fetch.
            this.capture?.reject(cancelled());
            this.capture = null;
            void page.close().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            if (signal.aborted) throw cancelled();
            let reused = false;
            if (this.pageModel === model && Date.now() - this.loadedAt < 600000) {
                try {
                    await page.getByRole("button", { exact: true, name: "New chat" }).click({ timeout: 5000 });
                    const discard = page.getByRole("button", { exact: true, name: "Discard and continue" });
                    if (await discard.isVisible()) await discard.click({ timeout: 5000 });
                    // The speech page's New chat returns to its landing page; the dialog is reopened below.
                    if (!speech)
                        await page
                            .getByRole("textbox", { exact: true, name: "Enter a prompt" })
                            .waitFor({ timeout: 5000 });
                    else
                        await page
                            .getByRole("button", { exact: true, name: "Create new dialog" })
                            .waitFor({ timeout: 5000 });
                    reused = true;
                } catch {
                    /* Fall back to a clean navigation before signing. */
                }
            }
            if (!reused) {
                await page.goto(
                    speech
                        ? `https://aistudio.google.com/generate-speech?model=${encodeURIComponent(model)}&hl=en`
                        : `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model)}&temporary=true&hl=en`,
                    {
                        timeout: Math.min(timeoutMs, 60000),
                        waitUntil: "domcontentloaded",
                    }
                );
                this.pageModel = model;
                this.loadedAt = Date.now();
            }
            if (new URL(page.url()).hostname !== "aistudio.google.com") {
                throw Object.assign(
                    new Error(
                        "Playground login has expired; refresh this account through existing account management."
                    ),
                    { status: 401 }
                );
            }
            const cookieNotice = page.getByRole("button", { exact: true, name: "OK, got it" });
            const input = speech
                ? await this._speechInput(page, cookieNotice, Math.min(timeoutMs, 30000))
                : page.getByRole("textbox", { exact: true, name: "Enter a prompt" });
            await input.waitFor({ timeout: Math.min(timeoutMs, 30000) });
            if (await cookieNotice.isVisible()) await cookieNotice.click();
            const envelope = new Promise((resolve, reject) => {
                this.capture = { reject, resolve };
                // UI submission has its own short deadline; model generation keeps
                // the separately configured long deadline after dispatch succeeds.
                // Nothing reached inference yet, so another account may safely retry it.
                preparationTimer = setTimeout(
                    () =>
                        reject(
                            Object.assign(
                                new Error("Playground prompt submission timed out before inference started"),
                                { status: 504 }
                            )
                        ),
                    Math.min(timeoutMs, 60000)
                );
            });
            // Attach immediately so aborting during a UI operation cannot reject an unobserved promise.
            envelope.catch(() => {});
            const hashText = wire[1]
                .flatMap(c => c[0].map(p => p[1] ?? p[2]?.[1] ?? p[5]?.[0] ?? p[8] ?? p[9] ?? ""))
                .join(" ");
            // The native signer hashes this same space-joined content, including tool-only parts.
            onStage("submit_prompt");
            await input.fill(hashText || " ");
            await page.getByRole("button", { name: /^Run(?:\s|$)/ }).click({ timeout: Math.min(timeoutMs, 30000) });
            const template = await envelope;
            clearTimeout(preparationTimer);
            onStage("request_dispatched");
            if (signal.aborted) throw cancelled();
            if (speech) WireCodec.alignTranscript(wire, template.body);
            if (template.body[0] !== wire[0] || WireCodec.hash(template.body) !== WireCodec.hash(wire)) {
                throw Object.assign(new Error("Playground could not sign this prompt without changing its content"), {
                    resetFailed: reused,
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
            // The UI template shows thoughts by default; the API omits them unless requested.
            if (Array.isArray(generation[16]) && wire[3][16] == null) {
                generation[16] = [...generation[16]];
                generation[16][0] = 0;
            }
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
            let result = await page.evaluate(
                async ({ headers, payload, url }) => {
                    let response;
                    try {
                        response = await fetch(url, {
                            body: JSON.stringify(payload),
                            credentials: "include",
                            headers,
                            method: "POST",
                        });
                    } catch (error) {
                        return { done: true, error: String(error?.message || error), status: 0 };
                    }
                    if (!response.ok) return { done: true, error: await response.text(), status: response.status };
                    window.__gatewayStream = { decoder: new TextDecoder(), reader: response.body.getReader() };
                    return { done: false, status: response.status };
                },
                { headers, payload, url: `${RPC_ORIGIN}${RPC_PATH}` }
            );
            onStage("upstream_headers");
            let receivedData = false;
            // Await the next network chunk in Camoufox's isolated world. There is no polling
            // timer or producer queue, and the next read starts only after onData completes.
            while (!result.done) {
                if (signal.aborted) throw cancelled();
                result = await page.evaluate(async () => {
                    const state = window.__gatewayStream;
                    const { done, value } = await state.reader.read();
                    const chunk = done ? state.decoder.decode() : state.decoder.decode(value, { stream: true });
                    if (done) {
                        state.reader.releaseLock();
                        delete window.__gatewayStream;
                    }
                    return { chunk, done, status: 200 };
                });
                if (result.chunk) {
                    if (!receivedData) {
                        receivedData = true;
                        onStage("first_chunk");
                    }
                    await onData(result.chunk);
                }
            }
            if (result.error && result.status < 400) {
                throw Object.assign(new Error(`Playground network failure: ${String(result.error).slice(0, 500)}`), {
                    status: 502,
                });
            }
            if (result.status >= 400) {
                // Include server error, never headers, cookies, snapshots or the request body.
                throw Object.assign(
                    new Error(`Playground HTTP ${result.status}: ${String(result.error).slice(0, 1500)}`),
                    { status: result.status }
                );
            }
            onStage("complete");
            return result;
        } catch (error) {
            // Also stop the browser fetch when decoding or the downstream consumer fails.
            await page.close().catch(() => {});
            throw error;
        } finally {
            clearTimeout(preparationTimer);
            this.capture = null;
            signal.removeEventListener("abort", abort);
        }
    }

    /**
     * Opens a text dialog on the generate-speech page. 2.5/3.1 TTS pages offer a plain "Text" view
     * (one textarea); 3.8 pages have a single speech block. Both send the textarea text unchanged,
     * except that 2.5/3.1 prefix it with `## Transcript:` (see WireCodec.alignTranscript).
     */
    async _speechInput(page, cookieNotice, timeout) {
        const create = page.getByRole("button", { exact: true, name: "Create new dialog" });
        await create.waitFor({ timeout });
        if (await cookieNotice.isVisible()) await cookieNotice.click();
        await create.click({ timeout });
        const textView = page.getByRole("radio", { exact: true, name: "Text" });
        const block = page.getByRole("textbox", { exact: true, name: "Speech block text" });
        // Both page kinds open with a speech block; only 2.5/3.1 also render the view switch.
        await block.first().waitFor({ timeout });
        if (!(await textView.count())) return block;
        await textView.click({ timeout });
        return page.getByRole("textbox", { exact: true, name: "Enter a prompt" });
    }
}
module.exports = PlaygroundSession;
