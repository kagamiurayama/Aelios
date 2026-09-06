import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { loadConfig, validateConfig } from "./config";

export async function handleGatewayAdmin(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok || !["CHATBOX_API_KEY", "DEBUG_API_KEY"].includes(auth.keyName)) {
    return Response.json({ error: "Owner key required" }, { status: 401 });
  }
  try {
    if (request.method === "GET") return Response.json(await loadConfig(env), { headers: { "cache-control": "no-store" } });
    if (request.method !== "PUT") return Response.json({ error: "Use GET or PUT" }, { status: 405, headers: { allow: "GET, PUT" } });
    let config;
    try { config = validateConfig(await request.json()); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid config" }, { status: 400 }); }
    await env.DB.prepare(`INSERT INTO gateway_config (id, config_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(JSON.stringify(config), new Date().toISOString()).run();
    return Response.json({ ok: true, profiles: config.profiles.length });
  } catch { return Response.json({ error: "Configuration store unavailable. Apply D1 migrations first." }, { status: 503 }); }
}
export function gatewayAdminPage(): Response {
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aelios · 记忆网关</title><style>
:root{color-scheme:dark;font:15px/1.6 system-ui;background:#10151b;color:#e4e9ef}body{max-width:1050px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:8px 0}h2{font-size:19px}p{color:#a6b4c3}a{color:#8ad5ca}section{background:#19212b;border:1px solid #303b49;border-radius:14px;padding:22px;margin:20px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}label{display:block;color:#b8c6d6;font-size:13px;margin:10px 0}input,select,textarea,button{font:inherit;border-radius:7px;border:1px solid #3b4b5e;padding:10px;box-sizing:border-box}input,select,textarea{background:#101720;color:#e4e9ef;width:100%;margin-top:5px}textarea{font:13px/1.6 ui-monospace,monospace;tab-size:2}button{background:#93ded0;color:#122922;cursor:pointer;margin:8px 8px 0 0}button.secondary{background:#293746;color:#e4e9ef}#status{white-space:pre-wrap;color:#93ded0;min-height:26px}small{color:#a6b4c3}details{margin-top:18px}@media(max-width:700px){.grid{grid-template-columns:1fr}body{padding:18px 12px}}
</style><body><small>AELIOS / MEMORY GATEWAY</small><h1>带着记忆，随处接入。</h1><p>一个身份，一份记忆。Chat、Claude Code 和 Codex 使用各自的原生协议，由 Cloudflare 接入上游。</p>
<section><label>管理密钥（CHATBOX_API_KEY 或 DEBUG_API_KEY；仅保留在当前页面）<input id="key" type="password" autocomplete="off"></label><button id="load">读取配置</button><button id="example" class="secondary">填入 CF 示例</button><a href="/admin">记忆管理 →</a></section>
<div class="grid"><section><h2>1 · 添加 Cloudflare 线路</h2><label>线路名称<input id="providerName" placeholder="claude-primary"></label><label>AI Gateway ID<input id="gateway" value="default"></label><label>Provider<select id="provider"><option value="anthropic">Anthropic 原生</option><option value="openai">OpenAI 原生</option><option value="compat">兼容入口 / Dynamic Route</option></select></label><button id="addProvider">添加到草稿</button><p>上游密钥放在 CF AI Gateway 的 BYOK 中。自定义 HTTP 上游、备用线路和 Secret 引用可在下方配置。</p></section>
<section><h2>2 · 添加身份入口</h2><label>对外模型别名<input id="alias" placeholder="my-companion"></label><label>记忆空间<input id="namespace" placeholder="companion-a"></label><label>线路名称<input id="routeProvider" placeholder="claude-primary"></label><label>协议<select id="protocol"><option value="messages">Anthropic Messages</option><option value="responses">OpenAI Responses</option><option value="chat">Chat Completions</option></select></label><label>上游模型或 dynamic/路由名<input id="model" placeholder="填写该线路支持的模型 ID"></label><label>召回方式<select id="memory"><option value="request">每次人类新输入临时召回</option><option value="off">不召回</option></select></label><label>Anthropic thinking<select id="thinking"><option value="passthrough">原样透传（思考开启时跳过注入）</option><option value="drop_block">临时注入兼容（线路须支持 beta）</option></select></label><button id="addProfile">添加到草稿</button></section></div>
<section><h2>3 · 检查并保存</h2><p>同一身份可配置多个协议。routes 数组支持主备目标；本版 Responses 与启用 thinking 的 Messages 固定使用首个目标。上游密钥用 secretHeaders 引用 Worker Secret。</p><textarea id="config" rows="22" spellcheck="false" aria-label="网关配置 JSON">{"version":1,"providers":{},"profiles":[]}</textarea><button id="save">保存配置</button><div id="status" role="status" aria-live="polite"></div><details><summary>接入约定</summary><p>客户端 base URL 为本站 /v1，模型填身份别名。Claude Code 的 ANTHROPIC_BASE_URL 填本站根地址。</p><p>可用 x-aelios-session-id 标识会话，x-aelios-purpose: auxiliary 标记内部任务。Responses 临时记忆使用完整历史和 store:false，不使用上游会话状态。辅助任务也可配置 memory:off、record:false 的独立别名。</p><p>drop_block 允许服务端舍弃前缀不匹配的旧 thinking；仅支持该 beta 的线路可用。临时记忆在工具续轮消失，可能不再影响最终回答。</p></details></section>
<script>
const el=id=>document.getElementById(id),status=message=>el('status').textContent=message;
const draft=()=>JSON.parse(el('config').value),show=config=>el('config').value=JSON.stringify(config,null,2);
function edit(fn){try{const c=draft();fn(c);show(c);status('已更新草稿，保存后生效。')}catch(e){status(e.message)}}
async function api(method){try{const r=await fetch('/api/gateway/config',{method,headers:{authorization:'Bearer '+el('key').value,'content-type':'application/json'},...(method==='PUT'?{body:JSON.stringify(draft())}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);if(method==='GET')show(data);status(method==='PUT'?'已保存。客户端现在可以使用这些身份别名。':'已读取配置。')}catch(e){status(e.message)}}
el('load').onclick=()=>api('GET');el('save').onclick=()=>api('PUT');
el('addProvider').onclick=()=>edit(c=>{const name=el('providerName').value.trim();if(!name)throw Error('请填写线路名称');if(c.providers[name])throw Error('该线路已存在，请在配置中编辑');const p=el('provider').value;c.providers[name]={gateway:el('gateway').value.trim(),provider:p,...(p==='anthropic'?{paths:{messages:'v1/messages'}}:{})}});
el('addProfile').onclick=()=>edit(c=>{const alias=el('alias').value.trim(),provider=el('routeProvider').value.trim(),model=el('model').value.trim(),namespace=el('namespace').value.trim();if(!alias||!namespace||!model||!c.providers[provider])throw Error('请填写身份、空间、模型，并选择已添加的线路');let p=c.profiles.find(p=>p.alias===alias);if(!p){p={alias,namespace,keys:['CHATBOX_API_KEY'],routes:{},memory:el('memory').value,record:true,anthropicThinking:el('thinking').value};c.profiles.push(p)}if(p.namespace!==namespace)throw Error('同一身份的记忆空间必须一致');const protocol=el('protocol').value;if(p.routes[protocol])throw Error('该协议已存在，请在配置中编辑或添加备用线路');p.routes[protocol]=[{provider,model}]});
el('example').onclick=()=>{show({version:1,providers:{'cf-chat':{gateway:'default',provider:'compat'},'cf-claude':{gateway:'default',provider:'anthropic',paths:{messages:'v1/messages'}},'cf-openai':{gateway:'default',provider:'openai'}},profiles:[{alias:'companion',namespace:'companion',keys:['CHATBOX_API_KEY'],routes:{chat:[{provider:'cf-chat',model:'dynamic/companion'}]},memory:'request',record:true,anthropicThinking:'passthrough'}]});status('已填入示例草稿。先在 CF 创建对应 Dynamic Route，或换成你的模型。')};
</script></body></html>`;
