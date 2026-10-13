# 抗截断模型

**只需选择下列模型名，即自动启用工具输出抗截断。无需额外请求头、客户端脚本或配置开关。**

- `gemini-3.7-flash-抗截断`
- `gemini-3.8-flash-抗截断`
- `gemini-4-argon-抗截断`

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

普通 Argon 使用 `gemini-4-argon`，同样支持思考等级、流式模式和内置工具后缀（例如 `gemini-4-argon-high-fake-search`）。OpenAI、Responses、Claude 转换后的对话若以模型回复或工具结果结尾，会沿用 3.7/3.8 的规则补一个最小 user 轮次。抗截断别名也保留该处理。

Argon 的模型 ID 来自 AI Studio 界面；模型列表暂不填未经确认的 token 上限及采样默认值。实际可用性和工具协议支持仍需通过有权限的上游账号验证。

## 工作方式

1. 原始文本对话直接作为上游对话发送，保留 user/model 角色和 system 指令优先级。不再调用 `read_input`，也不生成任务 ID。
2. 模型通过 `append_output(seq, text, done)` 按顺序交付正文。序号从 1 开始；未完成时，网关确认收到后才继续。相同序号和相同内容不会重复拼接；缺号、同号不同内容等进入有限修复。
3. 最后一个新分段可通过 `done: true` 同时确认全文完成，且该轮上游必须正常 `STOP`。能在一段内完成的回答只需一次上游调用。模型未提供 `done` 时仍支持 `finish_output(last_seq)`；空回答也使用该工具。没有有效完成确认时保留已收到的正文，并标记未完成，不伪装成完整回答。`MAX_TOKENS` 不会因为 `done: true` 被当成正常完成。

工具历史保留真实调用 ID、完整模型回复和 thought signature，参见 [Gemini 官方说明](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。不建立全局任务读取接口，不支持跨请求或断线后的会话恢复。

## 流式输出与限制

- **OpenAI Chat Completions**：遵循全局 `STREAMING_MODE`。`real` 模式在收到完整、有效的正文分段时立即返回；粒度是已确认分段，不是半截工具参数的字符流。单段回答可能一次返回，看起来没有逐字输出。`fake` 模式先收齐所有分段，再以短间隔分块发送 SSE 正文，呈现逐步显示效果。两种模式均在参数验证通过后立即发送 SSE 响应头和助手起始帧，再等待后端就绪与生成；内部上游请求均为非流式，等待期间每 10 秒发送 SSE 心跳。
- **Responses、Claude、Gemini 原生接口**：使用同样的内部工具协议，当前仍先缓冲整次结果，再转换成对应的流式或普通响应格式。
- OpenAI 起始时连续发送助手角色帧和空内容帧，兼容 `new-api` 等暂存最后一帧的中转，避免起始帧被扣到后续心跳或正文到达。两帧均不包含正文；假流仍在生成完成后才发送正文。
- 多层 Nginx/OpenResty 代理还需透传 `X-Accel-Buffering` 响应头，否则公网层可能重新缓冲起始帧和心跳。配置与公网验证方法见 [Nginx 多层代理配置](zh/nginx-setup.md#-多层代理配置)。
- 单次输出预算不超过 8192 token 时最多接受 6 段，否则最多 3 段；使用独立完成确认时额外占一轮，另有最多 2 次协议修复。每次内部上游调用分别受 `FAKE_STREAM_TIMEOUT_MS` 限制，整次回答可能超过该时长；重复确认仍受总轮次限制。客户端或中间代理自身的绝对超时仍可能提前结束请求。
- 所有内部调用计入配额和用量；父请求与内部子请求不重复计算为用户并发。客户端断开会取消内部请求并清理队列。
- 停止字符串支持字符串或数组，在正文上处理，支持跨段匹配。中文、emoji、换行、Markdown、XML 和转义字符原样保留。
- 停止词检查只扫描新增正文及可能跨段匹配的前缀重叠区域，避免每轮重复扫描整篇文章。完成时会交付暂存但未构成停止词的尾部文本。
- 未完成时返回相应的长度限制状态；Responses 使用 `incomplete`。明确审核拦截保留此前已确认的正文，同时返回拦截状态，不重试审核拦截。
- OpenAI 流式连接建立后，后端就绪失败或上游 HTTP 错误通过 SSE error 返回，并保留错误码；不换账号重放已产生的内容。参数验证失败仍返回普通 HTTP 错误。其他缓冲接口保留原有 HTTP 错误重试策略；协议校验错误不换账号重试。

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

结果保存在 `artifacts/anti-truncation/duplex/`。旧结果可能包含此前的输入读取轮次，不能用来证明当前版本的延迟和调用次数；当前改动已通过本地模拟回归，真实模型效果需重新运行上述测试。`tests/anti-truncation-live.js` 仅用于历史单向工具算法的本地对照，不代表当前别名路由。

修改后需重启服务；容器部署需重建镜像。无需新增环境变量或管理界面设置。
若通过管理页面切换 `STREAMING_MODE`，该设置只在当前进程生效；需要重启后保持假流时，在部署环境中设置 `STREAMING_MODE=fake`。
