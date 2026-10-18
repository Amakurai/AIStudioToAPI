/* Explicit real-model test: node tests/duplex-live.js --run [--upstream] [--channel=pg] [--model=gemini-3.8-flash] */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Duplex = require("../src/core/DuplexToolTransport");
const { decodeResponse } = require("../scripts/duplex-client");

async function main() {
    const args = process.argv.slice(2);
    const upstream = args.includes("--upstream");
    const toolOutput = args.includes("--tools");
    const model = args.find(arg => arg.startsWith("--model="))?.slice(8) || "gemini-3.8-flash";
    if (!["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"].includes(model))
        throw new Error("Unexpected test model");
    // Playground signs every round in its page, so a multi-segment answer needs more time.
    const channel = args.find(arg => arg.startsWith("--channel="))?.slice(10) || "build";
    if (!["build", "pg"].includes(channel)) throw new Error("Unexpected channel");
    const publicModel = `${channel}-${model}`;
    const timeoutMs = channel === "pg" ? 600000 : 300000;
    const root = path.join(__dirname, "..");
    const env = require("dotenv").parse(fs.readFileSync(path.join(root, ".env")));
    const key = (env.API_KEYS || "123456")
        .split(",")
        .map(s => s.trim())
        .find(Boolean);
    const expected = fs.readFileSync(
        path.join(root, "artifacts/anti-truncation/gemini-3.8-flash-120lines-4096tokens-expected.txt"),
        "utf8"
    );
    const prompt =
        "请逐字复制下面的校验文本，只输出原文。必须从第一条记录完整复制到全文结束标记，保留每一行编号、换行、符号；不要解释，不要用省略号，不要添加代码围栏。\n\n" +
        expected;
    const start = Date.now();
    const rounds = [];
    let text = "",
        finishReason,
        firstOutputMs = null;
    const request = async (endpoint, body, headers = {}) => {
        const response = await fetch("http://127.0.0.1:7860" + endpoint, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
            method: "POST",
            signal: AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - start))),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
        }
        return response;
    };
    console.log(JSON.stringify({ channel, event: "start", expectedCharacters: [...expected].length, model, upstream }));
    if (upstream) {
        const result = await Duplex.generate(
            {
                contents: [{ parts: [{ text: prompt }], role: "user" }],
                generationConfig: { maxOutputTokens: 4096, temperature: 0 },
            },
            async body => {
                const response = await (await request(`/v1beta/models/${publicModel}:generateContent`, body)).json();
                const candidate = response.candidates?.[0];
                const call = candidate?.content?.parts?.find(part => part.functionCall)?.functionCall;
                const info = {
                    blockReason: response.promptFeedback?.blockReason,
                    characters: typeof call?.args?.text === "string" ? [...call.args.text].length : undefined,
                    finishReason: candidate?.finishReason,
                    seq: call?.args?.seq,
                    tool: call?.name,
                };
                rounds.push(info);
                console.log(JSON.stringify({ event: "round", ...info }));
                return response;
            },
            () => {},
            () => {
                firstOutputMs ??= Date.now() - start;
            }
        );
        text = result.candidates[0].content.parts[0].text;
        finishReason = result.candidates[0].finishReason;
    } else {
        const response = await request(
            "/v1/chat/completions",
            {
                max_tokens: 4096,
                messages: [{ content: prompt, role: "user" }],
                model: publicModel + "-抗截断",
                stream: true,
                temperature: 0,
            },
            toolOutput ? { "X-Anti-Truncation-Output": "tools" } : {}
        );
        if (
            response.headers.get("x-anti-truncation-mode") !== "duplex" ||
            response.headers.get("x-anti-truncation-output") !== (toolOutput ? "tools" : "text")
        )
            throw new Error("Deployment did not automatically enable duplex for the alias");
        const decoded = await decodeResponse(response);
        const reader = decoded.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "",
            done = false;
        while (!done) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") {
                    done = true;
                    continue;
                }
                if (!data) continue;
                const event = JSON.parse(data);
                if (event.error) throw new Error(`Stream error ${event.error.code}`);
                const choice = event.choices?.[0];
                if (choice?.delta?.content) {
                    firstOutputMs ??= Date.now() - start;
                    text += choice.delta.content;
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
            }
        }
        if (!done) throw new Error("Missing completion event");
    }
    const hash = s => crypto.createHash("sha256").update(s).digest("hex");
    const summary = {
        activation: "model_suffix",
        actualCharacters: [...text].length,
        actualHash: hash(text),
        channel,
        elapsedMs: Date.now() - start,
        exactMatch: text === expected,
        expectedCharacters: [...expected].length,
        expectedHash: hash(expected),
        finishReason,
        firstOutputMs,
        model,
        rounds,
        timestamp: new Date().toISOString(),
        toolOutput,
        upstream,
    };
    const dir = path.join(root, "artifacts/anti-truncation/duplex");
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${upstream ? "local-upstream" : toolOutput ? "deployed-client" : "deployed-auto"}-${channel === "pg" ? publicModel : model}`;
    fs.writeFileSync(path.join(dir, `${stem}-actual.txt`), text);
    fs.writeFileSync(path.join(dir, `${stem}-summary.json`), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify({ event: "result", ...summary }));
    if (!summary.exactMatch || !["STOP", "stop"].includes(finishReason)) process.exitCode = 1;
}
if (process.argv.includes("--run"))
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
