const fs = require("fs");
const path = require("path");
const PlaygroundCatalog = require("./Catalog");

const THINKING_LEVELS = ["", "MINIMAL", "LOW", "MEDIUM", "HIGH"];
const MEDIA_RESOLUTIONS = ["", "MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_MEDIUM", "MEDIA_RESOLUTION_HIGH"];
const SAFETY_THRESHOLDS = [
    "",
    "OFF",
    "BLOCK_NONE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_LOW_AND_ABOVE",
    "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
];
const pick = (obj, camel) => obj?.[camel] ?? obj?.[camel.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
const invalid = message => Object.assign(new Error(message), { status: 400 });

/**
 * Run settings for `pg-` models, mirroring the AI Studio "Run settings" panel. They are defaults:
 * a value the client sent explicitly always wins. Tools and the safety threshold replace the
 * global force/safety settings for Playground (see RequestScope); the rest is applied here.
 * Empty values ("" / null / []) leave the model's native default.
 */
class PlaygroundSettings {
    static DEFAULTS = Object.freeze({
        codeExecution: false,
        googleSearch: false,
        maxOutputTokens: null,
        mediaResolution: "",
        safetyThreshold: "",
        stopSequences: [],
        systemInstruction: "",
        thinkingLevel: "MEDIUM",
        urlContext: false,
    });

    constructor(config, logger) {
        this.logger = logger;
        this.file = config.playgroundSettingsPath || path.join(process.cwd(), "data", "playground-settings.json");
        this.values = { ...PlaygroundSettings.DEFAULTS };
        try {
            this.values = PlaygroundSettings.validate({
                ...this.values,
                ...JSON.parse(fs.readFileSync(this.file, "utf8")),
            });
        } catch (error) {
            if (error.code !== "ENOENT")
                logger.warn(`[Playground] Could not load run settings ${this.file}: ${error.message}`);
        }
    }

    static validate(input) {
        const out = {};
        for (const key of ["codeExecution", "googleSearch", "urlContext"]) out[key] = input[key] === true;
        const choose = (key, allowed) => {
            const value = String(input[key] ?? "").toUpperCase();
            if (!allowed.includes(value)) throw invalid(`Invalid ${key}: ${String(input[key]).slice(0, 40)}`);
            out[key] = value;
        };
        choose("thinkingLevel", THINKING_LEVELS);
        choose("mediaResolution", MEDIA_RESOLUTIONS);
        choose("safetyThreshold", SAFETY_THRESHOLDS);
        const max = input.maxOutputTokens;
        if (max === null || max === undefined || max === "" || max === 0) out.maxOutputTokens = null;
        else if (Number.isInteger(Number(max)) && Number(max) > 0 && Number(max) <= 1048576)
            out.maxOutputTokens = Number(max);
        else throw invalid("maxOutputTokens must be an integer between 1 and 1048576");
        if (!Array.isArray(input.stopSequences)) throw invalid("stopSequences must be an array");
        out.stopSequences = [...new Set(input.stopSequences.filter(s => typeof s === "string" && s.length))];
        if (out.stopSequences.length > 5) throw invalid("At most 5 stop sequences are allowed");
        if (typeof input.systemInstruction !== "string") throw invalid("systemInstruction must be a string");
        out.systemInstruction = input.systemInstruction;
        return out;
    }

    get() {
        return { ...this.values, stopSequences: [...this.values.stopSequences] };
    }

    update(patch) {
        const unknown = Object.keys(patch || {}).filter(key => !(key in PlaygroundSettings.DEFAULTS));
        if (unknown.length) throw invalid(`Unknown Playground setting: ${unknown[0]}`);
        this.values = PlaygroundSettings.validate({ ...this.values, ...patch });
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.values, null, 2) + "\n");
        fs.renameSync(`${this.file}.tmp`, this.file);
        return this.get();
    }

    /** Gemini 3 and newer text models take a thinking level; 2.x, image and speech models do not. */
    static supportsThinkingLevel(model) {
        const name = String(model || "").replace(/^models\//, "");
        const major = Number(/^gemini-(\d+)(?:\.\d+)?-/.exec(name)?.[1]);
        return major >= 3 && !/(?:^|-)(?:image|tts|live|audio|embedding)(?:-|$)/.test(name);
    }

    /**
     * Fills unset generation parameters of a Gemini request in place. Anti-truncation rounds
     * only get the thinking level and media resolution: their protocol owns the system
     * instruction, output length and stop sequences.
     */
    apply(request, model, { antiTruncation = false } = {}) {
        if (!request || typeof request !== "object" || PlaygroundCatalog.isSpeech(model)) return request;
        const s = this.values;
        const gcKey = request.generationConfig || !request.generation_config ? "generationConfig" : "generation_config";
        const gc = (request[gcKey] ||= {});
        const thinking = pick(gc, "thinkingConfig");
        if (
            s.thinkingLevel &&
            PlaygroundSettings.supportsThinkingLevel(model) &&
            pick(thinking, "thinkingLevel") == null &&
            pick(thinking, "thinkingBudget") == null
        ) {
            if (thinking) thinking.thinkingLevel = s.thinkingLevel;
            else gc.thinkingConfig = { thinkingLevel: s.thinkingLevel };
        }
        if (s.mediaResolution && pick(gc, "mediaResolution") == null) gc.mediaResolution = s.mediaResolution;
        if (antiTruncation) return request;
        if (s.maxOutputTokens && pick(gc, "maxOutputTokens") == null) gc.maxOutputTokens = s.maxOutputTokens;
        if (s.stopSequences.length && !pick(gc, "stopSequences")?.length) gc.stopSequences = [...s.stopSequences];
        if (s.systemInstruction.trim()) {
            const key =
                request.systemInstruction || !request.system_instruction ? "systemInstruction" : "system_instruction";
            const existing = request[key];
            const content = existing && typeof existing === "object" ? existing : {};
            const parts = Array.isArray(content.parts)
                ? content.parts
                : typeof existing === "string" && existing
                  ? [{ text: existing }]
                  : [];
            request[key] = { ...content, parts: [{ text: s.systemInstruction }, ...parts] };
        }
        return request;
    }
}

module.exports = PlaygroundSettings;
