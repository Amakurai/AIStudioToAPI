const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const FormatConverter = require("../src/core/FormatConverter");
const PlaygroundSettings = require("../src/core/Playground/Settings");
const PlaygroundDiagnostics = require("../src/core/Playground/Diagnostics");
const UsageStatsService = require("../src/core/UsageStatsService");
const { WireCodec } = require("../src/core/Playground/WireCodec");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const model = "pg-gemini-4-argon-预设";
const converter = () => new FormatConverter(logger, { config: {} });
const events = output =>
    output
        .split("\n")
        .filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)));
const response = finishReason => ({
    candidates: [
        {
            content: { parts: [{ functionCall: { args: { text: "partial" }, name: "report" } }], role: "model" },
            finishReason,
        },
    ],
});

test("Chat output limits and stop strings survive conversion to the actual Playground wire request", async () => {
    for (const [limits, expected] of [
        [{ max_completion_tokens: 8192 }, 8192],
        [{ max_completion_tokens: 8192, max_tokens: 2048 }, 8192],
        [{ max_completion_tokens: null, max_tokens: 4096 }, 4096],
        [{ max_tokens: 4096 }, 4096],
        [{}, undefined],
    ]) {
        const { googleRequest } = await converter().translateOpenAIToGoogle({
            messages: [{ content: "Hi", role: "user" }],
            model,
            stop: "END",
            ...limits,
        });
        const wire = WireCodec.encode("gemini-4-argon", googleRequest);
        assert.equal(wire[3][3], expected);
        assert.deepEqual(wire[3][1], ["END"]);
    }
});

test("a token-limited tool reply remains length/max_tokens in both response modes", () => {
    const c = converter();
    for (const [reason, chat, claude] of [
        ["MAX_TOKENS", "length", "max_tokens"],
        ["STOP", "tool_calls", "tool_use"],
    ]) {
        const input = response(reason);
        assert.equal(c.convertGoogleToOpenAINonStream(input, model).choices[0].finish_reason, chat);
        assert.equal(c.convertGoogleToClaudeNonStream(input, model).stop_reason, claude);
        // A separate final chunk must use the same result even when the call arrived earlier.
        const first = response(undefined);
        const last = { candidates: [{ finishReason: reason }] };
        for (const api of ["OpenAI", "Claude"]) {
            const state = {};
            c[`translateGoogleTo${api}Stream`](JSON.stringify(first), model, state);
            const output = events(c[`translateGoogleTo${api}Stream`](JSON.stringify(last), model, state));
            if (api === "OpenAI") assert.equal(output.at(-1).choices[0].finish_reason, chat);
            else assert.equal(output.find(event => event.type === "message_delta").delta.stop_reason, claude);
        }
    }
});

test("upstream content blocks remain content_filter instead of normal stop or tool completion", () => {
    const c = converter();
    for (const reason of ["PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "SAFETY", "RECITATION", "IMAGE_SAFETY"]) {
        for (const parts of [[{ text: "partial response" }], response(reason).candidates[0].content.parts]) {
            const input = { candidates: [{ content: { parts }, finishReason: reason }] };
            assert.equal(c.convertGoogleToOpenAINonStream(input, model).choices[0].finish_reason, "content_filter");
            const output = events(c.translateGoogleToOpenAIStream(JSON.stringify(input), model, {}));
            assert.equal(output.at(-1).choices[0].finish_reason, "content_filter");
        }
    }
});

test("multipart system and developer tool instructions reach the upstream instruction channel unchanged", async () => {
    const { googleRequest } = await converter().translateOpenAIToGoogle({
        messages: [
            {
                content: [
                    { text: "Follow the supplied tools.", type: "text" },
                    { text: "Keep the complete document.", type: "text" },
                ],
                role: "system",
            },
            { content: [{ text: "Use report when requested.", type: "text" }], role: "developer" },
            { content: "Copy this document.", role: "user" },
        ],
        model,
    });
    const wire = WireCodec.encode("gemini-4-argon", googleRequest);
    assert.equal(
        wire[5][0][0][1],
        "Follow the supplied tools.\nKeep the complete document.\nUse report when requested."
    );
    assert.equal(wire[1].length, 1);
    assert.equal(wire[1][0][0][0][1], "Copy this document.");
    assert.doesNotMatch(JSON.stringify(wire), /\[object Object\]/);
});

test("explicit thinking limits survive Chat conversion instead of reverting to Playground defaults", async () => {
    for (const config of [
        { thinkingBudget: 0 },
        { thinking_budget: 512 },
        { thinkingLevel: "LOW" },
        { thinking_level: "MINIMAL" },
    ]) {
        const { googleRequest } = await converter().translateOpenAIToGoogle({
            extra_body: { google: { thinking_config: config } },
            messages: [{ content: "Hi", role: "user" }],
            model,
        });
        const wire = WireCodec.encode("gemini-4-argon", googleRequest);
        assert.equal(wire[3][16][1], config.thinkingBudget ?? config.thinking_budget);
        assert.equal(
            wire[3][16][3] ?? null,
            { LOW: 1, MINIMAL: 4 }[config.thinkingLevel ?? config.thinking_level] ?? null
        );
    }
});

test("explicit empty stop lists override Playground defaults in either casing", t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-stops-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const settings = new PlaygroundSettings({ playgroundSettingsPath: path.join(dir, "settings.json") }, logger);
    settings.values.stopSequences = ["SERVER_STOP"];
    for (const key of ["stopSequences", "stop_sequences"]) {
        const request = { generationConfig: { [key]: [] } };
        settings.apply(request, "gemini-4-argon");
        assert.deepEqual(
            WireCodec.encode("gemini-4-argon", { ...request, contents: [{ parts: [{ text: "Hi" }] }] })[3][1],
            []
        );
    }
    assert.deepEqual(settings.apply({}, "gemini-4-argon").generationConfig.stopSequences, ["SERVER_STOP"]);
});

test("generation diagnostics persist native endings and comparison hashes without private content", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-diagnostics-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const request = {
        contents: [{ parts: [{ text: "private prompt" }] }],
        generationConfig: { maxOutputTokens: 4096, stopSequences: ["private stop"] },
        tools: [
            {
                functionDeclarations: [
                    { description: "private description", name: "report", parameters: { type: "object" } },
                ],
            },
        ],
    };
    const diagnostics = new PlaygroundDiagnostics(request);
    diagnostics.observe(response("MAX_TOKENS"));
    diagnostics.observe({ usageMetadata: { candidatesTokenCount: 4096, promptTokenCount: 100 } });
    const stats = new UsageStatsService({}, logger, dir);
    stats.startRequest("test");
    stats.updateRequest("test", { generation: diagnostics.snapshot() });
    stats.finishRequest("test", { outcome: "success", statusCode: 200 });
    await stats.appendPromise;
    const saved = new UsageStatsService({}, logger, dir).records[0].generation;
    assert.equal(saved.request.maxOutputTokens, 4096);
    assert.equal(saved.request.toolCount, 1);
    assert.equal(saved.response.candidates[0].finishReason, "MAX_TOKENS");
    assert.deepEqual(saved.response.candidates[0].functionNames, ["report"]);
    assert.equal(saved.response.usage.candidatesTokenCount, 4096);
    assert.doesNotMatch(JSON.stringify(saved), /private|partial/);
    assert.equal(new PlaygroundDiagnostics(request).request.toolsHash, saved.request.toolsHash);
    request.tools[0].functionDeclarations[0].description += " changed";
    assert.notEqual(new PlaygroundDiagnostics(request).request.toolsHash, saved.request.toolsHash);
});
