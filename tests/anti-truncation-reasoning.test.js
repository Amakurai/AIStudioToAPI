const test = require("node:test");
const assert = require("node:assert/strict");
const ReasoningSplitter = require("../src/core/ReasoningSplitter");

// The reported SillyTavern leak: the model quotes the output format inside its own thinking.
const LEAKED = [
    "<thinking>",
    "Phase 1: 规划输出",
    "1. `<thinking>...</thinking>` 工作日志（开头）",
    "2. `<content>...</content>` 正文（包含时间框）",
    "Phase: 思考结束",
    "我已思考完毕。——宣誓人YU",
    "</thinking>",
    "",
    "〖2026.05.27 周三 17:16p.m〗",
    "红底金线的和服领口松开了小半寸。",
].join("\n");

// Joins streamed pieces by kind, as a client would show them.
const joined = pieces => ({
    answer: pieces
        .filter(piece => !piece.thought)
        .map(piece => piece.text)
        .join(""),
    reasoning: pieces
        .filter(piece => piece.thought)
        .map(piece => piece.text)
        .join(""),
});

test("a closing tag quoted inside the thinking does not end the reasoning block", () => {
    const split = ReasoningSplitter.split(LEAKED);
    assert.equal(split.answer, "〖2026.05.27 周三 17:16p.m〗\n红底金线的和服领口松开了小半寸。");
    assert.ok(split.reasoning.startsWith("Phase 1: 规划输出\n"));
    assert.ok(split.reasoning.includes("`<thinking>...</thinking>` 工作日志（开头）"));
    assert.ok(split.reasoning.endsWith("——宣誓人YU\n"));
    assert.doesNotMatch(split.answer, /thinking|宣誓人/);
});

test("quoted mentions are recognised by a same-line opening tag or a preceding backtick", () => {
    for (const [text, reasoning, answer] of [
        // A tag pair on one line, without backticks.
        [
            "<thinking>格式：<thinking>思考</thinking>后接正文\n结束</thinking>正文",
            "格式：<thinking>思考</thinking>后接正文\n结束",
            "正文",
        ],
        // A closing tag quoted on its own.
        ["<thinking>用`</thinking>`结束思考\n好</thinking>\n\n正文", "用`</thinking>`结束思考\n好", "正文"],
        // An opening tag mentioned on an earlier line does not swallow the real close.
        ["<thinking>先写<thinking>标签\n想好了\n</thinking>\n正文", "先写<thinking>标签\n想好了\n", "正文"],
        // The <think> spelling, on the same line as the block itself.
        ["  \n<think>短思考</think>答案</thinking>", "短思考", "答案</thinking>"],
        // Only the leading block is reasoning; later tags are answer text.
        ["<thinking>a</thinking>\n正文里提到<thinking>标签", "a", "正文里提到<thinking>标签"],
    ]) {
        assert.deepEqual(ReasoningSplitter.split(text), { answer, reasoning }, text);
    }
});

test("replies without a leading block stay byte-for-byte; an unclosed block is all reasoning", () => {
    for (const text of ["\n  正文<thinking>x</thinking>", "<thinkingx>正文", "正文", "", "  ", "<thi"]) {
        assert.equal(ReasoningSplitter.split(text), null, text);
        const splitter = new ReasoningSplitter();
        assert.equal(
            [...splitter.push(text.slice(0, 2)), ...splitter.push(text.slice(2), true)].map(p => p.text).join(""),
            text
        );
    }
    assert.deepEqual(ReasoningSplitter.split("<thinking>\n还没想完"), { answer: "", reasoning: "还没想完" });
});

test("streamed pieces match the complete split for every chunk boundary", () => {
    const texts = [
        LEAKED,
        "<think>想</think>答",
        "<thinking>用`</thinking>`结束\n</thinking>\n\n 正文 🙂",
        "<thinking>未闭合</thi",
        "plain 🙂 text",
    ];
    for (const text of texts) {
        const expected = ReasoningSplitter.split(text) ?? { answer: text, reasoning: "" };
        for (let a = 0; a <= text.length; a++) {
            for (const b of [a, Math.min(text.length, a + 1), Math.min(text.length, a + 7)]) {
                const splitter = new ReasoningSplitter();
                const pieces = [
                    ...splitter.push(text.slice(0, a)),
                    ...splitter.push(text.slice(a, b)),
                    ...splitter.push(text.slice(b), true),
                ];
                assert.deepEqual(joined(pieces), expected, `${JSON.stringify(text)} split at ${a}/${b}`);
                // Reasoning never follows answer text.
                const firstAnswer = pieces.findIndex(piece => !piece.thought);
                assert.ok(firstAnswer < 0 || pieces.slice(firstAnswer).every(piece => !piece.thought));
            }
        }
    }
});

test("a partial closing tag is held back until it can be decided", () => {
    const splitter = new ReasoningSplitter();
    assert.deepEqual(splitter.push("<thinking>想法</thi"), [{ text: "想法", thought: true }]);
    assert.deepEqual(splitter.push("nking>正文"), [{ text: "正文" }]);
    const pending = new ReasoningSplitter();
    assert.deepEqual(pending.push(" <thin"), []);
    assert.deepEqual(pending.push("king>"), []);
    assert.deepEqual(pending.push("想"), [{ text: "想", thought: true }]);
});
