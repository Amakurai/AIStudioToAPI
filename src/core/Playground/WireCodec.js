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
const SCHEMA_TYPES = { ARRAY: 5, BOOLEAN: 4, INTEGER: 3, NUMBER: 2, OBJECT: 6, STRING: 1 };
// The native signer hashes text after the browser textarea normalizes line breaks.
const normalizeText = value => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value);
const enumType = value => {
    if (value === null) return "NULL";
    if (typeof value === "string") return "STRING";
    if (typeof value === "boolean") return "BOOLEAN";
    if (Number.isInteger(value)) return "INTEGER";
    if (typeof value === "number") return "NUMBER";
    return null;
};

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
    static schema(s, path = "$", depth = 0) {
        const fail = (message, field = "") => invalid(`${message} at ${path}${field}`);
        if (depth > 64) throw fail("schema nesting exceeds 64 levels");
        if (!s || typeof s !== "object" || Array.isArray(s)) throw fail("invalid schema: expected an object");
        const child = (value, suffix) => this.schema(value, `${path}${suffix}`, depth + 1);
        if (pick(s, "const") !== undefined && pick(s, "enum") === undefined) s = { ...s, enum: [pick(s, "const")] };
        if (s.type === undefined && !["oneOf", "anyOf", "allOf", "not"].some(k => pick(s, k) !== undefined)) {
            // JSON Schema allows typeless schemas. Infer their type instead of narrowing them to strings.
            const types = this.inferTypes(s);
            s = { ...s, type: types.length === 1 ? types[0] : types };
        }
        let union;
        if (s.type !== undefined) {
            const types = Array.isArray(s.type) ? s.type : [s.type];
            if (!types.length) throw fail("schema type array must not be empty", ".type");
            for (const [i, type] of types.entries()) {
                if (typeof type !== "string" || !(type.toUpperCase() in SCHEMA_TYPES || type.toUpperCase() === "NULL"))
                    throw fail(
                        `unsupported schema type ${String(JSON.stringify(type)).slice(0, 80)}`,
                        `.type${Array.isArray(s.type) ? `[${i}]` : ""}`
                    );
            }
            const unique = [...new Set(types.map(type => type.toUpperCase()))];
            if (s.nullable === true && !unique.includes("NULL")) unique.push("NULL");
            const nonNull = unique.filter(type => type !== "NULL");
            if (nonNull.length === 1) {
                s = { ...s, type: nonNull[0] };
                if (unique.includes("NULL")) s.nullable = true;
            } else if (!nonNull.length) {
                // MakerSuite has no NULL type enum. A nullable string excluding all
                // strings expresses null without widening the accepted values.
                s = { ...s, nullable: true, type: "STRING" };
                const excludeString = { type: "STRING" };
                if (pick(s, "not") !== undefined) {
                    const allOf = pick(s, "allOf") ?? [];
                    if (!Array.isArray(allOf)) throw fail("expected an array of schemas", ".allOf");
                    s.allOf = [...allOf, { not: excludeString }];
                } else s.not = excludeString;
            } else {
                // Encode shared constraints once so nested unions do not expand
                // exponentially. Intersect with an existing anyOf below.
                union = unique.map(type => child({ type }, ".type"));
                s = { ...s };
                delete s.type;
            }
        }
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
                v = SCHEMA_TYPES[v];
            }
            if (["items", "not"].includes(k)) v = child(v, `.${k}`);
            if (["oneOf", "anyOf", "allOf"].includes(k)) {
                if (!Array.isArray(v) || !v.length) throw fail("expected a non-empty array of schemas", `.${k}`);
                v = v.map((x, index) => child(x, `.${k}[${index}]`));
            }
            if (k === "properties") {
                if (!v || typeof v !== "object" || Array.isArray(v))
                    throw fail("expected an object of property schemas", ".properties");
                v = Object.entries(v).map(([name, x]) => [name, child(x, `.properties[${JSON.stringify(name)}]`)]);
            }
            if (k === "example") v = this.value(v);
            if (k === "enum") {
                if (!Array.isArray(v)) throw fail("expected an array of values", ".enum");
                // Native enum values are strings; null membership is expressed by nullable.
                if (v.includes(null)) out[3] = true;
                v = v.filter(x => x !== null).map(x => (typeof x === "string" ? x : JSON.stringify(x)));
                if (!v.length) continue;
            }
            out[i] = v;
        }
        if (union) {
            if (out[17]) {
                const typeConstraint = [];
                typeConstraint[17] = union;
                out[18] = [...(out[18] || []), typeConstraint];
            } else out[17] = union;
        }
        if (!out[0] && ![16, 17, 18, 19].some(index => out[index])) out[0] = s.properties ? 6 : s.items ? 5 : 1;
        return compact(out);
    }
    static inferTypes(s) {
        const has = (...keys) => keys.some(k => pick(s, k) !== undefined);
        if (has("properties", "required", "minProperties", "maxProperties", "propertyOrdering")) return ["OBJECT"];
        if (has("items", "minItems", "maxItems")) return ["ARRAY"];
        const values = pick(s, "enum");
        if (Array.isArray(values) && values.length) {
            const types = [...new Set(values.map(enumType))];
            if (types.includes(null)) throw invalid("unsupported enum value");
            // An integer is also a number; keep the wider type once.
            return types.includes("NUMBER") ? types.filter(type => type !== "INTEGER") : types;
        }
        if (has("minLength", "maxLength", "pattern")) return ["STRING"];
        if (has("minimum", "maximum")) return ["NUMBER"];
        // An unconstrained value. MakerSuite rejects incomplete OBJECT/ARRAY schemas, so this
        // accepts every scalar and null rather than restricting the value to a string.
        return ["STRING", "NUMBER", "BOOLEAN", "NULL"];
    }
    static part(p, where = "part") {
        if (!p || typeof p !== "object" || Array.isArray(p)) throw invalid(`unsupported content part at ${where}`);
        const out = [];
        if (typeof p.text === "string") out[1] = normalizeText(p.text);
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
        if (pick(p, "executableCode")) out[8] = normalizeText(pick(p, "executableCode").code);
        if (pick(p, "codeExecutionResult")) out[9] = normalizeText(pick(p, "codeExecutionResult").output);
        if (!out.length) throw invalid(`unsupported content part at ${where}`);
        return compact(out);
    }
    static content(c, where = "contents") {
        if (!c || typeof c !== "object" || !Array.isArray(c.parts)) throw invalid(`${where}.parts must be an array`);
        return [c.parts.map((p, i) => this.part(p, `${where}.parts[${i}]`)), c.role || "user"];
    }
    static encode(model, body) {
        try {
            return this._encode(model, body);
        } catch (error) {
            // A malformed client request is a 400, never an upstream failure that cools down the account.
            if (error.status) throw error;
            throw invalid(`malformed request: ${error.message}`);
        }
    }
    static _encode(model, body) {
        if (!body || typeof body !== "object") throw invalid("request body must be an object");
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
        const responseSchemas = [
            ["responseSchema", pick(gc, "responseSchema")],
            ["responseJsonSchema", pick(gc, "responseJsonSchema")],
            ["responseFormat.text.schema", pick(gc, "responseFormat")?.text?.schema],
        ];
        const responseSchema = responseSchemas.find(([, schema]) => schema !== undefined);
        if (responseSchema) generation[8] = this.schema(responseSchema[1], `generationConfig.${responseSchema[0]}`);
        const formatMimeType = pick(pick(gc, "responseFormat")?.text, "mimeType");
        if (formatMimeType)
            generation[7] = String(formatMimeType).toLowerCase().replace("application_json", "application/json");
        const thinking = pick(gc, "thinkingConfig");
        if (thinking) {
            const level = pick(thinking, "thinkingLevel");
            generation[16] = compact([
                // Gemini API default: thoughts are omitted unless explicitly requested.
                pick(thinking, "includeThoughts") === true ? 1 : 0,
                pick(thinking, "thinkingBudget"),
                null,
                level ? { HIGH: 3, LOW: 1, MEDIUM: 2, MINIMAL: 4 }[String(level).toUpperCase()] : null,
            ]);
        }
        const modalities = pick(gc, "responseModalities");
        if (modalities) {
            if (!Array.isArray(modalities)) throw invalid("responseModalities must be an array");
            generation[14] = modalities.map(m => {
                const value = { AUDIO: 3, IMAGE: 2, TEXT: 1 }[String(m).toUpperCase()];
                if (!value) throw invalid(`unsupported response modality ${String(m).slice(0, 40)}`);
                return value;
            });
        }
        const imageConfig = pick(gc, "imageConfig");
        if (imageConfig)
            generation[26] = [pick(imageConfig, "aspectRatio") || null, pick(imageConfig, "imageSize") || null];
        const mediaResolution = pick(gc, "mediaResolution");
        if (mediaResolution)
            generation[17] = { MEDIA_RESOLUTION_HIGH: 3, MEDIA_RESOLUTION_LOW: 1, MEDIA_RESOLUTION_MEDIUM: 2 }[
                mediaResolution
            ];
        const tools = [];
        const fc = pick(pick(body, "toolConfig"), "functionCallingConfig") || {};
        for (const [toolIndex, tool] of (body.tools || []).entries()) {
            const functions = pick(tool, "functionDeclarations");
            if (functions && fc.mode !== "NONE") {
                const allowed = pick(fc, "allowedFunctionNames");
                const declarations = functions.flatMap((f, index) => {
                    if (allowed?.length && !allowed.includes(f.name)) return [];
                    const parameters = pick(f, "parameters") ?? pick(f, "parametersJsonSchema");
                    const field = pick(f, "parameters") !== undefined ? "parameters" : "parametersJsonSchema";
                    return [
                        compact([
                            f.name,
                            f.description || null,
                            parameters === undefined
                                ? null
                                : this.schema(
                                      parameters,
                                      `tools[${toolIndex}].functionDeclarations[${index}].${field}`
                                  ),
                        ]),
                    ];
                });
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
        const safety = (pick(body, "safetySettings") || []).flatMap(s => {
            if (!(s?.threshold in thresholds)) throw invalid("unsupported safety setting");
            if (s.category in categories) return [[null, null, categories[s.category], thresholds[s.threshold]]];
            // Build accepts newer public categories (e.g. CIVIC_INTEGRITY) that MakerSuite does
            // not expose. Leave them at their native default instead of rejecting the request.
            if (/^HARM_CATEGORY_[A-Z_]+$/.test(s.category)) return [];
            throw invalid("unsupported safety setting");
        });
        const out = [];
        out[0] = `models/${model.replace(/^models\//, "")}`;
        out[1] = body.contents.map((c, i) => this.content(c, `contents[${i}]`));
        out[2] = safety.length ? safety : null;
        out[3] = compact(generation);
        out[5] = pick(body, "systemInstruction")
            ? this.content(pick(body, "systemInstruction"), "systemInstruction")
            : null;
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
