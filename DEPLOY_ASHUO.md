# 阿朔的 Aelios 独立部署（DEPLOY）

独立实例（与 aheng 的 companion-memory-proxy 隔离）：worker `ashuo-companion-memory-proxy`，D1 `ashuo_companion_memory`，Vectorize `ashuo-memo-kb`，Queue `ashuo-companion-memory`。dream cron 已错峰至 `10 22 * * *`（UTC，北京时间 06:10；aheng 的是 04:10）。

## 部署（VPS 上执行）

```bash
# 1. 山山先填好 CF 凭据（一次性）
nano /home/ubuntu/ashuo/secrets/cloudflare.env   # 0600: ACCOUNT_ID + API_TOKEN

# 2. 一键建库 + 部署
source /home/ubuntu/ashuo/secrets/cloudflare.env
/home/ubuntu/ashuo/bin/aelios_deploy.sh          # 内部跑 npm run deploy:cloudflare

# 3. 生成并灌入两把钥匙（deploy 成功后）
cd /home/ubuntu/ashuo/aelios
echo "$(openssl rand -hex 24)" | npx wrangler secret put CHATBOX_API_KEY --name ashuo-companion-memory-proxy
echo "$(openssl rand -hex 24)" | npx wrangler secret put MEMORY_MCP_API_KEY --name ashuo-companion-memory-proxy
# 两把钥匙另存 /home/ubuntu/ashuo/secrets/aelios.env（0600）
```

## MCP 挂接（两台机器各自的 ~/.kimi-code/mcp.json）

```json
{
  "mcpServers": {
    "aelios": {
      "url": "https://ashuo-companion-memory-proxy.<子域>.workers.dev/mcp?token=<MEMORY_MCP_API_KEY>"
    }
  }
}
```

mcp.json 含 token，权限 0600。只接主动工具（search/recall/upsert/boot/diary），不接自动注入 hook。

## 数据边界（山山 2026-08-14 批准的三条）

1. 只写运维层记忆（位置、进度、决策、承诺）；Erralia 私密内容、阿问私货不入。
2. 独立实例，与 aheng 物理隔离（不同 D1/Vectorize/Queue）。
3. 不接每轮自动召回/写回 hook。
