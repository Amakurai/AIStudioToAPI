/** MakerSuite JSPB protocol adapter. Protocol notes: docs/playground.md. */
const crypto = require("crypto");
const FINISH_REASONS = [
    "FINISH_REASON_UNSPECIFIED",
    "STOP",
    "MAX_TOKENS",
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "OTHER",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "IMAGE_SAFETY",
    "UNEXPECTED_TOOL_CALL",
    "TOO_MANY_TOOL_CALLS",
    "IMAGE_PROHIBITED_CONTENT",
    "NO_IMAGE",
    "IMAGE_RECITATION",
    "IMAGE_OTHER",
];
const compact = value => {
    while (value.length && value.at(-1) == null) value.pop();
    return value;
};
const invalid = message => Object.assign(new Error(`Playground: ${message}`), { retryable: false, status: 400 });
const pick = (obj, camel) => obj?.[camel] ?? obj?.[camel.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];

class WireCodec {
    static value(value) {
        if (value === null) return [0];
        if (typeof value === "number") return [null, value];
        if (typeof value === "string") return [null, null, value];
        if (typeof value === "boolean") return [null, null, null, value];
        if (Array.isArray(value)) return [null, null, null, null, null, [value.map(v => this.value(v))]];
        if (value && typeof value === "object") return [null, null, null, null, this.struct(value)];
        throw invalid("unsupported function argument value");
    }
    static struct(obj) {
        return [Object.entries(obj).map(([k, v]) => [k, this.value(v)])];
    }
    static decodeValue(v) {
        if (!Array.isArray(v)) return v;
        if (v[0] === 0) return null;
        if (v[1] != null) return v[1];
        if (v[2] != null) return v[2];
        if (v[3] != null) return !!v[3];
        if (v[4] != null) return this.decodeStruct(v[4]);
        if (v[5] != null) return (v[5][0] || []).map(x => this.decodeValue(x));
        return null;
    }
    static decodeStruct(v) {
        if (!Array.isArray(v)) return v || {};
        while (v.length === 1 && Array.isArray(v[0]) && typeof v[0][0] !== "string") v = v[0];
        return Object.fromEntries(
            v.filter(p => Array.isArray(p) && typeof p[0] === "string").map(([k, x]) => [k, this.decodeValue(x)])
        );
    }
    static schema(s) {
        if (!s || typeof s !== "object") throw invalid("invalid schema");
        const fields = [
            "type",
            "format",
            "description",
            "nullable",
            "enum",
            "items",
            "properties",
            "required",
            "minProperties",
            "maxProperties",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "pattern",
            "example",
            "oneOf",
            "anyOf",
            "allOf",
            "not",
            "maxItems",
            "minItems",
            "propertyOrdering",
        ];
        const out = [];
        for (const [i, k] of fields.entries()) {
            let v = pick(s, k);
            if (v === undefined) continue;
            if (k === "type") {
                v = { ARRAY: 5, BOOLEAN: 4, INTEGER: 3, NUMBER: 2, OBJECT: 6, STRING: 1 }[String(v).toUpperCase()];
                if (!v) throw invalid("unsupported schema type");
            }
            if (["items", "not"].includes(k)) v = this.schema(v);
            if (["oneOf", "anyOf", "allOf"].includes(k)) v = v.map(x => this.schema(x));
            if (k === "properties") v = Object.entries(v).map(([name, x]) => [name, this.schema(x)]);
            if (k === "example") v = this.value(v);
            out[i] = v;
        }
        if (!out[0] && !out[17]) out[0] = s.properties ? 6 : s.items ? 5 : 1;
        return compact(out);
    }
    static part(p) {
        const out = [];
        if (typeof p.text === "string") out[1] = p.text;
        const inline = pick(p, "inlineData");
        if (inline) out[2] = [pick(inline, "mimeType"), inline.data];
        const file = pick(p, "fileData");
        if (file) out[5] = [pick(file, "fileUri")];
        for (const [key, index, valueKey] of [
            ["functionCall", 10, "args"],
            ["functionResponse", 11, "response"],
        ]) {
            const f = pick(p, key);
            if (f) out[index] = compact([f.name, this.struct(f[valueKey] || {}), f.id]);
        }
        if (p.thought) out[0] = true;
        if (pick(p, "thoughtSignature")) out[14] = pick(p, "thoughtSignature");
        if (pick(p, "executableCode")) out[8] = pick(p, "executableCode").code;
        if (pick(p, "codeExecutionResult")) out[9] = pick(p, "codeExecutionResult").output;
        if (!out.length) throw invalid("unsupported content part");
        return compact(out);
    }
    static content(c) {
        return [c.parts.map(p => this.part(p)), c.role || "user"];
    }
    static encode(model, body) {
        if (!Array.isArray(body.contents) || !body.contents.length) throw invalid("contents must not be empty");
        const gc = pick(body, "generationConfig") || {};
        if (pick(gc, "candidateCount") && pick(gc, "candidateCount") !== 1)
            throw invalid("only one candidate is supported");
        const generation = [];
        for (const [k, i] of Object.entries({
            frequencyPenalty: 10,
            logprobs: 12,
            maxOutputTokens: 3,
            presencePenalty: 9,
            responseLogprobs: 11,
            responseMimeType: 7,
            stopSequences: 1,
            temperature: 4,
            topK: 6,
            topP: 5,
        })) {
            const value = pick(gc, k);
            if (value !== undefined) generation[i] = value;
        }
        const schema = pick(gc, "responseSchema") || pick(gc, "responseJsonSchema") || gc.responseFormat?.text?.schema;
        if (schema) generation[8] = this.schema(schema);
        if (gc.responseFormat?.text?.mimeType)
            generation[7] = gc.responseFormat.text.mimeType
                .toLowerCase()
                .replace("application_json", "application/json");
        const thinking = pick(gc, "thinkingConfig");
        if (thinking) {
            const level = pick(thinking, "thinkingLevel");
            generation[16] = compact([
                pick(thinking, "includeThoughts") === false ? 0 : 1,
                pick(thinking, "thinkingBudget"),
                null,
                level ? { HIGH: 3, LOW: 1, MEDIUM: 2, MINIMAL: 4 }[String(level).toUpperCase()] : null,
            ]);
        }
        if (gc.responseModalities)
            generation[14] = gc.responseModalities.map(m => ({ AUDIO: 3, IMAGE: 2, TEXT: 1 })[m]);
        if (gc.imageConfig) generation[26] = [gc.imageConfig.aspectRatio || null, gc.imageConfig.imageSize || null];
        if (gc.mediaResolution)
            generation[17] = { MEDIA_RESOLUTION_HIGH: 3, MEDIA_RESOLUTION_LOW: 1, MEDIA_RESOLUTION_MEDIUM: 2 }[
                gc.mediaResolution
            ];
        const tools = [];
        const fc = pick(pick(body, "toolConfig"), "functionCallingConfig") || {};
        for (const tool of body.tools || []) {
            const functions = pick(tool, "functionDeclarations");
            if (functions && fc.mode !== "NONE") {
                const allowed = pick(fc, "allowedFunctionNames");
                const declarations = functions
                    .filter(f => !allowed?.length || allowed.includes(f.name))
                    .map(f =>
                        compact([
                            f.name,
                            f.description || null,
                            f.parameters || f.parametersJsonSchema
                                ? this.schema(f.parameters || f.parametersJsonSchema)
                                : null,
                        ])
                    );
                if (declarations.length) tools.push([null, declarations]);
            }
            if (pick(tool, "codeExecution")) tools.push([[]]);
            if (pick(tool, "googleSearch")) tools.push([null, null, null, [null, [[]]]]);
            if (pick(tool, "urlContext")) tools.push([null, null, null, null, null, null, null, []]);
            if (pick(tool, "googleMaps")) tools.push([null, null, null, null, null, null, null, null, null, null, []]);
            if (!functions && !["codeExecution", "googleSearch", "urlContext", "googleMaps"].some(k => pick(tool, k)))
                throw invalid("unsupported tool type");
        }
        const categories = {
            HARM_CATEGORY_DANGEROUS_CONTENT: 10,
            HARM_CATEGORY_HARASSMENT: 7,
            HARM_CATEGORY_HATE_SPEECH: 8,
            HARM_CATEGORY_SEXUALLY_EXPLICIT: 9,
        };
        const thresholds = {
            BLOCK_LOW_AND_ABOVE: 1,
            BLOCK_MEDIUM_AND_ABOVE: 2,
            BLOCK_NONE: 4,
            BLOCK_ONLY_HIGH: 3,
            HARM_BLOCK_THRESHOLD_UNSPECIFIED: 0,
            OFF: 5,
        };
        const safety = (pick(body, "safetySettings") || []).map(s => {
            if (!(s.category in categories) || !(s.threshold in thresholds))
                throw invalid("unsupported safety setting");
            return [null, null, categories[s.category], thresholds[s.threshold]];
        });
        const out = [];
        out[0] = `models/${model.replace(/^models\//, "")}`;
        out[1] = body.contents.map(c => this.content(c));
        out[2] = safety.length ? safety : null;
        out[3] = compact(generation);
        out[5] = pick(body, "systemInstruction") ? this.content(pick(body, "systemInstruction")) : null;
        if (fc.mode === "ANY" && tools.some(t => t[1]?.length)) {
            out[5] ||= [[], "user"];
            out[5][0].push([null, "Respond using one of the provided functions."]);
        }
        out[6] = tools.length ? tools : null;
        out[10] = 1;
        out[11] = pick(body, "cachedContent") || null;
        out[13] = [[null, null, "UTC"]];
        return out;
    }
    static hash(wire) {
        const parts = wire[1].flatMap(c => c[0].map(p => p[1] ?? p[2]?.[1] ?? p[5]?.[0] ?? p[8] ?? p[9] ?? ""));
        return crypto.createHash("sha256").update(parts.join(" ")).digest("hex");
    }
    static decodePart(p) {
        const out = {};
        if (typeof p[1] === "string") out.text = p[1];
        if (p[0] === true || p[0] === 1 || p[10] === true || p[12] === 1) out.thought = true;
        if (Array.isArray(p[2])) out.inlineData = { data: p[2][1], mimeType: p[2][0] };
        for (const [key, index, alt, args] of [
            ["functionCall", 3, 10, "args"],
            ["functionResponse", 4, 11, "response"],
        ]) {
            const f = Array.isArray(p[index]) ? p[index] : Array.isArray(p[alt]) ? p[alt] : null;
            if (f && typeof f[0] === "string")
                out[key] = { [args]: this.decodeStruct(f[1]), name: f[0], ...(f[2] ? { id: f[2] } : {}) };
        }
        if (typeof p[14] === "string") out.thoughtSignature = p[14];
        if (typeof p[8] === "string") out.executableCode = { code: p[8], language: "PYTHON" };
        if (typeof p[9] === "string") out.codeExecutionResult = { outcome: "OUTCOME_OK", output: p[9] };
        return out;
    }
    static decode(chunk, model) {
        if (!Array.isArray(chunk)) throw new Error("Invalid Playground response chunk");
        const result = { modelVersion: model };
        if (Array.isArray(chunk[0]))
            result.candidates = chunk[0].map((c, index) => {
                const out = { index };
                if (Array.isArray(c[0]?.[0]))
                    out.content = { parts: c[0][0].map(p => this.decodePart(p)), role: c[0][1] || "model" };
                if (c[1]) out.finishReason = FINISH_REASONS[c[1]] || "OTHER";
                if (typeof c[3] === "string") out.finishMessage = c[3];
                return out;
            });
        if (Array.isArray(chunk[2])) {
            const u = chunk[2];
            result.usageMetadata = {
                cachedContentTokenCount: u[3] || 0,
                candidatesTokenCount: u[1] || 0,
                promptTokenCount: u[0] || 0,
                thoughtsTokenCount: u[9] || 0,
                totalTokenCount: u[2] || 0,
            };
        }
        if (chunk[7]) result.responseId = chunk[7];
        // Prompt blocks have no candidate. Preserve the block rather than inventing a normal completion.
        if (Array.isArray(chunk[1]) && chunk[1][0])
            result.promptFeedback = {
                blockReason:
                    { 1: "SAFETY", 2: "OTHER", 3: "BLOCKLIST", 4: "PROHIBITED_CONTENT" }[chunk[1][0]] || "OTHER",
            };
        return result;
    }
    static merge(target, chunk) {
        for (const [k, v] of Object.entries(chunk)) if (k !== "candidates") target[k] = v;
        for (const c of chunk.candidates || []) {
            target.candidates ||= [];
            let dest = target.candidates.find(x => x.index === c.index);
            if (!dest) {
                dest = { content: { parts: [], role: "model" }, index: c.index };
                target.candidates.push(dest);
            }
            for (const [k, v] of Object.entries(c)) if (k !== "content") dest[k] = v;
            dest.content.parts.push(...(c.content?.parts || []));
        }
        return target;
    }
}

class WireStream {
    constructor(onChunk) {
        this.onChunk = onChunk;
        this.depth = 0;
        this.string = false;
        this.escape = false;
        this.buffer = "";
        this.started = false;
        this.count = 0;
    }
    feed(text) {
        for (const c of text) {
            if (!this.started) {
                if (c !== "[") continue;
                this.started = true;
            }
            if (this.depth >= 3) this.buffer += c;
            if (this.escape) {
                this.escape = false;
                continue;
            }
            if (this.string && c === "\\") {
                this.escape = true;
                continue;
            }
            if (c === '"') {
                this.string = !this.string;
                continue;
            }
            if (this.string) continue;
            if (c === "[") {
                this.depth++;
                if (this.depth === 3) this.buffer = "[";
            }
            if (c === "]") {
                this.depth--;
                if (this.depth === 2) {
                    const value = JSON.parse(this.buffer);
                    this.buffer = "";
                    this.count++;
                    this.onChunk(value);
                }
            }
        }
    }
    finish() {
        if (!this.started || this.depth !== 0 || this.string || !this.count)
            throw Object.assign(new Error("Playground response was truncated or empty"), {
                retryable: false,
                status: 502,
            });
    }
}
module.exports = { WireCodec, WireStream };
