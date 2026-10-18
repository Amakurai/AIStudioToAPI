const fs = require("fs");
const path = require("path");

/**
 * Playground's own model list: `configs/playground-models.json` plus the native catalog the
 * Playground page reports, persisted so a restart lists discovered models without a page load.
 */
class PlaygroundCatalog {
    constructor(config, logger) {
        this.logger = logger;
        this.file = config.playgroundCatalogPath || path.join(process.cwd(), "data", "playground-models.json");
        this.configured = Array.isArray(config.playgroundModelList) ? config.playgroundModelList : [];
        this.discovered = [];
        // The removed automatic router saved the same catalog in model-routes.json (version 2).
        for (const [file, version] of [
            [this.file, 1],
            [path.join(path.dirname(this.file), "model-routes.json"), 2],
        ]) {
            try {
                const saved = JSON.parse(fs.readFileSync(file, "utf8"));
                if (saved.version === version && Array.isArray(saved.models))
                    this.discovered = saved.models.filter(model => PlaygroundCatalog.validName(model?.name));
                break;
            } catch (error) {
                if (error.code !== "ENOENT")
                    logger.warn(`[Playground] Could not load saved model catalog ${file}: ${error.message}`);
            }
        }
    }

    /**
     * Model families whose Playground page this adapter cannot drive (transcription, music,
     * agents). Requests would only time out after minutes while holding the account's Playground
     * page, so they are not listed and are rejected up front.
     */
    static UNSUPPORTED = /-transcribe(?:-|$)|^lyria-|^gemini-omni-|^deep-research-|^antigravity-/;

    /** Speech (TTS) models run on the generate-speech page instead of the chat prompt page. */
    static SPEECH = /(?:^|-)tts(?:-|$)/;

    static isSpeech(model) {
        return PlaygroundCatalog.SPEECH.test(String(model || "").replace(/^models\//, ""));
    }

    /**
     * 3.8 and newer TTS pages are a screenplay of speech blocks: each text part may carry a speaker
     * and a voice style (speech_metadata). 2.5/3.1 pages send one `## Transcript:` text instead.
     */
    static usesSpeechBlocks(model) {
        const name = String(model || "").replace(/^models\//, "");
        return PlaygroundCatalog.isSpeech(name) && !/^gemini-(?:2\.5|3\.1)-/.test(name);
    }

    /** @returns {string|null} Why Playground cannot serve this upstream model, or null. */
    static unsupportedReason(model) {
        const name = String(model || "").replace(/^models\//, "");
        if (!PlaygroundCatalog.UNSUPPORTED.test(name)) return null;
        return `Playground does not support ${name} (transcription, music and agent models use a different page); use build-${name} if it is available.`;
    }

    static validName(name) {
        return typeof name === "string" && /^models\/[a-z0-9._-]+$/.test(name);
    }

    /** Upstream metadata (names keep `models/<model>`); discovered limits override configured ones. */
    models() {
        const merged = new Map(this.configured.map(model => [model.name, { ...model }]));
        for (const model of this.discovered) merged.set(model.name, { ...merged.get(model.name), ...model });
        return [...merged.values()].filter(model => !PlaygroundCatalog.unsupportedReason(model.name));
    }

    discover(raw) {
        const catalog = new Map(this.discovered.map(model => [model.name, model]));
        for (const m of raw?.[0] || []) {
            if (
                !Array.isArray(m) ||
                !PlaygroundCatalog.validName(m[0]) ||
                !Array.isArray(m[7]) ||
                !m[7].includes("generateContent")
            )
                continue;
            catalog.set(m[0], {
                description: m[4] || "",
                displayName: m[3] || m[0],
                inputTokenLimit: m[5],
                name: m[0],
                outputTokenLimit: m[6],
                supportedGenerationMethods: ["generateContent"],
            });
        }
        this.discovered = [...catalog.values()];
        this.save();
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(
                `${this.file}.tmp`,
                JSON.stringify({ models: this.discovered, version: 1 }, null, 2) + "\n"
            );
            fs.renameSync(`${this.file}.tmp`, this.file);
        } catch (error) {
            this.logger.warn(`[Playground] Could not save model catalog: ${error.message}`);
        }
    }
}

module.exports = PlaygroundCatalog;
