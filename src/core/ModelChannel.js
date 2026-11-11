/**
 * Public model IDs name their upstream channel: `build-<model>` uses the Build App proxy and
 * `pg-<model>` uses Playground. Unprefixed names keep working and use Build.
 */
class ModelChannel {
    static PREFIXES = { build: "build-", playground: "pg-" };
    static PRESET_SUFFIX = "-预设";

    /** The Playground model selected by a preset alias, or null for ordinary model IDs. */
    static playgroundPreset(name) {
        let value = String(name ?? "");
        try {
            value = decodeURIComponent(value);
        } catch {
            // Keep malformed escapes for the normal request validation.
        }
        const { channel, model } = this.parse(value);
        return channel === "playground" &&
            model.endsWith(this.PRESET_SUFFIX) &&
            model.length > this.PRESET_SUFFIX.length
            ? model.slice(0, -this.PRESET_SUFFIX.length)
            : null;
    }

    /**
     * @param {string} name - Model ID, optionally with a `models/` prefix (raw or URL-encoded).
     * @returns {{ channel: "build"|"playground", model: string, prefixed: boolean }}
     */
    static parse(name) {
        const value = String(name ?? "").replace(/^models\//, "");
        for (const [channel, prefix] of Object.entries(this.PREFIXES)) {
            if (value.startsWith(prefix) && value.length > prefix.length)
                return { channel, model: value.slice(prefix.length), prefixed: true };
        }
        return { channel: "build", model: value, prefixed: false };
    }

    /** @param {"build"|"playground"} channel @param {string} model - Upstream name, with or without `models/`. */
    static publicName(channel, model) {
        return `${this.PREFIXES[channel]}${String(model).replace(/^models\//, "")}`;
    }
}

module.exports = ModelChannel;
