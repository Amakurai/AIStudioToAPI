# 抗截断模型

**只需选择下列模型名，即自动启用工具输出抗截断。无需额外请求头、客户端脚本或配置开关。**

- `build-gemini-3.7-flash-抗截断`
- `build-gemini-3.8-flash-抗截断`
- `build-gemini-4-argon-抗截断`
- `pg-gemini-3.7-flash-抗截断`
- `pg-gemini-3.8-flash-抗截断`
- `pg-gemini-4-argon-抗截断`

Build 与 Playground 两条链路都支持，前缀决定链路：`build-` 前缀可省略，`pg-` 前缀走 Playground。两条链路使用同一套分段协议，互不回退。

仅这三个基础模型的精确别名启用；原模型及其他模型保持原有行为。请求头不能给其他模型开启此功能。模型列表会显示这些别名：Build 的别名来自 `configs/models.json`，Playground 的别名按 Playground 目录中实际存在的基础模型自动生成（沿用基础模型的 token 上限），网关请求上游时自动去掉后缀。中文原生接口路径可以使用 URL 编码；不与搜索、代码执行、思考等级等其他模型后缀组合。

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

1. 原始文本对话直接作为上游对话发送，保留 user/model 角色和 system 指令优先级。不再调用 `read_input`，也不生成任务 ID。系统提示和对话内容不追加任何协议文字：分段规则只写在 `append_output`/`finish_output` 的工具描述里，续写提示放在每次确认的工具返回值中，修复提示写进下一轮的工具描述；确认之后只补一个空的 user 轮次（与普通链路在函数轮次后补的相同）。Playground 原生协议没有强制调用字段，抗截断的 Playground 轮次使用 `AUTO`，不再往系统提示追加 “Respond using one of the provided functions.”；模型因此可能不调用工具、直接回复纯文本，处理方式见第 4 条。
2. 模型通过 `append_output(seq, text, done)` 按顺序交付正文。序号从 1 开始；未完成时，网关确认收到后才继续。相同序号和相同内容不会重复拼接；缺号、同号不同内容等进入有限修复。新分段开头若原样重发了已确认的正文（至少 32 个字符），只去掉重复部分再拼接，并记录警告；只重发已确认正文的新序号不算新内容（带 `done: true` 时视为完成确认，否则进入修复）。短于 32 个字符的重复可能就是正文本身，原样保留。
3. 最后一个新分段可通过 `done: true` 同时确认全文完成，且该轮上游必须正常 `STOP`。能在一段内完成的回答只需一次上游调用。以下写法与 `finish_output(last_seq)` 等价，也视为完成：下一序号的空文本加 `done: true`，或原样重发已确认的末尾正文并加 `done: true`。空回答可用 `finish_output(0)` 或 `append_output(1, "", true)`。没有有效完成确认时保留已收到的正文，并标记未完成，不伪装成完整回答。`MAX_TOKENS` 不会因为 `done: true` 被当成正常完成。
4. 模型没有调用工具、直接回复纯文本时（思考内容不计入）：若尚未确认任何分段，这段文本就是回答本身，与原模型直接返回的相同。上游正常 `STOP` 即视为完成，单轮结束；被 `MAX_TOKENS` 截断时保留这段文本，原样放入历史，并在下一轮的工具描述中提示从断点用 `append_output` 续写，续写仍以纯文本到达时同样接收，直到上游正常结束。已经通过工具确认过分段后再出现的纯文本可能只是附言，不拼接，按协议错误修复。只含空白的纯文本同样进入修复。
5. 第一段正文确认之前，任何被拒的工具调用（空回复、只有思考没有正文、参数损坏、缺号等，常见于 `gemini-4-argon` 长对话思考完直接结束）都不再修复重试，立即返回 502 错误（`the model produced no output (<原因>)`），不整单重试、不换账号，避免客户端长时间挂起。协议修复只用于保护已确认的正文。
6. 已确认至少一段后，若后续某轮上游出错（HTTP 错误、单轮超时、返回无效 JSON 等），不再丢弃前文，也不整单重放：直接返回已确认的正文并标记未完成（OpenAI `length`、Claude `max_tokens`、Responses `incomplete`、Gemini `MAX_TOKENS`），错误原因写入日志。第一段尚未确认时出错，仍按原有策略返回错误或重试。

历史中的模型思考内容（如 Claude 回传的 thinking 块，转换后为 `thought: true` 的部分）会在发送前移除，不再导致多轮请求被拒；文本部分上的 `thoughtSignature` 原样保留。只含思考内容的模型轮次整轮移除。

工具历史保留真实调用 ID、完整模型回复和 thought signature，参见 [Gemini 官方说明](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。不建立全局任务读取接口，不支持跨请求或断线后的会话恢复。

## 开头的思考块

很多预设要求模型先在 `<thinking>…</thinking>`（或 `<think>…</think>`）里写思考，再写正文。SillyTavern 等客户端会在**第一个**结束标签处截断思考块；模型在思考里引用格式（例如 `` `<thinking>…</thinking>` 工作日志 ``）时，后半段思考连同真正的 `</thinking>` 就会露进正文。

因此，抗截断别名的回答若以这类标签开头（允许前导空白），网关会自己找到真正的结束标签，把思考块放进各接口原生的推理字段，正文从结束标签之后开始：

- 结束标签前紧挨反引号，或同一行更早处写过对应的开始标签，视为思考中的引用，不算结束。
- OpenAI 返回 `reasoning_content`（真流式时随分段即时发送，假流式先发推理再发正文），Claude 返回 `thinking` 块，Responses 返回 reasoning 摘要，Gemini 原生返回 `thought: true` 的部分。思考块和正文开头的空白会去掉；只有开头的思考块会被拆出，正文里再出现的标签原样保留。不以这类标签开头的回答一字不改。
- 回答在思考块内结束（例如未完成）时，全部内容都作为推理返回。
- SillyTavern 只在启用“请求模型推理”（Request model reasoning）时显示接口返回的推理；未启用时思考块不显示，正文不受影响。
- 可选工具输出格式（`X-Anti-Truncation-Output: tools`）不拆分，以便按字节还原。需要保留原样正文时，设置 `ANTI_TRUNCATION_SPLIT_THINKING=false`。

拆分时记录 `[AntiTruncation] <请求 ID>: returned a N-character leading thinking block as reasoning`。

## Playground 链路

`pg-*-抗截断` 与 Build 别名共用上述分段协议和全部限制，区别只在每一轮上游调用的发送方式：

- 每轮内部调用都是一次普通的 Playground `generateContent`（非流式）：在该账号的专用 Playground 页面取得原生签名后发送，同一账号内串行。因此每轮会额外增加取得签名的延迟（通常数秒），多段回答的总耗时高于 Build。
- 账号规则沿用 Playground：不计入 `SWITCH_ON_USES` 和 `FAILURE_THRESHOLD`；某一轮遇到 429/503 等可换号状态时，只把这一轮换到尚未尝试的其他就绪账号重发，已确认的正文和续写历史保留，不冷却、不切换或重排 Build 账号池。没有可用账号时按上文返回未完成结果（首段确认前则返回错误）。
- 内部调用不会发往 Build 页面；取消时只停止 Playground 页面上的当前一轮。
- 安全设置与普通 `pg-` 请求相同：未显式指定时使用 `SAFETY_SETTINGS_THRESHOLD`（默认 `OFF`）覆盖四个可配置类别。`PROHIBITED_CONTENT` 等不可配置的拦截仍按“明确审核拦截”处理。

## 流式输出与限制

- **流式模式**：OpenAI Chat Completions、Responses、Claude Messages 和 Gemini 原生 `streamGenerateContent` 的抗截断别名都使用独立的 `ANTI_TRUNCATION_STREAMING_MODE`（默认 `real`），不受普通模型 `STREAMING_MODE` 影响。`real` 模式在收到完整、有效的正文分段时立即以各接口自己的 SSE 增量格式发出（OpenAI `delta.content`、Responses `response.output_text.delta`、Claude `text_delta`、Gemini 数据块的 `parts`）；粒度是已确认分段，不是半截工具参数的字符流。单段回答可能一次返回，看起来没有逐字输出。`fake` 模式先收齐所有分段，生成完毕后一次性发出全部正文，不再分块停顿；生成完成前不发送响应头和心跳，因此出错或没有正文时返回普通 HTTP 错误（保留状态码）。拆出的思考块先于正文，以各接口的推理增量发送。两种模式拼接后的正文与非流式结果逐字节一致；内部上游请求均为非流式。
- 最后一帧不含正文，携带结束原因和整次回答累计的用量：完成为 OpenAI `stop`、Claude `end_turn`、Responses `completed`、Gemini `STOP`；未完成为 `length`、`max_tokens`、`incomplete`、`MAX_TOKENS`；审核拦截与非流式结果相同。Claude 的 `message_start` 随首段发出，此时用量尚未汇总，输入/输出 token 以最后的 `message_delta` 为准。
- **所有接口**：第一段正文确认之前不发送任何内容（无响应头、起始帧和心跳），客户端不会先出现空回复；此前出错或没有正文时返回普通 HTTP 错误（保留状态码）。`real` 模式在首段发出时才建立 SSE，`fake` 模式在整段生成完毕后一次发出。
- `real` 模式首段发出后，等待后续分段期间发送心跳：OpenAI 每 10 秒一次，Responses、Claude、Gemini 原生接口每 12–18 秒一次（Claude 为 `event: ping`，Responses 和 Gemini 为 SSE 注释），心跳不含正文。
- 多层 Nginx/OpenResty 代理还需透传 `X-Accel-Buffering` 响应头，否则公网层可能重新缓冲起始帧和心跳。配置与公网验证方法见 [Nginx 多层代理配置](zh/nginx-setup.md#-多层代理配置)。
- 无论输出预算多少，最多接受 8 段；整次回答最多 11 次上游调用（8 段、独立完成确认 1 轮、修复余量 2 轮）。协议修复按步计算：同一步最多连续修复 2 次，收到新正文后重新计数，所有轮次共用 11 次的总上限，因此分散在多段中的偶发错误不会提前耗尽修复次数。每段字符上限为单次输出预算（`max_tokens` / `maxOutputTokens`）的 75%，并先扣除显式的 `thinkingBudget`，范围 64–12000；未设置预算时为 12000。总容量随预算单调增加，调大预算不会减少可输出长度。只有输出预算耗尽（`MAX_TOKENS`）或参数损坏（`MALFORMED_FUNCTION_CALL`）的轮次会在修复时把上限减半；缺号、同号不同内容、重复正文等顺序错误重试时保持原上限，不会让后续分段无谓变短。
- 每次内部上游调用分别受 `FAKE_STREAM_TIMEOUT_MS` 限制。单轮超时只结束该轮，已确认正文按未完成返回，整次回答可能超过该时长；重复确认仍受总轮次限制。客户端或中间代理自身的绝对超时仍可能提前结束请求。首段正文确认之前另有 `ANTI_TRUNCATION_FIRST_OUTPUT_TIMEOUT_MS`（默认 300000，即 300 秒）：到点仍无正文时立即中止当前轮并返回 504，不再开始新轮、不换账号重试；首段确认后不受此限制。
- 每次被拒的工具调用都会以 `[AntiTruncation] <请求 ID>: rejected transport call: <原因> (finishReason=…, parts=[…], outputTokens=…, thoughtTokens=…)` 记录警告，括号内是被拒轮次的结束原因、各部分类型/长度与 token 用量，用于区分“只思考没输出”和解析问题；修复轮与正常续写分别记录为 `Retrying rejected transport call` 和 `Requesting next segment`。直接接收的纯文本回复记录为 `accepted a plain-text reply as segment <序号>`（INFO），去掉的重发正文记录为 `dropped <N> resent acknowledged character(s)`（警告）。
- 所有内部调用计入配额和用量；父请求与内部子请求不重复计算为用户并发。客户端断开会取消内部请求并清理队列。
- 停止字符串支持字符串或数组，在正文上处理，支持跨段匹配。中文、emoji、换行、Markdown、XML 和转义字符原样保留。
- 停止词检查只扫描新增正文及可能跨段匹配的前缀重叠区域，避免每轮重复扫描整篇文章。完成时会交付暂存但未构成停止词的尾部文本。
- 未完成时返回相应的长度限制状态；Responses 使用 `incomplete`。明确审核拦截保留此前已确认的正文，同时返回拦截状态，不重试审核拦截。
- 首段发出前的错误（后端就绪失败、上游 HTTP 错误、没有正文）以普通 HTTP 错误返回并保留状态码；协议校验错误不换账号重试。首段发出后，后续轮次出错或连接中断都以已发出的正文结束为未完成，不再整单重试，也不换账号重放已产生的内容。
- 客户端在分段之间断开时，网关立即取消正在进行的内部上游轮次并清理队列，不再发起后续轮次。

请求带有工具时不走抗截断，直接按原模型转发（与不带后缀的原模型完全相同）：客户端声明的工具（OpenAI `tools`/`functions`、Claude `tools`、Gemini `tools`）、`toolConfig`、缓存上下文（`cachedContent`），以及管理设置中开启的强制联网搜索、URL 上下文、代码执行，任一存在即回退，日志记录为 `[AntiTruncation] Request #<请求 ID> carries tools or cachedContent; forwarding to the base model without anti-truncation.`。预设自带工具时同样回退，由客户端自行处理工具调用。

不带工具的请求走分段协议：历史中已有的工具调用转为普通文本（调用参数全是字符串时拼接其内容，否则写成 JSON；工具结果写成 JSON 并作为 user 轮次）。图片、音频等非文本输入，以及多候选、结构化或多模态输出会明确报错，请改用原模型。

原生请求兼容常见蛇形和驼峰参数写法；计数接口只映射模型别名，不包含内部工具和多轮调用开销。

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
抗截断别名在全部四种接口上的流式模式只由 `ANTI_TRUNCATION_STREAMING_MODE` 决定；需要先收齐再分块发送时，在部署环境中设置 `ANTI_TRUNCATION_STREAMING_MODE=fake`。管理页面切换的 `STREAMING_MODE` 只影响普通模型。
