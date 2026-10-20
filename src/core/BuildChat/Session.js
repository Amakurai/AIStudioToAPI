/* global window, InputEvent */
const { BuildChatCodec } = require("./Codec");

const RPC_ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const SERVICE = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const START_URL = "https://aistudio.google.com/apps?hl=en";
const PROMPT_BOX = "Describe an app and let Gemini do the rest";
// Side effects of the start page's Send (new app, Cloud project, recents, logging). This page only
// signs prompts, so they are answered locally and nothing is created in the account.
const LOCAL_RPCS =
    /^(?:CreateApplet|CreateCloudProject|StoreRecentApplet|SaveApplet|ProvisionAndInitializeApplet|ApplyFileSystemOperation|MintAppletAuthToken|ForkApplet|Log|GenerateCodeAssistantSuggestionChips|ListCodeGenSuggestionCards)$/;
const FORBIDDEN_HEADERS = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "referer",
    "user-agent",
]);
const APPLET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cancelled = () => Object.assign(new Error("Build Chat request cancelled"), { retryable: false, status: 499 });
const pause = (ms, signal) =>
    new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(cancelled());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });

/**
 * Sends Build editor chat requests from an existing BrowserManager context. Each request signs
 * its text on the Build start page, creates a temporary applet, replays the signed request in it
 * and deletes the applet afterwards, so no request sees another's turns or files. An applet that
 * could not be deleted is recorded and deleted by the account's next request.
 */
class BuildChatSession {
    /** Fresh signatures after a refused one, before giving up. */
    static MAX_RESIGNS = 2;

    constructor(context) {
        this.context = context;
        this.page = null;
        this.capture = null;
        this.creatingApplet = false;
        this.pending = Promise.resolve();
    }

    /**
     * @param {string} model - Upstream model name.
     * @param {ReturnType<typeof BuildChatCodec.encode>} encoded
     * @param {{ leftovers: { list(): string[], add(id: string): void, remove(id: string): void }, signal: AbortSignal,
     *   onData: (text: string) => void|Promise<void>, onPassEnd: () => boolean|Promise<boolean>,
     *   timeoutMs: number, onStage?: (stage: string) => void }} options - `onPassEnd` runs after each
     *   read of the trajectory and returns true to read it again.
     */
    async request(model, encoded, { leftovers, signal, onData, onPassEnd, timeoutMs, onStage = () => {} }) {
        // One prompt box per account; separate accounts run concurrently.
        if (signal.aborted) throw cancelled();
        onStage("queued");
        const options = { leftovers, onData, onPassEnd, onStage, signal, timeoutMs };
        // Signing again is safe only before any inference started (a refused signature).
        // The upstream now and then refuses a signed request; a short pause usually clears it.
        const attempt = retries =>
            this._request(model, encoded, options).catch(async error => {
                if (!error.resetFailed || signal.aborted || retries >= BuildChatSession.MAX_RESIGNS) throw error;
                if (error.status === 403) await pause(3000 * (retries + 1), signal);
                return attempt(retries + 1);
            });
        const run = this.pending.then(() => {
            if (signal.aborted) throw cancelled();
            return attempt(0);
        });
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

    async _openPage() {
        if (this.page && !this.page.isClosed()) return this.page;
        const page = await this.context.newPage();
        await page.route(/^https:\/\/alkalimakersuite-pa\.clients6\.google\.com\/\$rpc\//, async route => {
            const request = route.request();
            const name = new URL(request.url()).pathname.split("/").pop();
            const local = () => route.fulfill({ body: "[[]]", contentType: "application/json+protobuf", status: 200 });
            if (name === "CodeAssistantOffline" && this.capture) {
                const capture = this.capture;
                this.capture = null;
                try {
                    capture.resolve({ body: JSON.parse(request.postData()), headers: await request.allHeaders() });
                    // The page's own request only supplies a signed envelope; it never reaches inference.
                    return await local();
                } catch (error) {
                    capture.reject(error);
                    return route.abort().catch(() => {});
                }
            }
            if (name === "StreamCodeAssistantOfflineGeneration") {
                // After the local answer above the page asks for a generation without an ID.
                let generationId;
                try {
                    generationId = JSON.parse(request.postData())?.[0];
                } catch {
                    generationId = null;
                }
                if (typeof generationId !== "string") return local();
            }
            if (LOCAL_RPCS.test(name) && !(name === "CreateApplet" && this.creatingApplet)) return local();
            return route.continue();
        });
        this.page = page;
        return page;
    }

    async _request(model, encoded, { leftovers, signal, onData, onPassEnd, timeoutMs, onStage }) {
        onStage("prepare_page");
        const page = await this._openPage();
        let preparationTimer;
        const abort = () => {
            // Closing this dedicated page interrupts navigation, signing, and an active fetch.
            this.capture?.reject(cancelled());
            this.capture = null;
            void page.close().catch(() => {});
        };
        signal.addEventListener("abort", abort, { once: true });
        let appletId = null;
        let headers = null;
        let failure = null;
        try {
            if (signal.aborted) throw cancelled();
            let input = await this._promptBox(page, timeoutMs);
            const cookieNotice = page.getByRole("button", { exact: true, name: "OK, got it" });
            if (await cookieNotice.isVisible()) await cookieNotice.click();
            const envelope = new Promise((resolve, reject) => {
                this.capture = { reject, resolve };
                // Nothing reached inference yet, so another account may safely retry it.
                preparationTimer = setTimeout(
                    () =>
                        reject(
                            Object.assign(new Error("Build Chat prompt signing timed out before inference started"), {
                                status: 504,
                            })
                        ),
                    Math.min(timeoutMs, 60000)
                );
            });
            envelope.catch(() => {});
            onStage("submit_prompt");
            const send = page.getByRole("button", { exact: true, name: "Send" });
            // Text entered before the box is wired up leaves Send disabled: enter it again, then reload.
            for (let attempt = 1; ; attempt++) {
                await this._enterText(input, encoded.signText);
                if (await this._becomesEnabled(send, 3000)) break;
                if (attempt >= 3)
                    throw Object.assign(new Error("Build Chat prompt box did not accept the text"), { status: 503 });
                if (attempt === 2) input = await this._promptBox(page, timeoutMs);
            }
            await send.click({ timeout: Math.min(timeoutMs, 30000) });
            const template = await envelope;
            clearTimeout(preparationTimer);
            if (signal.aborted) throw cancelled();
            const native = template.body?.[BuildChatCodec.FIELD.CONTENTS];
            if (!Array.isArray(native) || BuildChatCodec.hash(native) !== BuildChatCodec.hash(encoded.contents)) {
                throw Object.assign(new Error("Build Chat could not sign this prompt without changing its content"), {
                    retryable: false,
                    status: 400,
                });
            }
            headers = Object.fromEntries(
                Object.entries(template.headers).filter(
                    ([name]) => !FORBIDDEN_HEADERS.has(name) && !name.startsWith("sec-")
                )
            );
            for (const id of leftovers.list().slice(0, 5)) await this._deleteApplet(page, headers, id, leftovers);
            appletId = await this._createApplet(page, headers);
            leftovers.add(appletId);
            const body = BuildChatCodec.request(template.body, { ...encoded, appletId, model });
            const url = `${RPC_ORIGIN}${SERVICE}`;
            const started = await page.evaluate(
                async ({ body, headers, url }) => {
                    let response;
                    try {
                        response = await fetch(`${url}CodeAssistantOffline`, {
                            body: JSON.stringify(body),
                            credentials: "include",
                            headers,
                            method: "POST",
                        });
                    } catch (error) {
                        return { error: String(error?.message || error), status: 0 };
                    }
                    const text = await response.text();
                    if (!response.ok) return { error: text, status: response.status };
                    let generationId;
                    try {
                        generationId = JSON.parse(text)?.[0];
                    } catch {
                        generationId = null;
                    }
                    return typeof generationId === "string" ? { generationId } : { error: text, status: 502 };
                },
                { body, headers, url }
            );
            if (started.error !== undefined) {
                const rpc = BuildChatCodec.rpcError(started.error);
                const status = rpc?.status || started.status || 502;
                const detail = rpc?.message || String(started.error).slice(0, 1500);
                throw Object.assign(
                    new Error(
                        started.status === 0
                            ? `Build Chat network failure: ${detail}`
                            : `Build Chat HTTP ${status}: ${detail}`
                    ),
                    // Nothing was generated: a refused signature usually passes when signed again.
                    { resetFailed: status === 403, status: started.status === 0 ? 502 : status }
                );
            }
            onStage("request_dispatched");
            let receivedData = false;
            // A read returns the run's steps once it ends; it can also close early. Read again until
            // the caller has seen the whole run.
            do {
                if (signal.aborted) throw cancelled();
                onStage("read");
                let result = await page.evaluate(
                    async ({ appletId, generationId, headers, url }) => {
                        let response;
                        try {
                            response = await fetch(`${url}StreamCodeAssistantOfflineGeneration`, {
                                body: JSON.stringify([generationId, null, null, appletId]),
                                credentials: "include",
                                headers,
                                method: "POST",
                            });
                        } catch (error) {
                            return { done: true, error: String(error?.message || error), status: 0 };
                        }
                        if (!response.ok) return { done: true, error: await response.text(), status: response.status };
                        window.__buildChatStream = { decoder: new TextDecoder(), reader: response.body.getReader() };
                        return { done: false };
                    },
                    { appletId, generationId: started.generationId, headers, url }
                );
                if (result.error !== undefined) {
                    const rpc = BuildChatCodec.rpcError(result.error);
                    const detail = rpc?.message || String(result.error).slice(0, 1500);
                    throw Object.assign(
                        new Error(
                            result.status === 0
                                ? `Build Chat network failure: ${detail}`
                                : `Build Chat HTTP ${rpc?.status || result.status}: ${detail}`
                        ),
                        { retryable: false, status: result.status === 0 ? 502 : rpc?.status || result.status }
                    );
                }
                while (!result.done) {
                    if (signal.aborted) throw cancelled();
                    result = await page.evaluate(async () => {
                        const state = window.__buildChatStream;
                        const { done, value } = await state.reader.read();
                        const chunk = done ? state.decoder.decode() : state.decoder.decode(value, { stream: true });
                        if (done) {
                            state.reader.releaseLock();
                            delete window.__buildChatStream;
                        }
                        return { chunk, done };
                    });
                    if (result.chunk) {
                        if (!receivedData) {
                            receivedData = true;
                            onStage("first_chunk");
                        }
                        await onData(result.chunk);
                    }
                }
            } while (await onPassEnd());
            onStage("complete");
        } catch (error) {
            failure = error;
        }
        clearTimeout(preparationTimer);
        this.capture = null;
        signal.removeEventListener("abort", abort);
        // A cancelled request closed the page; its applet stays recorded for the next request.
        if (appletId && !page.isClosed()) await this._deleteApplet(page, headers, appletId, leftovers);
        if (failure) {
            // Also stop the browser fetch when decoding or the downstream consumer fails.
            await page.close().catch(() => {});
            throw failure;
        }
    }

    /** Opens the start page and returns its prompt box. */
    async _promptBox(page, timeoutMs) {
        await page.goto(START_URL, { timeout: Math.min(timeoutMs, 60000), waitUntil: "domcontentloaded" });
        if (new URL(page.url()).hostname !== "aistudio.google.com") {
            throw Object.assign(
                new Error("Build Chat login has expired; refresh this account through existing account management."),
                { status: 401 }
            );
        }
        const box = page
            .locator(`textarea[placeholder="${PROMPT_BOX}"]`)
            .or(page.getByRole("textbox", { exact: true, name: PROMPT_BOX }))
            .first();
        await box.waitFor({ timeout: Math.min(timeoutMs, 30000) });
        return box;
    }

    async _becomesEnabled(locator, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await locator.isEnabled().catch(() => false)) return true;
            if (Date.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    /**
     * The box is a textarea or, on some loads, a `contenteditable="plaintext-only"` element that
     * this Firefox cannot type into; that one takes its text and an input event directly.
     */
    async _enterText(box, text) {
        if ((await box.evaluate(el => el.tagName)) === "TEXTAREA") return box.fill(text);
        await box.evaluate((el, value) => {
            el.focus();
            el.textContent = value;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
        }, text);
    }

    /** Creates a temporary applet. It is never provisioned (no Cloud Run app). */
    async _createApplet(page, headers) {
        this.creatingApplet = true;
        let result;
        try {
            result = await page.evaluate(
                async ({ headers, url }) => {
                    const title = "AIStudioToAPI Build Chat (temporary)";
                    const response = await fetch(url, {
                        body: JSON.stringify([
                            null,
                            [
                                title,
                                "Temporary conversation of the bdc- API channel; deleted after use.",
                                title,
                                null,
                                "default",
                            ],
                            null,
                            null,
                            1,
                        ]),
                        credentials: "include",
                        headers,
                        method: "POST",
                    });
                    return { status: response.status, text: await response.text() };
                },
                { headers, url: `${RPC_ORIGIN}${SERVICE}CreateApplet` }
            );
        } finally {
            this.creatingApplet = false;
        }
        let appletId = null;
        try {
            appletId = JSON.parse(result.text)?.[0];
        } catch {
            // Reported below.
        }
        if (result.status !== 200 || typeof appletId !== "string" || !APPLET_ID.test(appletId)) {
            const rpc = BuildChatCodec.rpcError(result.text);
            throw Object.assign(
                new Error(
                    `Build Chat could not create its applet: ${rpc?.message || String(result.text).slice(0, 500)}`
                ),
                { status: rpc?.status || (result.status >= 400 ? result.status : 502) }
            );
        }
        return appletId;
    }

    /** Deletes an applet; one already gone counts as deleted. Failures keep it recorded. */
    async _deleteApplet(page, headers, appletId, leftovers) {
        const status = await page
            .evaluate(
                async ({ appletId, headers, url }) => {
                    try {
                        const response = await fetch(url, {
                            body: JSON.stringify([appletId]),
                            credentials: "include",
                            headers,
                            method: "POST",
                        });
                        return response.status;
                    } catch {
                        return 0;
                    }
                },
                { appletId, headers, url: `${RPC_ORIGIN}${SERVICE}DeleteApplet` }
            )
            .catch(() => 0);
        if (status === 200 || status === 404) leftovers.remove(appletId);
        return status === 200 || status === 404;
    }
}

module.exports = BuildChatSession;
