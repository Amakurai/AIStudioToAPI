# Build Chat 链路（`bdc-`）

`bdc-` 前缀的模型走 AI Studio Build 编辑器左侧的对话助手（Build Chat）。它和 `build-`（Build App 运行时）、`pg-`（Playground）是三条互不回退的独立链路，共用已登录的账号池和 API 格式转换。

## 为什么需要这条链路

同样是 Build，额度来源不同：

| 链路                   | 实际请求                                                      | 额度判定                                                                                             |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `build-`（App 运行时） | `MakerSuiteService/ProxyUnaryCall`，原样转发给公开 Gemini API | Gemini API 的 `GenerateRequestsPerProjectPerUserPerModelPerDay`（2026-10-17 起 Argon 为 `limit: 0`） |
| `bdc-`（Build Chat）   | `MakerSuiteService/CodeAssistantOffline`                      | AI Studio 网页端，按 `x-aistudio-g1-tier` 订阅档位                                                   |
| `pg-`（Playground）    | `MakerSuiteService/GenerateContent`                           | AI Studio 网页端，按 `x-aistudio-g1-tier` 订阅档位                                                   |

三者都带 `x-aistudio-g1-tier` 请求头，但只有 `ProxyUnaryCall` 会转给公开 API 检查项目额度，所以 Build 编辑器里能用的 Argon，在 `build-` 链路上会返回 429。

## 模型

列表来自 `configs/buildchat-models.json`，对应 Build 编辑器 “Settings → Chat” 的模型菜单：

`bdc-gemini-4-argon`、`bdc-gemini-3.8-flash`、`bdc-gemini-3.6-flash`、`bdc-gemini-3.5-flash-lite`、`bdc-gemini-3.1-flash-lite`、`bdc-gemini-3-flash-preview`、`bdc-gemini-flash-latest`、`bdc-gemini-flash-lite-latest`

- `GET /v1/models` 中 `upstream_channel` 为 `buildchat`，控制台“模型通道”单独列出 Build Chat。
- 思考等级后缀照常生效（如 `bdc-gemini-4-argon-low`）。
- 没有抗截断别名：`bdc-…-抗截断` 在本地返回 400。
- 设置 `BUILD_CHAT_ENABLED=false` 并重启可关闭本链路：`bdc-*` 不再列出，请求返回 400。

## 能力和限制

Build Chat 是写代码的 Agent，不是普通聊天模型：

- **服务端自带系统提示词**（约 1.8 万 token，大部分命中缓存）。客户端的系统指令会作为第一轮用户消息的开头文字一并发送，无法替换 Agent 本身的提示词。
- **只支持文本**：图片、文件、函数工具、`cachedContent` 在本地返回 400；Google 搜索等内置工具和温度、`max_tokens` 等采样参数被忽略（请求里没有对应字段）。
- **可能执行 Agent 流程**：对“写几行关于大海的诗”这类请求，Agent 可能把它当成建 App，读写文件、编译、检查后才给出回答（实测 2～3 分钟），回答里会附带它对 App 的说明。简单问答通常一步完成。
- 支持的接口：OpenAI Chat Completions、Responses、Claude Messages、Gemini `generateContent` / `streamGenerateContent`。`countTokens`、嵌入、语音、文件上传等在本地返回 400。

## 每次请求的流程

每个账号使用一个专用页面，同一账号内串行，不同账号并发：

1. 在 Build 起始页的输入框填入对话文本，点 Send，截获页面签好名的 `CodeAssistantOffline` 请求。这个请求在本地应答，不会进入推理；页面随之发出的建 App、建 Cloud 项目、最近记录、日志等请求也都在本地应答，账号里不会因此新增内容。
2. 用 `CreateApplet` 新建一个**临时 App**，把请求中的对话、模型和 App ID 换成本次请求的值后发出，得到 generationId。
3. 用 `StreamCodeAssistantOfflineGeneration` 读取运行轨迹，读到结尾后再读一次确认没有新步骤（已结束的运行再读只需不到 1 秒）；读取提前关闭时继续读，最多 6 次。
4. 用 `DeleteApplet` 删除临时 App。删除失败（网络错误、请求中途取消等）的 App ID 记录在 `data/buildchat-applets.json`，由该账号的下一次请求先行删除。

签名覆盖的是各段文本以空格拼接后的内容（与 Playground 相同），所以多轮对话把各轮文本拼接后填入输入框签名，再以结构化的多轮内容发送。首尾空白会被去掉；签名内容与请求内容不一致时返回 400。起始页输入框有时是 `contenteditable="plaintext-only"` 元素（本浏览器无法键入），此时直接写入文本并触发 input 事件。

每个临时 App 只用一次，因此每次请求都会落在 App 的首次生成上，比在已用过的 App 上慢：简单问答实测约 20～30 秒（签名和建 App 约 4 秒，其余为生成）。

## 响应转换

一次运行由若干编号步骤组成（用户消息、模型回合、读文件、改文件、编译等）。每次更新是某个步骤的完整快照，一次更新也可能同时带多个步骤：

- 只有模型回合的正文成为输出，按步骤顺序拼接，读文件、改代码等工具步骤不返回。思考内容仅在 `includeThoughts: true` 时返回。
- 真流式按快照增长输出增量；缓冲模式和非流式在运行结束后一次返回。实测服务端在整次运行结束后才一次发回全部数据，所以真流式也要等到最后。
- token 用量为本次运行所有模型调用之和（输入含缓存部分）。
- 最新步骤已完成、且至少有一个模型回合带正文，再读一次没有新步骤，才算结束；否则返回 502。

## 错误和账号

- 与 Playground 一样，`bdc-` 请求不计入 `SWITCH_ON_USES` / `FAILURE_THRESHOLD`，不冷却、不切换 Build 账号；按 `bdc` 自己的负载在账号间分发。
- 上游偶尔拒绝签好名的请求（`403 The caller does not have permission`）。此时推理尚未开始，会等 3 秒、6 秒后重新签名，最多两次；仍被拒才按鉴权失败处理：对该账号和模型冷却 5 分钟，连续被拒时翻倍（最长 6 小时），并让请求换到未尝试的账号。
- 限流、网络和服务错误冷却 1 分钟；签名阶段的页面自动化故障（没有上游状态码）不冷却账号，直接换号重试。

## 测试

离线：`node tests/buildchat.test.js`（协议编解码、Agent 轨迹解析、多次读取、临时 App 清单、路由和拒绝规则）。

2026-10-20 在独立容器中用一个 ULTRA 账号实测：8 个模型的单轮问答、带系统指令的中文多轮对话、对话隔离（上一请求的内容不可见）、Claude 接口、真流式均返回正确结果；“写四行关于大海的诗”触发 Agent 流程，141 秒后返回诗句和 App 说明；所有临时 App 均已删除。
