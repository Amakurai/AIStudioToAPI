/** Build editor chat (CodeAssistantOffline) protocol adapter. Protocol notes: docs/build-chat.md. */
const crypto = require("crypto");
const { WireCodec } = require("../Playground/WireCodec");

const invalid = message => Object.assign(new Error(`Build Chat: ${message}`), { retryable: false, status: 400 });
const pick = (obj, camel) => obj?.[camel] ?? obj?.[camel.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
const normalizeText = value => value.replace(/\r\n?/g, "\n");
// google.rpc.Code -> HTTP status for errors returned inside a 200 JSPB body.
const RPC_STATUS = { 1: 499, 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 9: 400, 13: 500, 14: 503, 16: 401 };

// CodeAssistantOffline request fields (JSPB indexes).
const FIELD = { APPLET: 11, CONTENTS: 0, MODEL: 7, NEW_CONVERSATION: 22, THINKING: 18 };
// Trajectory step fields: [contents, ..., 9 tool call, 11 step number, 12 = 1 done / 2 running, 13 model, 15 tokens].
const TURN = { DONE: 12, STEP: 11, TOKENS: 15 };

class BuildChatCodec {
    static FIELD = FIELD;

    /**
     * Gemini request -> the parts of a CodeAssistantOffline request this channel controls.
     * The Build assistant has no system, tool or sampling fields: a system instruction becomes the
     * first text of the conversation, function tools are rejected, sampling settings are ignored.
     * @returns {{ contents: Array, includeThoughts: boolean, signText: string, thinkingLevel: number|null }}
     */
    static encode(body) {
        if (!body || typeof body !== "object") throw invalid("request body must be an object");
        if (!Array.isArray(body.contents) || !body.contents.length) throw invalid("contents must not be empty");
        if (pick(body, "cachedContent")) throw invalid("cachedContent is not supported");
        const tools = Array.isArray(body.tools) ? body.tools : [];
        if (tools.some(tool => pick(tool, "functionDeclarations")?.length))
            throw invalid("function tools are not supported; use build- or pg- models for tool calling");

        const turns = body.contents.map((content, i) => {
            if (!content || typeof content !== "object" || !Array.isArray(content.parts))
                throw invalid(`contents[${i}].parts must be an array`);
            const role = content.role || "user";
            if (role !== "user" && role !== "model") throw invalid(`contents[${i}] has unsupported role ${role}`);
            const texts = [];
            content.parts.forEach((part, j) => {
                if (!part || typeof part !== "object") throw invalid(`unsupported content part at contents[${i}]`);
                // Earlier thoughts are not replayed; Build chat history carries answers only.
                if (part.thought === true) return;
                if (typeof part.text !== "string")
                    throw invalid(`only text parts are supported (contents[${i}].parts[${j}])`);
                texts.push(normalizeText(part.text));
            });
            return { role, texts };
        });
        const system = pick(body, "systemInstruction");
        const systemTexts = (Array.isArray(system?.parts) ? system.parts : [])
            .map(part => (typeof part?.text === "string" ? normalizeText(part.text) : ""))
            .filter(text => text.trim());
        if (systemTexts.length) {
            if (turns[0]?.role === "user") turns[0].texts.unshift(...systemTexts);
            else turns.unshift({ role: "user", texts: systemTexts });
        }
        const nonEmpty = turns.filter(turn => turn.texts.length);
        if (!nonEmpty.length) throw invalid("the conversation has no text");
        // The signature covers the text the page's prompt box sends, which it trims.
        const first = nonEmpty[0].texts;
        first[0] = first[0].trimStart();
        const last = nonEmpty.at(-1).texts;
        last[last.length - 1] = last.at(-1).trimEnd();
        const contents = nonEmpty.map(turn => [turn.texts.map(text => [null, text]), turn.role]);
        const signText = this.signText(contents);
        if (!signText.trim()) throw invalid("the conversation has no text");

        const thinking = pick(pick(body, "generationConfig"), "thinkingConfig");
        const level = pick(thinking, "thinkingLevel");
        return {
            contents,
            includeThoughts: pick(thinking, "includeThoughts") === true,
            signText,
            thinkingLevel: level
                ? ({ HIGH: 3, LOW: 1, MEDIUM: 2, MINIMAL: 4 }[String(level).toUpperCase()] ?? null)
                : null,
        };
    }

    /** The native signer hashes the space-joined text of every part, as for Playground. */
    static signText(contents) {
        return contents.flatMap(content => content[0].map(part => part[1] ?? "")).join(" ");
    }

    static hash(contents) {
        return crypto.createHash("sha256").update(this.signText(contents)).digest("hex");
    }

    /** Native envelope captured from the page -> the request this channel sends. */
    static request(template, { appletId, contents, model, thinkingLevel }) {
        const body = JSON.parse(JSON.stringify(template));
        body[FIELD.CONTENTS] = contents;
        body[FIELD.MODEL] = `models/${model}`;
        body[FIELD.APPLET] = appletId;
        // Start a new conversation in the applet: without it the applet's earlier turns are prepended.
        body[FIELD.NEW_CONVERSATION] = 1;
        if (thinkingLevel) {
            const thinking = Array.isArray(body[FIELD.THINKING]) ? [...body[FIELD.THINKING]] : [1];
            thinking[3] = thinkingLevel;
            body[FIELD.THINKING] = thinking;
        }
        return body;
    }

    /** An error in a JSPB body: `[,[code,"message"]]` (200 stream) or `[code,"message"]` (HTTP error), or null. */
    static rpcError(text) {
        const match = String(text || "").match(/^\s*\[\s*(?:,\s*\[\s*)?(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"/);
        if (!match) return null;
        let message = match[2];
        try {
            message = JSON.parse(`"${match[2]}"`);
        } catch {
            // Keep the raw message.
        }
        return { message, status: RPC_STATUS[match[1]] || 502 };
    }
}

/**
 * Turns a StreamCodeAssistantOfflineGeneration trajectory into Gemini output. The Build assistant
 * is an agent: a run is a series of numbered steps (the user turn, model turns, file reads, edits,
 * compiles). Every update is a full snapshot of one step, so text is emitted as the growth since
 * that step's previous snapshot. Only model turns become output; tool steps are not returned.
 */
class BuildChatResponse {
    constructor(model, { includeThoughts = false } = {}) {
        this.model = model;
        this.includeThoughts = includeThoughts;
        this.steps = new Map();
        this.emitted = new Map();
        this.updates = 0;
        this.last = null;
    }

    /** Shape of the trajectory so far, for diagnostics; never includes text. */
    summary() {
        const steps = [...this.steps].map(([step, s]) => `${step}${s.model ? "m" : ""}${s.done ? "" : "*"}`).join(",");
        return `updates=${this.updates} steps=[${steps}] last=${this.last ? JSON.stringify(this.last) : "none"}`;
    }

    /**
     * The latest step finished and some model step answered with text. Earlier steps are not
     * checked: an agent run can leave a superseded step unfinished.
     */
    get complete() {
        if (!this.steps.size) return false;
        const latest = this.steps.get(Math.max(...this.steps.keys()));
        return (
            latest.done && [...this.steps.values()].some(step => step.parts.some(part => !part.thought && part.text))
        );
    }

    get usage() {
        const sum = { cached: 0, candidates: 0, fresh: 0, seen: false };
        for (const step of this.steps.values()) {
            if (!step.tokens) continue;
            const [fresh = 0, candidates = 0, cached = 0] = step.tokens;
            sum.fresh += fresh;
            sum.candidates += candidates;
            sum.cached += cached;
            sum.seen = true;
        }
        if (!sum.seen) return null;
        // Each model step is a separate model call; report what the whole run consumed.
        return {
            cachedContentTokenCount: sum.cached,
            candidatesTokenCount: sum.candidates,
            promptTokenCount: sum.fresh + sum.cached,
            totalTokenCount: sum.fresh + sum.cached + sum.candidates,
        };
    }

    /** @returns {object|null} Gemini chunk with the new output of this update. */
    update(raw) {
        this.updates++;
        // An update carries one or more step snapshots (a later read may batch a whole run).
        const turns = Array.isArray(raw?.[2]) ? raw[2] : [];
        const delta = turns.flatMap(turn => this._step(turn));
        if (!delta.length) return null;
        return { candidates: [{ content: { parts: delta, role: "model" }, index: 0 }], modelVersion: this.model };
    }

    /** Records one step snapshot and returns the output parts it adds. */
    _step(turn) {
        if (!Array.isArray(turn) || !Number.isInteger(turn[TURN.STEP])) return [];
        const step = turn[TURN.STEP];
        const contents = Array.isArray(turn[0]) ? turn[0] : [];
        const parts = contents
            .filter(content => Array.isArray(content) && content[1] === "model" && Array.isArray(content[0]))
            .flatMap(content => content[0].map(part => WireCodec.decodePart(part)));
        const tokens = Array.isArray(turn[TURN.TOKENS]) ? turn[TURN.TOKENS].map(Number) : null;
        const model = contents.some(content => content?.[1] === "model");
        this.steps.set(step, {
            done: turn[TURN.DONE] === 1,
            model,
            parts,
            tokens: tokens?.every(Number.isFinite) ? tokens : this.steps.get(step)?.tokens || null,
        });
        this.last = { done: turn[TURN.DONE], kind: model ? "model" : contents.length ? "user" : "tool", step };
        const delta = [];
        parts.forEach((part, i) => {
            if (part.thought && !this.includeThoughts) return;
            const text = typeof part.text === "string" ? part.text : "";
            const key = `${step}:${i}`;
            const before = this.emitted.get(key) || "";
            // Snapshots only grow; a rewritten part cannot be streamed as a delta.
            if (!text.startsWith(before) || text.length === before.length) return;
            // Separate the text of consecutive model steps like paragraphs.
            const kind = part.thought ? "thought" : "text";
            const separator = !before && this.lastKey?.[kind] && this.lastKey[kind] !== step ? "\n\n" : "";
            this.lastKey = { ...this.lastKey, [kind]: step };
            this.emitted.set(key, text);
            delta.push({ ...part, text: separator + text.slice(before.length) });
        });
        return delta;
    }

    /** The closing chunk of a stream: finish reason and the run's usage. */
    finish() {
        const chunk = {
            candidates: [{ content: { parts: [], role: "model" }, finishReason: "STOP", index: 0 }],
            modelVersion: this.model,
        };
        if (this.usage) chunk.usageMetadata = this.usage;
        return chunk;
    }

    /** The complete response: the model steps' text (and thoughts when requested), in step order. */
    final() {
        const texts = { text: [], thought: [] };
        for (const [, step] of [...this.steps].sort(([a], [b]) => a - b)) {
            const join = kind =>
                step.parts
                    .filter(part => (kind === "thought" ? part.thought : !part.thought) && part.text)
                    .map(part => part.text)
                    .join("");
            for (const kind of ["thought", "text"]) {
                const text = join(kind);
                if (text) texts[kind].push(text);
            }
        }
        const parts = [];
        if (this.includeThoughts && texts.thought.length)
            parts.push({ text: texts.thought.join("\n\n"), thought: true });
        if (texts.text.length) parts.push({ text: texts.text.join("\n\n") });
        const response = {
            candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }],
            modelVersion: this.model,
        };
        if (this.usage) response.usageMetadata = this.usage;
        return response;
    }
}

module.exports = { BuildChatCodec, BuildChatResponse };
