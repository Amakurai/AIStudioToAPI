# 抗截断模型

选择以下模型名即可启用单工具输出包装，无需额外请求头或客户端脚本：

- `build-gemini-3.7-flash-抗截断`
- `build-gemini-3.8-flash-抗截断`
- `build-gemini-4-argon-抗截断`
- `pg-gemini-3.7-flash-抗截断`
- `pg-gemini-3.8-flash-抗截断`
- `pg-gemini-4-argon-抗截断`

`build-` 可以省略，`pg-` 选择 Playground。两条链路互不回退，共用现有登录账号。只有这些精确别名启用此功能，上游收到的是去掉后缀的基础模型名。OpenAI Chat Completions、Responses、Claude Messages 和 Gemini 原生生成接口均支持。

```json
{
  "model": "pg-gemini-4-argon-抗截断",
  "messages": [{ "role": "user", "content": "请完整回答，保持原有格式。" }]
}
```

## 工作方式

1. 保留预设的系统指令与原有对话，在末尾 user 轮次增加一句简短的输出方式提示：通过 `output_content` 提交完整回复，保持原有内容和格式。
2. 只注册一个工具 `output_content`，只接受一个字符串字段 `content`。工具描述不规定标签、段长或字数，不要求段号和完成标记。输出预算、思考配置与采样参数沿用请求。
3. 一次正常上游生成后，将工具的 `content` 直接还原为普通助手正文。无需执行客户端工具，也不把确认结果回传给模型再请求一次。模型直接回复有效纯文本时，同样接收。
4. 不自动分段、续写、去重、缩短段长或修复工具参数。有效正文在上游 `STOP` 时正常完成，在 `MAX_TOKENS` 时按长度限制返回已有内容。无法可靠解析的工具参数、空回复和只有原生推理而没有正文的回复明确返回 502，不重试生成。
5. 完成状态以原生上游字段为准，不根据正文标签或自定义结束词猜测完成。审核拦截保留原生状态，不重试。HTTP 错误沿用已有的账号处理；例如收到可重试的 429/503 后，可在输出前换账号重发同一请求，每个账号只尝试一次。

停止字符串先从上游请求中移除，再对解包后的正文应用，避免工具 JSON 被停止词切坏。正文保留中文、emoji、换行、Markdown、XML、自定义标签和重复文本；只有调用方明确要求的停止字符串可以裁剪它。

历史中的工具调用/工具结果在没有当前客户端工具声明时转成普通文本；历史的原生思考部分移除，文本上的 thought signature 保留。非文本输入、多候选、结构化输出及多模态输出应使用原模型。

## 预设工具和标签

客户端自带工具（例如预设的 `semini_content`）、`toolConfig`、缓存上下文或管理设置中的强制内置工具存在时，别名回退到原模型，由客户端管理工具。日志明确记录 `carries tools or cachedContent; forwarding to the base model without anti-truncation`。两套工具包装不会叠加。

文本中的 `<analysis>`、`<think>`、`<thinking>`、`<正文>` 等标签默认原样保留，不承担协议含义。模型接口原生提供的推理仍转换为各接口的推理字段，与正文标签无关。

原有的标签拆分仅作为独立兼容选项保留：显式设置 `ANTI_TRUNCATION_SPLIT_THINKING=true` 才把开头的 `<think>` 或 `<thinking>` 块拆到推理字段；默认 `false`。该选项不扩充其他预设的标签，也不影响可选工具输出格式。

## Playground 链路

`pg-*-抗截断` 使用同一个输出工具，每次正常请求只签名并生成一次。Playground 没有原生强制函数调用字段，发送 `AUTO`，避免把强制调用文字追加到系统指令；有效纯文本回复仍能正常返回。Build 使用原生工具调用配置。

Playground 的账号选择、限流重试、取消和用量规则保持原有逻辑，与 Build 账号状态隔离。

## 流式和超时

内部上游请求为一次非流式生成。所有客户端都要等到完整、有效的工具参数或纯文本可用之后才收到正文。半截工具 JSON 不提前展示；出错或没有正文时返回普通 HTTP 错误，不先创建一个空的 SSE 回复。

`ANTI_TRUNCATION_STREAMING_MODE` 继续独立于普通模型的 `STREAMING_MODE`：`real` 将解包后的原生推理和正文分别发送为 SSE 增量，`fake` 收到完整回答后一起发送。两者都不进行额外上游生成，也没有逐字生成的保证。

最终结束原因和用量保留上游含义：

| 情况     | OpenAI   | Claude       | Responses    | Gemini       |
| -------- | -------- | ------------ | ------------ | ------------ |
| 正常完成 | `stop`   | `end_turn`   | `completed`  | `STOP`       |
| 输出上限 | `length` | `max_tokens` | `incomplete` | `MAX_TOKENS` |

等待时间取 `FAKE_STREAM_TIMEOUT_MS` 与 `ANTI_TRUNCATION_FIRST_OUTPUT_TIMEOUT_MS`（默认 300000 毫秒）的较小值，包含输出前的账号重试。客户端断开会取消正在运行的上游请求并清理队列。

工具包装改变输出载体，不能突破模型输出上限，也不能保证降低审核拦截或空回概率。单个工具参数也可能被截断；此时明确报错，不猜测补齐残缺 JSON。

## 可选工具格式

默认返回普通正文。自定义 OpenAI 客户端可以使用 `X-Anti-Truncation-Output: tools`，获得一个 `output_content({content})` 的 `tool_calls`，不再返回旧的 `append_output`/`finish_output` 协议。原生推理单独保留。正常完成的结束原因为 `tool_calls`，长度限制仍为 `length`。

`scripts/duplex-client.js` 保留原有文件路径及 `createFetch()` / `decodeResponse()` 接口，解码新版单工具响应。使用旧适配器的客户端需要同步更新；普通正文客户端无需更改。响应头 `X-Anti-Truncation-Mode` 现在为 `tool`。

## 验证和部署

离线回归：

```sh
node --test tests/anti-truncation.test.js tests/anti-truncation-reasoning.test.js tests/model-channel.test.js tests/request-account-retry.test.js tests/review-transport-regression.test.js
```

显式真实模型校验会消耗上游额度：

```sh
node tests/duplex-live.js --run --model=gemini-4-argon --channel=pg
node tests/duplex-live.js --run --model=gemini-4-argon --channel=pg --tools
```

长文本校验默认给足 32000 输出 token，可用 `--max-tokens=` 调整；预算不足时预期可能是长度限制或损坏的工具参数，不再自动续写。旧分段引擎的测试记录不能用于证明新版效果。

源代码修改后需重启服务，容器部署需重建镜像。
