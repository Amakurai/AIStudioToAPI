# 抗截断模型

**只需选择下列模型名，即自动启用工具输出抗截断。无需额外请求头、客户端脚本或配置开关。**

- `build-gemini-3.7-flash-抗截断`
- `build-gemini-3.8-flash-抗截断`
- `build-gemini-4-argon-抗截断`

抗截断只属于 Build 链路，`build-` 前缀可省略；Playground 的 `pg-` 模型不提供抗截断，请求会返回 400。

仅这三个精确别名启用；原模型及其他模型保持原有行为。请求头不能给其他模型开启此功能。模型列表会显示这三个别名，网关请求上游时自动去掉后缀。中文原生接口路径可以使用 URL 编码；不与搜索、代码执行、思考等级等其他模型后缀组合。

```json
{
  "model": "gemini-3.8-flash-抗截断",
  "messages": [{ "role": "user", "content": "请完整输出这篇文章。" }],
  "max_tokens": 4096,
  "stream": true
}
```

OpenAI Chat Completions、Responses、Claude Messages 和 Gemini 原生生成接口均自动使用同一套分段工具输出协议，返回各接口的普通助手正文，客户端无需执行内部工具。Gemini 原生接口使用路径中的模型别名；其他接口使用请求里的 `model`。

普通 Argon 使用 `build-gemini-4-argon`（Build）或 `pg-gemini-4-argon`（Playground），同样支持思考等级、流式模式和内置工具后缀（例如 `gemini-4-argon-high-fake-search`）。OpenAI、Responses、Claude 转换后的对话若以模型回复或工具结果结尾，会沿用 3.7/3.8 的规则补一个最小 user 轮次。抗截断别名也保留该处理。

Argon 的模型 ID 来自 AI Studio 界面；模型列表暂不填未经确认的 token 上限及采样默认值。实际可用性和工具协议支持仍需通过有权限的上游账号验证。

## 工作方式

1. 原始文本对话直接作为上游对话发送，保留 user/model 角色和 system 指令优先级。不再调用 `read_input`，也不生成任务 ID。
2. 模型通过 `append_output(seq, text, done)` 按顺序交付正文。序号从 1 开始；未完成时，网关确认收到后才继续。相同序号和相同内容不会重复拼接；缺号、同号不同内容等进入有限修复。
3. 最后一个新分段可通过 `done: true` 同时确认全文完成，且该轮上游必须正常 `STOP`。能在一段内完成的回答只需一次上游调用。以下写法与 `finish_output(last_seq)` 等价，也视为完成：下一序号的空文本加 `done: true`，或原样重发最后一个已确认分段并加 `done: true`。空回答可用 `finish_output(0)` 或 `append_output(1, "", true)`。没有有效完成确认时保留已收到的正文，并标记未完成，不伪装成完整回答。`MAX_TOKENS` 不会因为 `done: true` 被当成正常完成。
4. 已确认至少一段后，若后续某轮上游出错（HTTP 错误、单轮超时、返回无效 JSON 等），不再丢弃前文，也不整单重放：直接返回已确认的正文并标记未完成（OpenAI `length`、Claude `max_tokens`、Responses `incomplete`、Gemini `MAX_TOKENS`），错误原因写入日志。第一段尚未确认时出错，仍按原有策略返回错误或重试。

历史中的模型思考内容（如 Claude 回传的 thinking 块，转换后为 `thought: true` 的部分）会在发送前移除，不再导致多轮请求被拒；文本部分上的 `thoughtSignature` 原样保留。只含思考内容的模型轮次整轮移除。

工具历史保留真实调用 ID、完整模型回复和 thought signature，参见 [Gemini 官方说明](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。不建立全局任务读取接口，不支持跨请求或断线后的会话恢复。

## 流式输出与限制

- **OpenAI Chat Completions**：使用独立的 `ANTI_TRUNCATION_STREAMING_MODE`（默认 `real`），不受普通模型 `STREAMING_MODE` 影响。`real` 模式在收到完整、有效的正文分段时立即返回；粒度是已确认分段，不是半截工具参数的字符流。单段回答可能一次返回，看起来没有逐字输出。`fake` 模式先收齐所有分段，再以短间隔分块发送 SSE 正文，呈现逐步显示效果。两种模式均在参数验证通过后立即发送 SSE 响应头和助手起始帧，再等待后端就绪与生成；内部上游请求均为非流式，等待期间每 10 秒发送 SSE 心跳。
- **Responses、Claude、Gemini 原生接口**：使用同样的内部工具协议，当前仍先缓冲整次结果，再转换成对应的流式或普通响应格式。
- OpenAI 起始时连续发送助手角色帧和空内容帧，兼容 `new-api` 等暂存最后一帧的中转，避免起始帧被扣到后续心跳或正文到达。两帧均不包含正文；假流仍在生成完成后才发送正文。
- 多层 Nginx/OpenResty 代理还需透传 `X-Accel-Buffering` 响应头，否则公网层可能重新缓冲起始帧和心跳。配置与公网验证方法见 [Nginx 多层代理配置](zh/nginx-setup.md#-多层代理配置)。
- 无论输出预算多少，最多接受 8 段；使用独立完成确认时额外占一轮，另有最多 2 次协议修复。每段字符上限为单次输出预算（`max_tokens` / `maxOutputTokens`）的 75%，并先扣除显式的 `thinkingBudget`，范围 64–12000；未设置预算时为 12000。总容量随预算单调增加，调大预算不会减少可输出长度。格式错误或被截断的工具调用会在修复时把上限减半。
- 每次内部上游调用分别受 `FAKE_STREAM_TIMEOUT_MS` 限制。单轮超时只结束该轮，已确认正文按未完成返回，整次回答可能超过该时长；重复确认仍受总轮次限制。客户端或中间代理自身的绝对超时仍可能提前结束请求。
- 每次被拒的工具调用都会以 `[AntiTruncation] <请求 ID>: rejected transport call: <原因>` 记录警告；修复轮与正常续写分别记录为 `Retrying rejected transport call` 和 `Requesting next segment`。
- 所有内部调用计入配额和用量；父请求与内部子请求不重复计算为用户并发。客户端断开会取消内部请求并清理队列。
- 停止字符串支持字符串或数组，在正文上处理，支持跨段匹配。中文、emoji、换行、Markdown、XML 和转义字符原样保留。
- 停止词检查只扫描新增正文及可能跨段匹配的前缀重叠区域，避免每轮重复扫描整篇文章。完成时会交付暂存但未构成停止词的尾部文本。
- 未完成时返回相应的长度限制状态；Responses 使用 `incomplete`。明确审核拦截保留此前已确认的正文，同时返回拦截状态，不重试审核拦截。
- OpenAI 流式连接建立后，后端就绪失败或首段确认前的上游 HTTP 错误通过 SSE error 返回，并保留错误码；首段确认后的错误按上文返回未完成结果。均不换账号重放已产生的内容。参数验证失败仍返回普通 HTTP 错误。其他缓冲接口仅在首段确认前保留原有 HTTP 错误重试策略；协议校验错误不换账号重试。

仅接受文本对话与单候选文本输出。图片、音频、已有工具调用、客户端工具、强制内置工具、缓存上下文或结构化输出等不兼容组合会明确报错，请改用原模型。原生请求兼容常见蛇形和驼峰参数写法；计数接口只映射模型别名，不包含内部工具和多轮调用开销。

抗截断改变的是输出传输方式和有限续写行为。上游仍能检查原始对话和工具参数；不能保证无限长度输出，也不能保证减少审核拦截。此前的非露骨成人主题对照中，原模型和两种工具模式都正常返回，因此不能据此证明审核绕过效果。

## 可选：客户端还原工具结构

**这不是开启抗截断的必要步骤。** 普通客户端直接选择模型即可，默认收到正常正文。

仅在开发自定义客户端、需要将工具结构保留到最终客户端时，OpenAI Chat Completions 可额外使用 `X-Anti-Truncation-Output: tools` 选择响应格式。`X-Anti-Truncation-Mode` 不再参与启用判断。三个别名之外的模型不受这些请求头影响。

工具输出模式返回 `append_output` 和 `finish_output` 的 OpenAI `tool_calls`。每个 SSE 工具参数是完整 JSON，包含唯一 ID 和连续 index；未完成或被拦截时不发送完成工具，结束原因分别是 `length` 或 `content_filter`。

[`scripts/duplex-client.js`](../scripts/duplex-client.js) 提供可选的 `createFetch()` / `decodeResponse()` 适配器，将此格式还原为普通 OpenAI 正文。Node.js 可通过 `require` 引用；浏览器加载后使用 `AIStudioDuplex.createFetch()`。适配器只处理直连 `/v1/chat/completions` 的三个精确别名，不会给其他模型加工具。通过酒馆等客户端后端转发时，仍需确认其能透传工具响应和可选格式头，不能假定替换网页 fetch 就能修改其上游请求。

## 验证和部署

回归测试：`node tests/anti-truncation.test.js`。

真实测试会消耗模型配额，必须显式添加 `--run`：

```sh
# 默认测试无需额外请求头，仅凭模型别名自动启用
node tests/duplex-live.js --run --model=gemini-3.7-flash
node tests/duplex-live.js --run --model=gemini-3.8-flash
node tests/duplex-live.js --run --model=gemini-4-argon

# 可选工具格式及客户端还原
node tests/duplex-live.js --run --tools --model=gemini-3.8-flash

# 本地协议连接真实原模型上游
node tests/duplex-live.js --run --upstream --model=gemini-3.8-flash
```

结果保存在 `artifacts/anti-truncation/duplex/`。旧结果可能包含此前的输入读取轮次，不能用来证明当前版本的延迟和调用次数；当前改动已通过本地模拟回归，真实模型效果需重新运行上述测试。旧的单向 `deliver_response` 引擎及其对照脚本已移除，所有别名请求均使用上述分段协议。

修改后需重启服务；容器部署需重建镜像。无需新增环境变量或管理界面设置。
抗截断别名的 OpenAI 流式模式只由 `ANTI_TRUNCATION_STREAMING_MODE` 决定；需要先收齐再分块发送时，在部署环境中设置 `ANTI_TRUNCATION_STREAMING_MODE=fake`。管理页面切换的 `STREAMING_MODE` 只影响普通模型。
