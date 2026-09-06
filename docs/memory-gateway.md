# Aelios 记忆网关（开发分支）

Aelios 负责身份、临时召回和自动记录，客户端 Harness 负责工具循环。
使用 Cloudflare AI binding 直接调用 AI Gateway，无需 LiteLLM 服务或额外模型 SDK。

## Cloudflare 分工

| 组件 | 工作 |
| --- | --- |
| Worker | 原生协议入口、身份解析、单次记忆追加、流式字节透传 |
| AI Gateway | Provider、BYOK、动态路由、限流、用量与上游日志 |
| Workers AI | embedding、reranker、默认 Dream 模型 |
| Vectorize | 按 namespace 检索长期记忆 |
| D1 | 配置、原始可见对话、记忆、去重记录 |
| Queue | 异步记录，失败重试，重复投递幂等 |
| Cron | 对各记录身份的 namespace 运行 Dream、日记与留存清理 |

本轮没有引入 Agents SDK / 自建 loop，也不做三协议之间的转换。
如果后续确需会话状态、推送、长任务，可再引入 Durable Objects / Workflows；本版无影子历史和补丁存储。

## 首次配置

1. 使用 `feat/memory-gateway` 分支，运行 `npm ci`。测试需要 Node.js 24。
2. 按原部署流程创建 D1、Vectorize 和 Queue，应用全部 migrations，包含 `0012_memory_gateway.sql`。`npm run deploy` 的 setup 脚本会应用远程迁移。
3. 在 Cloudflare AI Gateway 中创建网关，将上游密钥存入 BYOK，或配置支持的 Unified Billing。默认网关 ID 为 `default`。
4. 设置 Worker Secret `CHATBOX_API_KEY`，打开 `/admin/gateway`，使用该密钥读取、填写并保存配置。
5. 客户端填写 Aelios 地址、API key、对外模型别名。`GET /v1/models` 返回该密钥可用的别名与协议。

配置优先级：D1 保存的配置 > Worker `GATEWAY_CONFIG` JSON 变量 > 空配置。
空配置的模型列表为空，聊天请求返回配置提示，不会偷偷走旧代理。
管理配置允许 `CHATBOX_API_KEY` / `DEBUG_API_KEY`。旧 MCP 与记忆管理权限不变；跨 namespace 手动编辑或导入记忆仍须 `DEBUG_API_KEY` 并明确填写目标 namespace。

## 配置示例

模型 ID 为格式示例，需换成实际线路支持的模型。两个身份使用不同 namespace；同一身份的多个协议应指向你认可的角色与模型。

```json
{
  "version": 1,
  "providers": {
    "cf-chat": { "gateway": "default", "provider": "compat" },
    "cf-claude": {
      "gateway": "default", "provider": "anthropic",
      "paths": { "messages": "v1/messages" }
    },
    "cf-openai": { "gateway": "default", "provider": "openai" }
  },
  "profiles": [
    {
      "alias": "companion-claude", "namespace": "companion-a",
      "keys": ["CHATBOX_API_KEY"],
      "routes": { "messages": [{ "provider": "cf-claude", "model": "claude-fable-5-1" }] },
      "memory": "request", "record": true,
      "anthropicThinking": "drop_block", "maxMemoryChars": 6000
    },
    {
      "alias": "companion-openai", "namespace": "companion-b",
      "keys": ["IM_API_KEY", "CHATBOX_API_KEY"],
      "routes": {
        "responses": [{ "provider": "cf-openai", "model": "gpt-4.1" }],
        "chat": [{ "provider": "cf-chat", "model": "openai/gpt-4.1" }]
      },
      "memory": "request", "record": true, "anthropicThinking": "passthrough"
    }
  ]
}
```

`gateway` 线路调用 `env.AI.gateway(id).run(...)`。原生 Anthropic path 是 `v1/messages`，OpenAI 是 `responses` / `chat/completions`。
模型命名由线路决定：原生 Anthropic 不带 Provider 前缀，compat 常用 `provider/model` 或 `dynamic/route-name`。
`AI_GATEWAY_ID` 也供旧后台模型调用使用；默认的 Workers AI embedding / Dream 仍可走原生 AI binding。

### 自定义 HTTP 上游与 CF REST

`baseUrl` 与 `gateway` 二选一，URL 须包含版本前缀；网关在末尾添加协议 path。例如：

```json
{
  "baseUrl": "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
  "headers": { "cf-aig-gateway-id": "default" },
  "secretHeaders": {
    "authorization": { "secret": "CLOUDFLARE_API_TOKEN", "prefix": "Bearer " }
  }
}
```

该 CF REST 入口需要 Workers AI Read 权限，且三种协议的模型支持范围不同。
其他 HTTP Provider 使用相同结构；原生 Anthropic 可引用 `x-api-key` Secret、无前缀。
Secret 先从 `GATEWAY_SECRETS` JSON Secret 查找，再查找同名 Worker Secret。凭据不放进 D1 配置，客户端 API key 不转发给上游。
`anthropic-beta`、`anthropic-version`、`openai-beta` 等协议头保留，其他专用头可通过 Provider 配置补充。

## 临时记忆生命周期

| 入口 | 新输入 | 工具续轮 |
| --- | --- | --- |
| `/v1/chat/completions` | 最后一项 user | role=tool 不召回 |
| `/v1/messages` | 最后一项 user，非纯 tool_result | tool_result 内部文字不是用户原话 |
| `/v1/responses` | 字符串 input 或最后一项 user message | function_call_output 等输出不召回 |

纯图片仍原样转发，没有文本 query 时不召回。tool_result 旁有独立 text 块时，按新的用户指令处理。
珍贵原文和召回结果作为参考数据追加到当前消息末尾。原有 system、工具、历史块和 cache_control 不变。
工具续轮不搜索、不恢复旧补丁；下一个人类输入重新召回。没有补丁缓存；请求重试可能再次搜索，但写入按指纹去重。

如果第一响应只调用工具，后续最终回复可能不再看到记忆。“阅后即焚”不表示清除已经产生的模型影响、加密推理或上游日志。

### Anthropic thinking

- `passthrough`：不修改 thinking；思考未显式关闭时跳过记忆注入，响应头标记 `thinking-passthrough`。
- `drop_block`：在每次请求（含工具续轮）合并 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`，以及 `thinking-binding-controls-2026-08-01` beta header。上游可丢弃前缀不匹配的旧 thinking。
- 显式 `thinking.type: "disabled"`：直接临时注入，不添加该 beta。

`drop_block` 仅适用于支持该 beta 的模型与线路，会牺牲部分思考连续性。本版没有实现需要重放历史的 turn-scoped system message，也不把召回资料提升为 system 指令。

### Responses 状态

`memory:"request"` 强制 `store:false`，要求完整显式历史。
含 `previous_response_id`、`conversation`、`item_reference` 时返回 400，避免服务端隐藏历史继续携带补丁。
`reasoning.encrypted_content` 原样通过，不能承诺加密推理里不含记忆影响。要保留上游会话，可另配 `memory:"off"` 别名。

本版支持 HTTP POST + SSE，没有实现 WebSocket、Responses GET/DELETE、后台任务轮询、`/responses/compact`、Anthropic token counting。使用这些额外端点的客户端需要后续适配；还不能声称 Claude Code / Codex 全功能兼容。

## 自动记录与辅助请求

经过网关的原始新用户文本和完整可见助手回复进入 messages 表，供 Dream 使用，无需 Hook。
只观察可见文本；thinking、工具返回文本不作为人类对话入库。Chat Completions 记录第一个 choice。
`gateway_exchanges` 保存操作状态、实际模型/Provider 和可见文本，不保存注入补丁。

- 同一请求重试、Queue 重复投递：稳定指纹 + D1 主键去重。
- 更长历史中再次说相同文字：视为新消息。
- 每个输入/输出记录最多 8000 字符，超限为 truncated，不把截断对话当作完整 Dream 来源。
- 中断、取消、失败：不完整助手输出不进入 Dream。
- 无 Queue 或发送失败：直接写 D1，最终错误记录日志。
- exchanges 与 messages 共用 `MESSAGES_RETENTION_DAYS`。

| 可选请求头 | 用途 |
| --- | --- |
| `x-aelios-session-id` | 区分会话；也读取 session_id、x-session-id、metadata.session_id |
| `x-aelios-request-id` | 区分内容相同但有意重新生成的请求 |
| `x-aelios-purpose: auxiliary` | 标题、压缩、内部任务：不召回，不进入 Dream |

没有 session ID 时，在身份与来源下按完整输入去重；两个全新会话若历史完全相同，会合并为一次输入。
无法可靠识别未标记的机器内部任务。也可给这些任务专门配置 `memory:"off", record:false` 别名。
持久化在响应结束后调度，不是在返回客户端前确认写入；运行时强制终止仍可能丢失末尾记录。

## Fallback 与缓存

CF Dynamic Routes 可承担预算、路由和 fallback。按官方示例使用 compat Chat Completions 和 `dynamic/路由名`，不要推断任意协议都可无损转换。

本地 routes 数组最多 4 项，Chat Completions 及显式关闭 thinking 的 Messages 支持主备。
在尚未交付上游响应时，网络失败或 408/429/500/502/503/504 才尝试下一项，其他错误原样返回。
Responses 与开启 thinking 的 Messages 从首次调用起固定首项，避免续轮 ID/签名落到另一上游；完整自动路由亲和仍待实现。CF 端若自己配置跨 Provider 路由，也须注意这个限制。
跨模型 fallback 仅使用同一身份中显式配置的目标，不按模型名称猜测角色。

旧 assembler、缓存断点/滚动缓存退出三个对外入口；旧 cache REST 路由移除。旧源码暂留供兼容代码与历史校验使用。
新网关不重排前缀，也不添加 prompt cache 断点。CF 端的完整响应缓存与模型 prompt cache 是两回事，前者由 AI Gateway 配置。
响应头 `x-aelios-profile/memory/provider/model` 用于诊断；实际模型与 Provider 优先读取 `cf-aig-model/provider`。

## 验证与下一步

```bash
npm ci
npm run verify
npx wrangler deploy --dry-run
```

15 项网关测试调用生产 TS 模块和实际 SQLite migrations/SQL，替换外部 AI binding、Queue 或 HTTP 上游。
覆盖三协议、临时召回、去重、身份隔离、辅助请求、fallback、SSE Unicode 分块、中断与 Queue 回退。
这是本地验证，不等于已经在真实 CF、Claude Code 或 Codex 中跑过端到端会话。

后续联调优先级：真实原生三协议线路 → Claude thinking beta 透传 → 客户端工具续轮 → 辅助请求识别 → 路由亲和 / 更多协议端点。
每完成一个可验证阶段即提交开发分支，不等整轮联调完成。main 不合并、不部署。

## 官方依据（2026-09-06 核对）

- [Workers Bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [CF REST 三协议](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [CF Anthropic / BYOK](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
- [CF Dynamic Routes](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/)
- [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
