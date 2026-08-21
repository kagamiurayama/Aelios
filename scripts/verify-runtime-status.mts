import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { handleRuntimeStatus, projectAshuoRuntimePanel } from "../src/api/runtimeStatus";
import type { Env } from "../src/types";

const endpoint = "https://control.example/api/v1/miniapp/ashuo/bootstrap";
const env = { ERRALIA_RUNTIME_STATUS_URL: endpoint } as Env;
const panel = {
  schema: "erralia.miniapp.panel.v0",
  residentId: "ashuo",
  residentLabel: "阿朔",
  available: true,
  stale: false,
  errorLabel: "Kimi 额度暂不可用",
  collectedAt: "2026-08-21T12:00:00Z",
  currentModel: "kimi-k3",
  secretFutureField: "must-not-cross",
  windows: [
    {
      id: "kimi_1",
      label: "本周额度",
      icon: "◇",
      percentage: { meaning: "used", value: 37 },
      resetAt: "2026-08-28T12:00:00Z"
    }
  ]
};

function request(body: unknown): Request {
  return new Request("https://aelios.example/admin/runtime-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

let calls = 0;
const okFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  calls += 1;
  assert.equal(String(input), endpoint);
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("user-agent"), "Aelios-Runtime-Status/1.0");
  assert.deepEqual(JSON.parse(String(init?.body)), { initData: "signed-telegram-data" });
  return new Response(JSON.stringify(panel), { status: 200 });
};

const good = await handleRuntimeStatus(request({ initData: "signed-telegram-data" }), env, okFetch);
assert.equal(good.status, 200);
const goodBody = await good.json() as { ok: boolean; data: Record<string, unknown> };
assert.equal(goodBody.ok, true);
assert.equal(goodBody.data.residentId, "ashuo");
assert.equal("currentModel" in goodBody.data, false);
assert.equal("secretFutureField" in goodBody.data, false);
assert.equal(calls, 1);

for (const badBody of [
  {},
  { initData: "" },
  { initData: "x", extra: true },
  { initData: "x".repeat(16_385) }
]) {
  const response = await handleRuntimeStatus(request(badBody), env, okFetch);
  assert.equal(response.status, 400);
}
assert.equal(calls, 1, "invalid requests must fail before any upstream call");

const notConfigured = await handleRuntimeStatus(
  request({ initData: "signed-telegram-data" }),
  {} as Env,
  okFetch
);
assert.equal(notConfigured.status, 503);
assert.equal(calls, 1);

assert.throws(
  () => projectAshuoRuntimePanel({ ...panel, residentId: "awen" }),
  /runtime_status_contract_invalid/
);
assert.throws(
  () => projectAshuoRuntimePanel({ ...panel, windows: [{ ...panel.windows[0], percentage: { meaning: "remaining", value: 37 } }] }),
  /runtime_status_contract_invalid/
);

const unauthorized = await handleRuntimeStatus(
  request({ initData: "signed-telegram-data" }),
  env,
  async () => new Response('{"error":"private-upstream-detail"}', { status: 401 })
);
assert.equal(unauthorized.status, 401);
assert.deepEqual(await unauthorized.json(), { ok: false, error: "telegram_auth_failed" });

const ui = await readFile(new URL("../src/api/admin/ui.ts", import.meta.url), "utf8");
assert.match(ui, /moreView === 'runtime'/);
assert.match(ui, /\/admin\/runtime-status/);
assert.doesNotMatch(ui, /runtime-status[\s\S]{0,400}(switch|modelOptions|thinkingOptions)/i);

const inlineScripts = Array.from(
  ADMIN_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  (match) => match[1]
).filter((script) => script.trim());
assert.ok(inlineScripts.length >= 3);
for (const script of inlineScripts) new Function(script);

assert.match(ADMIN_HTML, /运行状态/);
assert.match(ADMIN_HTML, /只读显示；不会切换模型，也不会修改当前会话。/);
const runtimeSection = ADMIN_HTML.match(
  /<div x-show="moreView === 'runtime'"[\s\S]*?<div x-show="moreView === 'precious'"/
);
assert.ok(runtimeSection);
assert.doesNotMatch(
  runtimeSection[0],
  /(modelOptions|thinkingOptions|selectModel|selectThinking|CONTROL_ENDPOINT|\/settings)/
);

console.log("runtime status verification: ok");
