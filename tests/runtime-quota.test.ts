import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ADMIN_HTML } from "../src/api/admin/ui";
import { handleRuntimeStatus, projectAshuoRuntimePanel } from "../src/api/runtimeStatus";
import type { Env } from "../src/types";

const collectedAt = "2026-10-16T00:00:00Z";
const devin = {
  id: "devin", label: "Devin", available: true, stale: false, collectedAt,
  freshForSeconds: 120, errorLabel: "Devin 额度暂不可用", session_token: "SECRET",
  windows: [
    { id: "devin_daily", label: "每日剩余", percentage: { meaning: "remaining", value: 0 }, resetAt: "2026-10-16T08:00:00Z" },
    { id: "devin_weekly", label: "每周剩余", percentage: { meaning: "remaining", value: 100 }, resetAt: "2026-10-18T08:00:00Z" }
  ]
};
const kimi = {
  id: "kimi", label: "Kimi", available: false, stale: true, collectedAt: null,
  freshForSeconds: 120, errorLabel: "Kimi 额度暂不可用", windows: []
};
const panel = {
  schema: "erralia.miniapp.panel.v0", residentId: "ashuo", available: false,
  stale: true, collectedAt: null, errorLabel: "Kimi 额度暂不可用", windows: [],
  quotaSources: [kimi, devin]
};

test("Kimi failure cannot hide Devin; projection only exposes quota fields", () => {
  const result = projectAshuoRuntimePanel(panel);
  const sources = result.quotaSources as Record<string, unknown>[];
  assert.equal(sources[0].available, false);
  assert.equal(sources[1].available, true);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.deepEqual(sources[1].windows, devin.windows);
  const old = { ...panel, quotaSources: undefined };
  assert.equal("quotaSources" in projectAshuoRuntimePanel(old), false);
});

test("invalid source identity, remaining range, duplicates and incomplete quotas fail closed", () => {
  for (const source of [
    { ...devin, id: "other" }, { ...devin, freshForSeconds: true },
    { ...devin, windows: devin.windows.slice(0, 1) },
    { ...devin, windows: [devin.windows[0], devin.windows[0]] },
    ...[true, null, 101, -1, NaN, "99"].map(value => ({ ...devin, windows: [
      { ...devin.windows[0], percentage: { meaning: "remaining", value } }, devin.windows[1]
    ] })),
    { ...devin, windows: [{ ...devin.windows[0], percentage: { meaning: "used", value: 0 } }, devin.windows[1]] }
  ]) assert.throws(() => projectAshuoRuntimePanel({ ...panel, quotaSources: [source] }), /contract_invalid/);
  assert.throws(() => projectAshuoRuntimePanel({ ...panel, quotaSources: [devin, devin] }), /contract_invalid/);
});

test("authenticated proxy retains independent sources, rejects redirects and hides upstream errors", async () => {
  const env = { ERRALIA_RUNTIME_STATUS_URL: "https://control.example/api/v1/miniapp/ashuo/bootstrap" } as Env;
  const request = () => new Request("https://aelios.example/admin/runtime-status", {
    method: "POST", body: JSON.stringify({ initData: "signed-fixture" })
  });
  const result = await handleRuntimeStatus(request(), env, async (_url, init) => {
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(init?.body)), { initData: "signed-fixture" });
    return Response.json(panel);
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json() as any).data.quotaSources[1].available, true);
  for (const code of [401, 403, 500, 302]) {
    const failed = await handleRuntimeStatus(request(), env, async () => new Response("SECRET", { status: code }));
    assert.equal(failed.status, code === 401 || code === 403 ? 401 : 502);
    assert.equal((await failed.text()).includes("SECRET"), false);
  }
});

function appFixture(fetchImpl: typeof fetch = async () => Response.json({ ok: true, data: panel })) {
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)![1];
  let tick: () => void = () => {};
  let cleared = false;
  const app = runInNewContext(`${script}\nmemoryAdmin()`, {
    localStorage: { getItem: () => null }, location: { origin: "https://aelios.example" },
    window: { Telegram: { WebApp: { initData: "signed-fixture" } } },
    fetch: fetchImpl, setInterval: (callback: () => void) => { tick = callback; return 1; },
    clearInterval: () => { cleared = true; }
  });
  app.icons = () => {};
  return { app, tick: () => tick(), cleared: () => cleared };
}

test("UI distinguishes used/remaining and freshness independently, including expired open page", async () => {
  const fixture = appFixture();
  const app = fixture.app;
  await app.loadRuntimeStatus();
  assert.equal(app.runtimeQuotaSources().length, 2);
  app.runtimeNow = Date.parse(collectedAt) + 1000;
  assert.equal(app.runtimeSourceStatus(devin), "数据新鲜");
  assert.equal(app.runtimeSourceStatus(kimi), "读取失败");
  app.runtimeNow += 120000;
  assert.equal(app.runtimeSourceStatus(devin), "数据可能陈旧");
  assert.equal(app.runtimePercentLabel(devin.windows[0]), "0%");
  assert.equal(app.runtimeVisualPercent(devin.windows[1]), 100);
  assert.match(app.runtimeResetLabel(devin.windows[0]), /2026/);
  fixture.tick();
  assert.ok(Math.abs(app.runtimeNow - Date.now()) < 1000);
  app.destroy();
  assert.equal(fixture.cleared(), true);
  assert.match(ADMIN_HTML, /meaning === 'remaining' \? '剩余 ' : '已用 '/);
});

test("failed refresh clears old quota instead of presenting stale success", async () => {
  const { app } = appFixture(async () => { throw new Error("fixture network unavailable"); });
  app.runtimeStatus = panel;
  await app.loadRuntimeStatus();
  assert.equal(app.runtimeStatus, null);
  assert.ok(app.runtimeStatusError);
  assert.equal(app.runtimeStatusLoading, false);
});

test("old daemon continues rendering the original Kimi panel", () => {
  const { app } = appFixture();
  app.runtimeStatus = { ...panel, quotaSources: undefined };
  const sources = app.runtimeQuotaSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "kimi");
  assert.equal(app.runtimeSourceStatus(sources[0]), "读取失败");
});
