/* Run explicitly: node tests/anti-truncation-live.js --run [--model=gemini-3.7-flash] (or --probe) */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const AntiTruncation = require("../src/core/AntiTruncation");
const FormatConverter = require("../src/core/FormatConverter");

let key;
let testDeadline;
const origin = "http://127.0.0.1:7860";
const outputDir = path.join(__dirname, "..", "artifacts", "anti-truncation");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);

async function request(endpoint, body) {
    const response = await fetch(origin + endpoint, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.max(1, testDeadline ? testDeadline - Date.now() : 300000)),
    });
    const value = await response.json();
    if (!response.ok)
        throw Object.assign(new Error(value.error?.message || `HTTP ${response.status}`), { status: response.status });
    return value;
}

async function main() {
    const env = require("dotenv").parse(fs.readFileSync(path.join(__dirname, "..", ".env")));
    key = (env.API_KEYS || "123456")
        .split(",")
        .map(value => value.trim())
        .find(Boolean);
    const models = await request("/v1/models");
    const available = (models.data || []).map(model => model.id);
    console.log(
        JSON.stringify({ event: "probe", models: available.filter(model => /gemini-3\.[78]-flash/.test(model)) })
    );
    if (args.includes("--probe")) return;
    fs.mkdirSync(outputDir, { recursive: true });
    const model = args.find(arg => arg.startsWith("--model="))?.slice(8) || "gemini-3.8-flash";
    const maxOutputTokens = Number(args.find(arg => arg.startsWith("--tokens="))?.slice(9) || 16384);
    const lineCount = Number(args.find(arg => arg.startsWith("--lines="))?.slice(8) || 120);
    const expected =
        Array.from({ length: lineCount }, (_, index) => {
            const n = String(index + 1).padStart(4, "0");
            return `【记录${n}】山间的清风吹过树林，河水沿着石阶缓缓流动。这一行用于检查长文本中的中文、数字和标点是否完整保留。校验值=${n}; XML=<item>${n}</item>; Markdown=**完整**; emoji=🙂。`;
        }).join("\n") +
        "\n【全文结束-END-" +
        lineCount +
        "】";
    const stem = `${model}-${lineCount}lines-${maxOutputTokens}tokens`;
    fs.writeFileSync(path.join(outputDir, `${stem}-expected.txt`), expected);
    const prompt =
        "请逐字复制下面的校验文本，只输出原文。必须从第一条记录完整复制到全文结束标记，保留每一行编号、换行、符号；不要解释，不要用省略号，不要添加代码围栏。\n\n" +
        expected;
    const start = Date.now();
    testDeadline = start + 300000;
    let round = 0;
    const summary = {
        expectedCharacters: [...expected].length,
        expectedHash: hash(expected),
        lineCount,
        maxOutputTokens,
        model: `${model}-抗截断`,
        rounds: [],
    };
    try {
        const result = await AntiTruncation.generate(
            {
                contents: [{ parts: [{ text: prompt }], role: "user" }],
                generationConfig: { maxOutputTokens, temperature: 0 },
            },
            async body => {
                round++;
                const response = await request(`/v1beta/models/${model}:generateContent`, body);
                const candidate = response.candidates?.[0];
                const call = candidate?.content?.parts?.find(part => part.functionCall)?.functionCall;
                const info = {
                    characters: typeof call?.args?.text === "string" ? [...call.args.text].length : null,
                    done: call?.args?.done,
                    finishReason: candidate?.finishReason,
                    round,
                    toolName: call?.name,
                    usage: Object.fromEntries(
                        ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"]
                            .filter(name => response.usageMetadata?.[name] !== undefined)
                            .map(name => [name, response.usageMetadata[name]])
                    ),
                };
                summary.rounds.push(info);
                fs.writeFileSync(
                    path.join(outputDir, `${stem}-round-${round}.json`),
                    JSON.stringify(response, null, 2)
                );
                console.log(JSON.stringify({ event: "round", ...info }));
                return response;
            }
        );
        const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
        fs.writeFileSync(path.join(outputDir, `${stem}-actual.txt`), text);
        const restored = [
            converter.convertGoogleToOpenAINonStream(result, `${model}-抗截断`).choices[0].message.content,
            converter
                .convertGoogleToResponseAPINonStream(result, `${model}-抗截断`)
                .output.filter(item => item.type === "message")
                .flatMap(item => item.content)
                .map(item => item.text || "")
                .join(""),
            converter
                .convertGoogleToClaudeNonStream(result, `${model}-抗截断`)
                .content.map(part => part.text || "")
                .join(""),
        ];
        const frames = value =>
            value
                .split("\n")
                .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
                .map(line => JSON.parse(line.slice(6)));
        const googleJson = JSON.stringify(result);
        restored.push(
            frames(converter.translateGoogleToOpenAIStream(googleJson, `${model}-抗截断`, {}))
                .map(event => event.choices?.[0]?.delta?.content || "")
                .join(""),
            frames(converter.translateGoogleToResponseAPIStream(googleJson, `${model}-抗截断`, {}))
                .filter(event => event.type === "response.output_text.delta")
                .map(event => event.delta)
                .join(""),
            frames(converter.translateGoogleToClaudeStream(googleJson, `${model}-抗截断`, {}))
                .filter(event => event.type === "content_block_delta" && event.delta?.type === "text_delta")
                .map(event => event.delta.text)
                .join("")
        );
        const numbers = [...text.matchAll(/【记录(\d{4})】/g)].map(match => Number(match[1]));
        Object.assign(summary, {
            actualCharacters: [...text].length,
            actualHash: hash(text),
            duplicateRecords: [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))],
            exactMatch: text === expected,
            finishReason: result.candidates?.[0]?.finishReason,
            formatsPreserveText: restored.every(value => value === text),
            missingRecords: Array.from({ length: lineCount }, (_, i) => i + 1).filter(n => !numbers.includes(n)),
            terminalMarkerPresent: text.includes(`【全文结束-END-${lineCount}】`),
        });
    } catch (error) {
        summary.error = error.message;
        summary.status = error.status;
    }
    summary.elapsedSeconds = Math.round((Date.now() - start) / 1000);
    fs.writeFileSync(path.join(outputDir, `${stem}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ event: "summary", ...summary }));
    if (summary.error) process.exitCode = 1;
}

if (require.main === module && (args.includes("--run") || args.includes("--probe"))) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
