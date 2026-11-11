# Build / Playground 双链路

一套服务，两条互不依赖的生成链路，共用已登录的 Google 账号池、API 格式转换和账号轮换。Playground 复用 BrowserManager 中已经登录的账号上下文，不需要增加 Cookie 配置或另一套登录服务。

## 模型命名

| 前缀     | 链路           | 模型列表来源                                           | 抗截断                                   |
| -------- | -------------- | ------------------------------------------------------ | ---------------------------------------- |
| `build-` | Build App 代理 | `configs/models.json`                                  | 支持（`build-gemini-4-argon-抗截断` 等） |
| `pg-`    | Playground     | `configs/playground-models.json` + Playground 原生目录 | 支持（`pg-gemini-4-argon-抗截断` 等）    |

- 模型名前缀唯一决定链路，请求进入时剥掉前缀再发往上游，例如 `build-gemini-4-argon` 与 `pg-gemini-4-argon` 是同一个上游模型的两条链路。思考等级、流式模式和内置工具后缀照常叠加在后面（如 `pg-gemini-4-argon-high`）。
- 两条链路互不回退：Build 的 403、404、429、400 等错误直接按 Build 原有的重试与换号流程处理，不会改走 Playground；Playground 的错误同样只在 Playground 内处理。
- 不带前缀的旧模型名（如 `gemini-3.8-flash`）仍按 Build 处理，兼容现有客户端，但不再出现在模型列表中。
- `GET /v1/models` 与 `GET /v1beta/models` 当前仅列出 `pg-*` 模型，`upstream_channel`/`upstreamChannel` 字段为 `playground`。Build 模型的列表注册已在代码中注释停用，控制台“模型通道”仅展示 Playground。
- Playground 页面加载时读取原生模型目录，可生成内容的模型加入 Playground 列表（不影响 Build 列表），token 上限覆盖配置值，并保存到 `data/playground-models.json`，重启后立即恢复。旧版 `data/model-routes.json` 中保存的目录会在首次启动时读取一次，其中的通道学习记录不再使用。
- 转写（transcribe）、Lyria 音乐、Omni、Deep Research 和 Antigravity 等模型在 Playground 中不是聊天输入页面，适配层无法驱动，实测会在 95–190 秒后超时并占住该账号的 Playground 页面。这些模型不列入 `pg-` 列表，请求在本地返回 400，请改用对应的 `build-` 模型。语音合成（TTS）模型走专用的语音页面，见下文“语音合成（TTS）”。
- `pg-` 模型只支持内容生成（OpenAI Chat Completions、Responses、Claude Messages、Gemini `generateContent`/`streamGenerateContent`，TTS 模型另支持 OpenAI `/v1/audio/speech`）。`countTokens`、嵌入、文件上传、模型详情等请求在本地返回 400，不会改发到 Build。
- 抗截断：`pg-gemini-3.7-flash-抗截断`、`pg-gemini-3.8-flash-抗截断`、`pg-gemini-4-argon-抗截断` 使用与 Build 相同的单工具输出包装，一次正常请求只进行一次 Playground 生成，不自动分段或续写；模型列表只为 Playground 目录中存在的基础模型列出别名。详见 [抗截断模型说明](anti-truncation.md)。

## 预设模型

聊天模型新增 `-预设` 别名，默认提供 `pg-gemini-4-argon-预设` 和 `pg-gemini-3.8-flash-预设`，无需等待 Playground 页面发现模型即可从模型列表选择。后缀放在最后，例如 `pg-gemini-4-argon-high-fake-search-预设`。

- 纯文本请求在客户端请求流式时使用真流式，即使全局设置或 `-fake` 后缀指定假流式；省略 `stream` 或传 `stream: false` 时返回普通 JSON。
- 带自定义工具的请求等待本轮完整生成后再返回，生成期间不提前发送正文、思考或工具参数。`stream: true` 仍按客户端的 SSE 协议一次性发送完整结果，非流式返回 JSON。
- 自定义工具定义、提示词、工具选择和结果回传沿用原请求，不因带有工具或历史工具结果而擅自强制或禁用调用；与 Google 搜索同时使用时保留工具组合开关。显式要求必须调用工具（`required`/指定工具，转换后为 `ANY`）却只得到普通正文时返回 502，避免把未执行的必需调用当作成功回复。
- 工具生成以 `MALFORMED_FUNCTION_CALL`、`UNEXPECTED_TOOL_CALL` 或 `TOO_MANY_TOOL_CALLS` 结束时，返回包含原生原因的 502，不把半截正文作为正常回复，也不因此冷却账号。输出达到 token 上限时，Chat/Claude 分别保留 `length`/`max_tokens`，不因出现工具调用而覆盖为正常工具结束。
- Chat 将 `PROHIBITED_CONTENT`、`BLOCKLIST`、`SPII` 等上游拦截原因映射为 `content_filter`，即使此前已有部分正文或工具调用，也不误报为普通 `stop` 或 `tool_calls`。
- Chat 的 `max_completion_tokens` 优先于旧参数 `max_tokens`，单个字符串 `stop` 转为停止序列。文本请求的输出上限和停止序列只来自客户端或 Playground 运行设置，不继承临时网页的保存值；显式空停止序列可以清除项目默认值。
- Chat 的 `system`/`developer` 指令支持字符串与文本分块数组，完整传入系统指令通道。显式 `thinkingConfig`/`thinking_config` 中的思考等级和预算保留，模型名的思考等级后缀仍优先。
- 支持 OpenAI Chat Completions、Responses、Claude Messages 和 Gemini 原生生成接口。Gemini 使用 `generateContent` 返回 JSON，使用 `streamGenerateContent` 返回流式响应。
- 思考等级、搜索等设置继续生效。与抗截断别名叠加时，预设使用基础模型。
- 仅作用于 `pg-` 聊天模型；TTS 不提供预设别名。

```json
{
  "model": "pg-gemini-4-argon-预设",
  "stream": false,
  "messages": [{ "role": "user", "content": "你好" }]
}
```

以上请求返回普通 JSON；设置 `stream: true` 可获得真流式响应。

## 账号与并发

两条链路共用同一个账号池，但互不改动对方的账号状态：

- 同一账号可以同时处理 Build 和 Playground 请求：Build 使用 Build App 页面，可并发；Playground 使用该账号的专用临时页面，同一账号内串行，不同账号之间并发。默认 `MAX_CONTEXTS=1` 时池中只有一个账号，两条链路的请求都会落在这个账号上。
- 两条链路分别轮询各自负载较低的就绪账号，重复登录文件按同一账号合并计算负载，优先避开正在排空的浏览器上下文；一个账号正在切换时，其他就绪账号仍可处理请求。
- 并发请求已经发往上游时，多个请求可能先后收到 429；冷却生效后不再向该账号分发新请求。Playground 排队请求在真正开始前再次检查模型冷却，避免排队期间发生的 429 被忽略。
- 分发时两条链路各自按负载选择账号：Build 只统计 Build 的在途请求，Playground 只统计 Playground 的在途请求，在 Playground 排队的请求不会让 Build 避开该账号。
- `pg-` 请求不计入 `SWITCH_ON_USES` 轮换次数和 `FAILURE_THRESHOLD` 失败次数。Playground 与 Build 共用临时账号冷却状态：冷却账号会同时退出当前账号选择和所有模型的并发分发，手动切号也不能绕过冷却。先改用尚未尝试的其他就绪账号；没有可用的就绪账号时，自动启动未尝试且未冷却的备用账号。冷启动沿用共享浏览器账号池的容量与在途请求保护，并保留 Build 的使用和失败计数。发送前和 Playground 内部排队结束时再次检查冷却，避免并发请求使用刚进入冷却的账号。Playground 取消请求时也不会向 Build 页面发送指令。
- 两条链路的 400（如输入 token 超限、参数错误）和 413 与账号无关：不重试、不计入失败次数、不触发换号，直接返回给客户端；`API_KEY_INVALID` 等与账号相关的 400 仍按原流程处理。
- Build 的 429 若带 `limit: 0`，表示该账号对这个模型没有额度（未开通），并非限流：先换其他未尝试的就绪账号重试，必要时启动备用账号；不冷却账号、不计失败，避免一个无权限模型的请求让所有模型都无法使用。普通 429 仍冷却账号 1 分钟。
- Build 与 Playground 的临时冷却都按 Google 账号共享（含同邮箱的重复认证文件），到期自动恢复选用资格，不标记认证过期。
- Build 自身的轮换、冷却和换号仍按原规则进行。如果 Build 关闭了某个账号的上下文，该账号上正在进行的 Playground 请求会随之失败。

Playground 的 401、403、429 和临时服务错误默认冷却 60 秒，使用 `RATE_LIMIT_COOLDOWN_MS` 配置。通用 403 只说明本次上游请求未获授权，不据此判断账号没有会员，也不再递增到数小时冷却。保留原始 403 并尝试其他账号；明确的网页权限验证弹窗也保留 403。已经向客户端发送内容的流不会重放，账号仍会退出后续分发。内容过滤、参数错误和同账号排队超时不会触发账号冷却。

管理界面的账号列表每秒更新冷却倒计时，显示原始 HTTP 状态码；悬停可查看触发通道和模型。冷却账号不显示“当前”或“可分发”，切号按钮禁用；倒计时依据服务端截止时间校正，页面关闭时停止计时器。请求统计的“尝试路径”保留各账号的原始失败状态，即使后续重试成功也可查看。

设置 `PLAYGROUND_ENABLED=false` 并重启可关闭 Playground 链路：`pg-*` 模型不再列出，请求返回 400；Build 链路不受影响。

## 请求和响应

现有 OpenAI、Gemini、Anthropic 请求先走原有转换流程，再按模型前缀交给对应链路。例如：

```json
{
  "model": "pg-gemini-4-argon",
  "messages": [{ "role": "user", "content": "请输出完整答案。" }],
  "stream": true
}
```

Playground 适配层支持文本、多轮对话、系统指令、函数调用和工具回传、内联媒体及常用生成参数；保留工具调用 ID、思考签名、结束原因和 token 用量。原生分块响应转换为 Gemini JSON/SSE，再交给现有 API 格式转换器。与公开 API 一致，只有 `includeThoughts: true` 时才返回思考内容（Gemma 等模板即使未请求也会输出思考，返回前会被过滤）；仅设置 `thinkingLevel`/`thinkingBudget` 或未设置思考配置时不返回，界面模板默认的显示思考也会被关闭。生成参数同时接受 camelCase 与 snake_case 写法。安全设置中 MakerSuite 未提供的公开类别（如 `HARM_CATEGORY_CIVIC_INTEGRITY`）保持原生默认，不再导致 400。

控制台“设置”页的 **Playground 运行设置** 对应 AI Studio 的 Run settings 面板，保存到 `data/playground-settings.json`，作用于所有 `pg-` 模型：思考等级（默认 Medium，只对 Gemini 3 及以上的文本模型生效）、代码执行 / Google 搜索 / URL 上下文（默认全部关闭）、媒体分辨率、安全阈值、停止序列、输出长度和系统指令。这些是默认值，客户端请求显式给出的参数优先；工具开关和安全阈值取代全局 `FORCE_*` 与 `SAFETY_SETTINGS_THRESHOLD`（安全阈值可选“跟随全局”），模型名 `-search` 后缀仍然生效。系统指令加在客户端系统指令之前。抗截断轮次只应用思考等级和媒体分辨率；TTS 模型不受影响。

抗截断模型（Build 与 Playground）在 OpenAI、Responses、Claude 和 Gemini 原生接口上的流式输出使用独立配置 `ANTI_TRUNCATION_STREAMING_MODE=real`（默认），每段完成校验后立即发出，不再受普通模型的 `STREAMING_MODE=fake` 影响。需要完整缓冲时可显式设置为 `fake`。

所有接口使用 `STREAMING_MODE=fake` 时，等待上游完整生成后才响应：生成期间不发送响应头和心跳，生成完毕后一次性发出全部 SSE 帧，不再分块停顿。上游出错、超时或没有任何正文（只有思考、空回复、被拦截）时返回普通 HTTP 错误和错误信息，而不是空的 200 流。非流式请求同样处理，并保留上游状态码（如 429、503）。真流式（`STREAMING_MODE=real` 或 `-real` 后缀）在第一个带正文、思考、工具调用或媒体的数据块到达之前不发送任何内容，中转层统计的首字时间即为真实出字时间；此前出错或整段没有输出时同样返回普通 HTTP 错误。

每个活跃账号按需创建一个专用临时 Playground 页面，该账号内的 Playground 请求串行执行，不同账号可以并发。同一模型在 10 分钟内复用页面，通过原生新对话及丢弃确认重置历史；模型改变、页面过期或重置失败时重新加载。每次仍获取新签名，签名材料和模型不匹配时只允许在推理之前重建页面重试。页面由现有浏览器上下文管理，关闭账号上下文时一起释放。文本中的 CRLF/CR 换行在签名和发送前统一为 LF，与网页输入框的签名材料保持一致。

`FAKE_STREAM_TIMEOUT_MS` 限制排队、准备及首块（缓冲模式下为完整响应）的总时长。真流式开始输出后改为按块间空闲时间（`STREAM_TIMEOUT_MS`，默认 60 秒）判断超时，与 Build 真流式一致，持续输出的长回复不会被总时长截断。

适配层在临时页面中提交与原始内容具有相同签名材料的文本，拦截原生生成请求取得当次请求的签名及权益请求头；这次界面提交不进入推理服务。随后使用完整结构化请求在同一页面发起真实生成。原生签名材料不一致时明确报错，不发送内容被改变的请求。流式读取直接等待浏览器 reader 的下一块数据，不再定时轮询或维护浏览器生产队列；真流式转发只跟踪完成状态，不额外累计整份回复。

鉴权请求头仅驻留内存，不写入路由文件或日志。取消或超时会停止专用页面的请求；响应被截断时返回错误，不伪装成正常完成。

Playground 调用记录的 `generation` 字段及 INFO 日志保存请求的输出上限、停止序列数量、工具名称与定义摘要，以及上游原生结束原因、工具调用数量和 token 用量。提示词、系统指令和工具定义仅保存 SHA-256 摘要，不保存正文或参数。可据此区分输出上限、工具生成异常与传输中断；`STOP` 只代表模型正常结束，不保证内容满足用户预期。

## 语音合成（TTS）

`pg-gemini-3.8-flash-tts`、`pg-gemini-3.8-flash-lite-tts`、`pg-gemini-3.1-flash-tts-preview`、`pg-gemini-2.5-flash-preview-tts`、`pg-gemini-2.5-pro-preview-tts` 使用 Playground 的 `generate-speech` 页面，可通过 OpenAI `/v1/audio/speech` 或 Gemini `generateContent`（`responseModalities: ["AUDIO"]` + `speechConfig`）调用，账号、并发、冷却规则与其他 `pg-` 模型相同。

- 原生请求仍是 MakerSuite `GenerateContent`：`responseModalities` 编码为生成配置 `[14]`（AUDIO = 3），`speechConfig` 编码为 `[15]`，内部字段与公开 proto 一致（`voiceConfig` = 1、`languageCode` = 2、`multiSpeakerVoiceConfig` = 3）。未指定音色时使用页面默认音色（3.8 为 `Fola`，2.5/3.1 为 `Zephyr`）。
- 适配层打开语音页面的“Create new dialog”：2.5/3.1 切换到 Text 视图使用单个文本框，3.8 使用单个语音块，按原文取得签名。2.5/3.1 页面总会把文本包成 `## Transcript:\n<文本>`（AI Studio 自己的 TTS 提示格式），签名覆盖该文本，因此发往上游的请求同样加上这一前缀，与页面自身发送的内容一致；实测不会被读出。3.8 原样发送。
- 3.8 及更新的 TTS 页面由语音块组成，每个文本 part 可带 `speech_metadata`（part 字段 41：`[说话人, 声音风格]`）。part 的 `speechMetadata: { speaker, style }` 原样透传；`style` 即页面语音块的 Style（“Describe the voice style”）。
- 3.8 的多说话人请求要求每个文本 part 标明说话人。公开格式 `Joe: ...\nJane: ...` 会按 `speakerVoiceConfigs` 中的说话人名拆成逐句 part（说话人行可以缩进，不带说话人前缀的行并入上一句）。第一句之前的文本（如官方示例 `TTS the following conversation between Joe and Jane:`、`Make Joe sound tired:`）是表演指示而非台词，作为每一句的声音风格发送，不会被读出；完全没有说话人行时返回 400。2.5/3.1 直接读取公开格式，不拆分。3.8 不接受 `systemInstruction`（上游返回 “Developer instruction is not enabled for this model”）。
- `/v1/audio/speech` 的 `instructions` 在 `pg-` 3.8 模型上作为声音风格发送（实测前缀写法 `指示: 正文` 会被 3.8 读出：同一句话 3.84 秒对比 1.92 秒）；Build 与 2.5/3.1 仍按 `指示: 正文` 发送。非 TTS 的 `pg-` 模型请求该端点在本地返回 400。
- 上游以多段 24kHz 16-bit 单声道 L16 PCM 流式返回音频，结束分块另带一个空 text part。Playground 会把连续的同格式 PCM 段拼接成一个 part 并去掉空 text part（与公开 API 一致）；TTS 的真流式请求同样等生成完成后以一个 SSE 事件发送整段音频，避免 OpenAI/Claude 格式中出现几十个无法单独播放的音频片段。`/v1/audio/speech` 再封装为 WAV 或按 `response_format=pcm` 返回原始 PCM。
- OpenAI Chat Completions 与 Claude Messages 中的音频以 `![Generated Audio](data:audio/wav;base64,...)` 输出（原始 PCM 封装为 WAV，浏览器可直接播放；Build 链路同样适用）。假流式输出时整段媒体 data URI 作为一帧发送。
- 部分账号的 3.8 页面也显示 “View mode” 切换，但 Text 选项被禁用（`aria-disabled`）。适配层只在 Text 可用且未选中时点选，否则直接使用语音块，并以实际出现的输入框为准；此前点击被禁用的选项会等满 30 秒超时。

2026-10-18 实测（独立浏览器，未影响线上服务）：5 个 TTS 模型均返回 `STOP` 和音频；3.8 单说话人（`Fola`）、3.8 双说话人（`Rami`/`Fola`，含同页面复用，第二次约 2.4 秒）、2.5 双说话人、3.1 默认音色、3.8 lite 指定 `languageCode` 均成功；2.5 的 “Good morning.” 生成 1.05 秒音频，说明 `## Transcript:` 前缀没有被读出。官方多说话人示例（引导语 + 缩进的说话人行）在 3.8 上生成 3.3 秒双人音频，引导语未被读出。

## 当前边界

- Playground 链路只覆盖 `generateContent` 和 `streamGenerateContent`；文件上传、嵌入、`countTokens`、批处理等请求请使用 `build-` 模型。
- MakerSuite 是网页内部协议。网页结构、请求头或协议改变时可能需要更新适配层；首次加载和每轮取得原生签名会增加延迟。
- 原生协议没有公开的强制函数选择字段。`ANY` 通过函数白名单和指令表达，不能保证与公开 API 的强制解码完全等价；抗截断流程另有调用与序号校验。`NONE` 禁用自定义函数。
- 结构化 schema 使用 MakerSuite 支持的字段。工具参数和结构化输出支持 `type: ["string", "null"]` 等可空类型、多个类型的联合及嵌套组合；可空单类型转换为 `nullable`，多类型转换为 `anyOf`，独立 `null` 转换为可空字符串并通过 `not` 排除字符串。原有 `enum`、`anyOf`、`allOf` 等约束保留，联合类型共用约束以避免嵌套展开膨胀。不支持的类型、错误的 schema 结构及超过 64 层的嵌套返回带字段路径的不可重试 400。未写 `type` 的 schema 按关键字推断：`properties`/`required` 为对象，`items` 为数组，`enum`/`const` 按取值推断（数值枚举以字符串形式编码），`minLength`/`pattern` 为字符串，`minimum`/`maximum` 为数字；完全无约束的 `{}` 转换为字符串、数字、布尔及 null 的联合（MakerSuite 不接受缺少属性的对象和缺少 `items` 的数组，因此暂不包含对象和数组）。`$ref`、`additionalProperties`、`default` 等 JSON Schema 扩展仍不能完整表达。网页搜索等内置工具可编码，但搜索引用、完整安全评分、logprobs 等响应附加元数据尚未完整转换。
- 已实测的核心路径是 Argon 文本和工具调用；多模态及其他 Playground 模型仍取决于上游支持和账号权限。

## 协议参考与验证

协议字段参考 [DeconstructedCube/aistudio-api 的 WIRE_SPECIFICATION.md](https://github.com/DeconstructedCube/aistudio-api/blob/6d1f243b811834a88fecac5615e6a161ea112efb/docs/WIRE_SPECIFICATION.md)。本项目独立实现适配代码，保留现有 Node.js 服务、浏览器登录和账号池，未引入参考项目的 Cookie 获取与登录流程。

离线回归：`node tests/playground.test.js`、`node tests/playground-schema.test.js`、`node tests/playground-bugfix-regression.test.js` 和 `node tests/model-channel.test.js`。覆盖协议分块、工具参数、签名字段、模型目录持久化、前缀分流、两条链路互不回退、取消、超时、残缺流和过期请求隔离。`tests/duplex-live.js --run --model=gemini-4-argon` 是明确发起真实模型请求的长文本校验工具，会消耗上游额度。

2026-10-13 部署验证：Argon 的 OpenAI 真流式请求与抗截断请求返回成功；真实函数调用及工具结果回传完成；120 行、13,814 字符的抗截断输出与校验原文 SHA-256 完全一致（约 84 秒）。原有 `gemini-3.8-flash` 生成请求亦返回成功。离线回归共 274 项通过，源码 ESLint、样式检查及前端构建通过（保留既有 Vue `v-html` 和构建体积警告）。

优化后验证：279 项离线回归通过；真实工具调用与回传在同一页面内完成，没有重新导航。相同 120 行、13,814 字符样本仍逐字一致；本次首段时间为 20.1 秒（此前 81.7 秒），总耗时 74.8 秒（此前 83.8 秒）。这是不同账号上的单次观测，不代表固定延迟。新路由实例从磁盘将模型列表从 35 项恢复到 41 项，无需联网生成。另覆盖首次权限失败换号、账号隔离、冷却和过期记录，以及真流式不累积完整回复。

2026-10-18 Playground 抗截断部署验证：`pg-gemini-4-argon-抗截断` 经 OpenAI 真流式请求（`max_tokens=4096`）逐字复制 120 行、13,814 字符样本，共 4 段 4 轮上游调用，结束原因 `stop`，与原文 SHA-256 完全一致；首段 23.1 秒，总耗时 102.0 秒（单次观测，不代表固定延迟）。全部内部调用均走 Playground 页面，未发往 Build。
