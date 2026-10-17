# Build / Playground 双链路

一套服务，两条互不依赖的生成链路，共用已登录的 Google 账号池、API 格式转换和账号轮换。Playground 复用 BrowserManager 中已经登录的账号上下文，不需要增加 Cookie 配置或另一套登录服务。

## 模型命名

| 前缀     | 链路           | 模型列表来源                                           | 抗截断                                   |
| -------- | -------------- | ------------------------------------------------------ | ---------------------------------------- |
| `build-` | Build App 代理 | `configs/models.json`                                  | 支持（`build-gemini-4-argon-抗截断` 等） |
| `pg-`    | Playground     | `configs/playground-models.json` + Playground 原生目录 | 不支持                                   |

- 模型名前缀唯一决定链路，请求进入时剥掉前缀再发往上游，例如 `build-gemini-4-argon` 与 `pg-gemini-4-argon` 是同一个上游模型的两条链路。思考等级、流式模式和内置工具后缀照常叠加在后面（如 `pg-gemini-4-argon-high`）。
- 两条链路互不回退：Build 的 403、404、429、400 等错误直接按 Build 原有的重试与换号流程处理，不会改走 Playground；Playground 的错误同样只在 Playground 内处理。
- 不带前缀的旧模型名（如 `gemini-3.8-flash`）仍按 Build 处理，兼容现有客户端，但不再出现在模型列表中。
- `GET /v1/models` 与 `GET /v1beta/models` 分别列出 `build-*` 与 `pg-*` 模型，`upstream_channel`/`upstreamChannel` 字段为 `build` 或 `playground`。控制台“模型通道”按链路分组展示。
- Playground 页面加载时读取原生模型目录，可生成内容的模型加入 Playground 列表（不影响 Build 列表），token 上限覆盖配置值，并保存到 `data/playground-models.json`，重启后立即恢复。旧版 `data/model-routes.json` 中保存的目录会在首次启动时读取一次，其中的通道学习记录不再使用。
- `pg-` 模型只支持内容生成（OpenAI Chat Completions、Responses、Claude Messages、Gemini `generateContent`/`streamGenerateContent`）。抗截断、`countTokens`、嵌入、文件上传、模型详情等请求在本地返回 400，不会改发到 Build。

## 账号与并发

两条链路共用同一个账号池，但互不改动对方的账号状态：

- 同一账号可以同时处理 Build 和 Playground 请求：Build 使用 Build App 页面，可并发；Playground 使用该账号的专用临时页面，同一账号内串行，不同账号之间并发。默认 `MAX_CONTEXTS=1` 时池中只有一个账号，两条链路的请求都会落在这个账号上。
- 分发时两条链路各自按负载选择账号：Build 只统计 Build 的在途请求，Playground 只统计 Playground 的在途请求，在 Playground 排队的请求不会让 Build 避开该账号。
- `pg-` 请求不计入 `SWITCH_ON_USES` 轮换次数和 `FAILURE_THRESHOLD` 失败次数。Playground 的 429/503 不会冷却账号，也不会切换当前账号或重排账号池；这类错误只会让该请求改用尚未尝试的其他就绪账号，没有可用账号时直接返回错误。Playground 取消请求时也不会向 Build 页面发送指令。
- 两条链路的 400（如输入 token 超限、参数错误）和 413 与账号无关：不重试、不计入失败次数、不触发换号，直接返回给客户端；`API_KEY_INVALID` 等与账号相关的 400 仍按原流程处理。
- Build 自身的轮换、冷却和换号仍按原规则进行。如果 Build 关闭了某个账号的上下文，该账号上正在进行的 Playground 请求会随之失败。

Playground 的鉴权失败对该账号和模型冷却 5 分钟，连续被拒时每次翻倍（10、20、40 分钟……最长 6 小时），成功一次即清零；限流、网络和服务错误冷却 1 分钟（仅保存在内存中）。分发 `pg-` 请求时优先跳过对该模型正在冷却的账号，只有全部账号都在冷却时才返回冷却错误。首次明确鉴权失败且尚未输出时，以及冷却期间，快速返回可触发现有账号切换机制的 503，不重复等待同一个失败通道；成功后清除冷却。内容过滤和参数错误不进入此冷却；格式错误的请求（如缺少 `parts`）在本地返回不可重试的 400。请求在同账号队列中等待超时时，账号并无故障且尚未发送，返回可换号的 503，不进入冷却；界面提交阶段超时同样尚未推理，允许换号重试。

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

Playground 适配层支持文本、多轮对话、系统指令、函数调用和工具回传、内联媒体及常用生成参数；保留工具调用 ID、思考签名、结束原因和 token 用量。原生分块响应转换为 Gemini JSON/SSE，再交给现有 API 格式转换器。与公开 API 一致，只有 `includeThoughts: true` 时才返回思考内容；仅设置 `thinkingLevel`/`thinkingBudget` 或未设置思考配置时不返回，界面模板默认的显示思考也会被关闭。生成参数同时接受 camelCase 与 snake_case 写法。安全设置中 MakerSuite 未提供的公开类别（如 `HARM_CATEGORY_CIVIC_INTEGRITY`）保持原生默认，不再导致 400。

Build 抗截断模型的 OpenAI 输出使用独立配置 `ANTI_TRUNCATION_STREAMING_MODE=real`（默认），每段完成校验后立即发出，不再受普通模型的 `STREAMING_MODE=fake` 影响。需要完整缓冲时可显式设置为 `fake`。

普通 OpenAI 模型使用 `STREAMING_MODE=fake` 时，等待上游完整生成后才输出正文。等待响应头和收集正文期间，每 12–18 秒发送两条空的 OpenAI SSE 数据帧，兼容过滤注释心跳、保留最后一帧的中转层；心跳不包含正文、用量或结束标记。完整正文按最多 128 个 Unicode 字符分块并短暂停顿后发送，工具参数与最终用量保持完整。生成前的心跳只用于保活，并不代表模型已经开始输出正文。

每个活跃账号按需创建一个专用临时 Playground 页面，该账号内的 Playground 请求串行执行，不同账号可以并发。同一模型在 10 分钟内复用页面，通过原生新对话及丢弃确认重置历史；模型改变、页面过期或重置失败时重新加载。每次仍获取新签名，签名材料和模型不匹配时只允许在推理之前重建页面重试。页面由现有浏览器上下文管理，关闭账号上下文时一起释放。文本中的 CRLF/CR 换行在签名和发送前统一为 LF，与网页输入框的签名材料保持一致。

`FAKE_STREAM_TIMEOUT_MS` 限制排队、准备及首块（缓冲模式下为完整响应）的总时长。真流式开始输出后改为按块间空闲时间（`STREAM_TIMEOUT_MS`，默认 60 秒）判断超时，与 Build 真流式一致，持续输出的长回复不会被总时长截断。

适配层在临时页面中提交与原始内容具有相同签名材料的文本，拦截原生生成请求取得当次请求的签名及权益请求头；这次界面提交不进入推理服务。随后使用完整结构化请求在同一页面发起真实生成。原生签名材料不一致时明确报错，不发送内容被改变的请求。流式读取直接等待浏览器 reader 的下一块数据，不再定时轮询或维护浏览器生产队列；真流式转发只跟踪完成状态，不额外累计整份回复。

鉴权请求头仅驻留内存，不写入路由文件或日志。取消或超时会停止专用页面的请求；响应被截断时返回错误，不伪装成正常完成。

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
