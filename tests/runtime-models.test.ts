import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { handleRuntimeStatus, projectModelControl } from "../src/api/runtimeStatus";
import type { Env } from "../src/types";

const swe = { id: "devin-local/swe-2", label: "SWE-2", provider: "devin-local", providerLabel: "Devin · 本机", family: "SWE", contextLimit: 262000, inputLimit: 200000, image: true, efforts: ["medium", "high", "max"], defaultEffort: "max" };
const claude = { ...swe, id: "devin-local/claude", label: "Claude", family: "Claude" };
const kimi = { ...swe, id: "kimi-code/k3", provider: "managed:kimi-code", providerLabel: "Kimi 官方", family: "Kimi", label: "K3" };
const control = { status: "ready", revision: "a".repeat(64), currentModel: swe.id, currentEffort: "max", usedTokens: 5000, models: [swe, claude, kimi] };
const env = { ERRALIA_RUNTIME_STATUS_URL: "https://control.example/api/v1/miniapp/ashuo/bootstrap" } as Env;
const body = { initData: "signed-fixture", revision: control.revision, model: claude.id, effort: "high" };
const req = (data = body) => new Request("https://ui.example/admin/runtime-settings", { method: "POST", body: JSON.stringify(data) });

test("model projection strips private fields and rejects malformed control", () => {
  const result = projectModelControl({ ...control, identity: "SECRET", models: [{ ...swe, api_key: "SECRET" }] });
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  for (const value of [{ ...control, currentModel: "missing" }, { ...control, currentEffort: "invalid" },
    { ...control, revision: "short" }, { ...control, models: [swe, swe] },
    { ...control, models: [{ ...swe, image: "true" }] }, { ...control, models: [{ ...swe, contextLimit: true }] }]) {
    assert.throws(() => projectModelControl(value));
  }
});

test("settings forwarding is fixed to Ashuo, exact shape and no redirects", async () => {
  let calls = 0;
  const result = await handleRuntimeStatus(req(), env, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://control.example/api/v1/miniapp/ashuo/settings");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return Response.json({ modelControl: control });
  }, true);
  assert.equal(result.status, 200);
  for (const bad of [{ ...body, model: "/model\n/new" }, { ...body, resident: "awen" }, { ...body, effort: "bogus" }]) {
    const response = await handleRuntimeStatus(req(bad), env, async () => { calls++; return Response.json({}); }, true);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 1);
  for (const status of [401, 403, 302, 409, 504]) {
    const response = await handleRuntimeStatus(req(), env, async () => Response.json({ error: "SECRET" }, { status }), true);
    assert.equal((await response.text()).includes("SECRET"), false);
  }
});

function appFixture(fetchImpl: typeof fetch) {
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)![1];
  const app = runInNewContext(`${script}\nmemoryAdmin()`, { localStorage: { getItem: () => null },
    location: { origin: "https://ui.example" }, window: { Telegram: { WebApp: { initData: "signed-fixture" } } }, fetch: fetchImpl });
  app.runtimeStatus = { modelControl: structuredClone(control) };
  app.runtimeSelectedModel = swe.id; app.runtimeSelectedEffort = "max";
  return app;
}

test("provider, family and search combine; current remains visible; preserve supported effort", () => {
  const app = appFixture(async () => Response.json({}));
  assert.equal(app.runtimeFilteredModels().length, 2);
  app.runtimeFamily = "Claude";
  assert.equal(app.runtimeFilteredModels()[0].id, claude.id);
  app.runtimeSearch = "not found"; assert.equal(app.runtimeFilteredModels().length, 0);
  assert.match(app.runtimeCurrentLabel(), /SWE-2/);
  app.runtimeSelectModel(claude); assert.equal(app.runtimeSelectedEffort, "max");
  app.runtimeSelectModel({ ...claude, efforts: ["low", "high"], defaultEffort: "high" });
  assert.equal(app.runtimeSelectedEffort, "high");
});

test("double click sends once, exact confirmed result updates UI, uncertain errors disable retry", async () => {
  let calls = 0;
  let finish: (response: Response) => void = () => {};
  const app = appFixture(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
  app.runtimeSelectModel(claude);
  const running = app.saveRuntimeModel();
  await app.saveRuntimeModel(); assert.equal(calls, 1);
  finish(Response.json({ ok: true, data: { modelControl: { ...control, currentModel: claude.id } } }));
  await running;
  assert.equal(app.runtimeControl().currentModel, claude.id);
  assert.match(app.runtimeModelMessage, /已确认/);
  const failed = appFixture(async () => { throw new Error("network failed"); });
  failed.runtimeSelectModel(claude); await failed.saveRuntimeModel();
  assert.equal(failed.runtimeCanSwitch(), false);
  assert.equal(failed.runtimeControl().currentModel, swe.id);
});

test("busy and smaller context never send a control request", async () => {
  let calls = 0;
  const app = appFixture(async () => { calls++; return Response.json({}); });
  app.runtimeSelectModel(claude); app.runtimeControl().status = "busy";
  await app.saveRuntimeModel();
  app.runtimeControl().status = "ready";app.runtimeControl().usedTokens = 200000;
  await app.saveRuntimeModel();
  assert.equal(calls, 0);
  assert.match(app.runtimeModelMessage, /上限/);
});

test("advertised counts and unconfigured models remain visible and are never selectable", () => {
  const source = { id: "devin-local", label: "Devin", checkedAt: "2026-10-16T00:00:00Z", advertised: 3, configured: 2,
    pending: [{ id: "vertex/gemini-4-argon", label: "vertex/gemini-4-argon", family: "Gemini", reason: "missing limits", api_key: "SECRET" }] };
  const projected = projectModelControl({ ...control, catalogSources: [source] });
  assert.equal(JSON.stringify(projected).includes("SECRET"), false);
  assert.throws(() => projectModelControl({ ...control, catalogSources: [{ ...source, configured: 3 }] }));
  const app = appFixture(async () => Response.json({}));
  app.runtimeControl().catalogSources = [source];
  assert.match(app.runtimeCatalogSummary(), /3 项，已配置 2，待配置 1/);
  app.runtimeFamily = "Gemini";
  assert.equal(app.runtimeFilteredModels().length, 0);
  assert.equal(app.runtimePendingModels().length, 1);
  app.runtimeSearch = "missing-name";
  assert.equal(app.runtimePendingModels().length, 0);
  assert.match(ADMIN_HTML, /aria-disabled="true"/);
});

test("model selected and field colors use both-theme variables, never a hardcoded dark fill", () => {
  assert.match(ADMIN_HTML, /\.runtime-model-option\.is-selected\s*\{[^}]*color: var\(--text-1\);[^}]*background: var\(--hover-bg\)/);
  assert.match(ADMIN_HTML, /\.runtime-model-field option\s*\{[^}]*color: var\(--text-1\)/);
  assert.equal(ADMIN_HTML.includes('bg-[#20191a]'), false);
  assert.match(ADMIN_HTML, /:aria-pressed="runtimeSelectedModel === model.id"/);
});
