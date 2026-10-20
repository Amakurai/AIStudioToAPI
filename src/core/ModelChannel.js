/**
 * Public model IDs name their upstream channel: `build-<model>` uses the Build App proxy and
 * `pg-<model>` uses Playground. Unprefixed names keep working and use Build.
 */
class ModelChannel {
    static PREFIXES = { build: "build-", playground: "pg-" };

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
