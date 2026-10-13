# Build / Playground 自动分流

默认启用 Playground 生成通道，复用 BrowserManager 中已经登录的 Google 账号和现有账号池。不需要增加 Cookie 配置、导入 Cookie 或运行另一套登录服务。

## 路由规则

- `gemini-4-argon` 和 `gemini-4-argon-抗截断` 默认使用 Playground。原有模型优先使用 Build。
- Build 首次响应为明确的权限错误（403 `PERMISSION_DENIED`）、模型不存在（404）或模型额度上限为 0（429 `limit: 0`）时，在同一账号上尝试 Playground。成功后将该模型的通道偏好保存到 `data/model-routes.json`，重启后继续生效。
- 普通额度耗尽、服务故障和内容过滤不触发通道切换，继续由原有错误处理和账号轮换流程处理。Build 已开始成功响应的请求不会中途切换通道。
- Playground 页面加载时会读取原生模型目录。目录中新发现的生成模型会加入当前进程的模型列表并标为 Playground；已配置的 Build 模型保留原通道。首次 Playground 请求之前，列表以 `configs/models.json` 为准。
- 控制台“模型通道”展示分组；`GET /v1/models` 的 `upstream_channel` 和 `GET /v1beta/models` 的 `upstreamChannel` 返回 `build` 或 `playground`。抗截断别名继承基础模型通道。分组表示首选通道，不保证每个账号都有模型权限。

设置 `PLAYGROUND_ENABLED=false` 并重启可关闭此功能，所有请求恢复使用 Build。

## 请求和响应

现有 OpenAI、Gemini、Anthropic 请求先走原有转换流程，再自动选用生成通道。普通模型和抗截断别名的调用方法不变。例如：

```json
{
  "model": "gemini-4-argon-抗截断",
  "messages": [{ "role": "user", "content": "请输出完整答案。" }],
  "stream": true
}
```

Playground 适配层支持文本、多轮对话、系统指令、函数调用和工具回传、内联媒体及常用生成参数；保留工具调用 ID、思考签名、结束原因和 token 用量。原生分块响应转换为 Gemini JSON/SSE，再交给现有 API 格式转换器。抗截断版本继续使用原有的分段工具传输和确认续写机制。

每个活跃账号按需创建一个专用临时 Playground 页面，该账号内的 Playground 请求串行执行，不同账号可以并发。页面由现有浏览器上下文管理，关闭账号上下文时一起释放。

适配层在临时页面中提交与原始内容具有相同签名材料的文本，拦截原生生成请求取得当次请求的签名及权益请求头；这次界面提交不进入推理服务。随后使用完整结构化请求在同一页面发起真实生成。原生签名材料不一致时明确报错，不发送内容被改变的请求。鉴权请求头仅驻留内存，不写入路由文件或日志。取消或超时会停止专用页面的请求；响应被截断时返回错误，不伪装成正常完成。

## 当前边界

- 自动分流适用于 `generateContent` 和 `streamGenerateContent`。文件上传、嵌入、`countTokens`、批处理等端点仍沿用 Build，可能受该通道权限限制。
- MakerSuite 是网页内部协议。网页结构、请求头或协议改变时可能需要更新适配层；首次加载和每轮取得原生签名会增加延迟。
- 原生协议没有公开的强制函数选择字段。`ANY` 通过函数白名单和指令表达，不能保证与公开 API 的强制解码完全等价；抗截断流程另有调用与序号校验。`NONE` 禁用自定义函数。
- 结构化 schema 使用 MakerSuite 支持的字段；`$ref`、`additionalProperties`、`default` 等 JSON Schema 扩展不能完整表达。网页搜索等内置工具可编码，但搜索引用、完整安全评分、logprobs 等响应附加元数据尚未完整转换。
- 已实测的核心路径是 Argon 文本、工具调用及抗截断传输；多模态及其他 Playground 模型仍取决于上游支持和账号权限。

## 协议参考与验证

协议字段参考 [DeconstructedCube/aistudio-api 的 WIRE_SPECIFICATION.md](https://github.com/DeconstructedCube/aistudio-api/blob/6d1f243b811834a88fecac5615e6a161ea112efb/docs/WIRE_SPECIFICATION.md)。本项目独立实现适配代码，保留现有 Node.js 服务、浏览器登录和账号池，未引入参考项目的 Cookie 获取与登录流程。

离线回归：`node tests/playground.test.js`。覆盖协议分块、工具参数、签名字段、通道持久化、回退边界、取消、超时、残缺流和过期请求隔离。`tests/duplex-live.js --run --model=gemini-4-argon` 是明确发起真实模型请求的长文本校验工具，会消耗上游额度。

2026-10-13 部署验证：Argon 的 OpenAI 真流式请求与抗截断请求返回成功；真实函数调用及工具结果回传完成；120 行、13,814 字符的抗截断输出与校验原文 SHA-256 完全一致（约 84 秒）。原有 `gemini-3.8-flash` 生成请求亦返回成功。离线回归共 274 项通过，源码 ESLint、样式检查及前端构建通过（保留既有 Vue `v-html` 和构建体积警告）。
