import type { Env } from "../types";

const MAX_INIT_DATA_CHARS = 16_384;
const MAX_UPSTREAM_BYTES = 65_536;
const PANEL_SCHEMA = "erralia.miniapp.panel.v0";
const RESIDENT_ID = "ashuo";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error("runtime_status_contract_invalid");
  }
  return value;
}

function printableText(value: unknown, maxChars: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the whole point is detecting control characters
  if (typeof value !== "string" || value.length > maxChars || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("runtime_status_contract_invalid");
  }
  return value;
}

export function projectModelControl(raw: unknown): Record<string, unknown> {
  if (!isObject(raw) || !["ready", "busy", "unavailable"].includes(String(raw.status))) throw new Error("runtime_status_contract_invalid");
  if (raw.status === "unavailable") return { status: "unavailable", models: [] };
  if (!Array.isArray(raw.models) || raw.models.length > 200 ||
      typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new Error("runtime_status_contract_invalid");
  const seen = new Set<string>();
  const allowedEfforts = new Set(["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const models = raw.models.map(row => {
    if (!isObject(row)) throw new Error("runtime_status_contract_invalid");
    const id = printableText(row.id, 160);
    if (seen.has(id) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(id) ||
        !Number.isInteger(row.contextLimit) || Number(row.contextLimit) < 1 ||
        !Number.isInteger(row.inputLimit) || Number(row.inputLimit) < 1 ||
        Number(row.inputLimit) > Number(row.contextLimit) || typeof row.image !== "boolean" ||
        !Array.isArray(row.efforts) || row.efforts.length < 1 || row.efforts.length > 8 ||
        row.efforts.some(e => !allowedEfforts.has(e)) || !row.efforts.includes(row.defaultEffort)) throw new Error("runtime_status_contract_invalid");
    seen.add(id);
    return { id, label: printableText(row.label, 100), provider: printableText(row.provider, 100),
      providerLabel: printableText(row.providerLabel, 120), family: printableText(row.family, 40),
      contextLimit: row.contextLimit, inputLimit: row.inputLimit, image: row.image,
      efforts: row.efforts, defaultEffort: row.defaultEffort };
  });
  const current = models.find(m => m.id === raw.currentModel);
  if (!current || !current.efforts.includes(raw.currentEffort) ||
      (raw.usedTokens !== null && (!Number.isInteger(raw.usedTokens) || Number(raw.usedTokens) < 0))) throw new Error("runtime_status_contract_invalid");
  return { status: raw.status, revision: raw.revision, currentModel: raw.currentModel,
    currentEffort: raw.currentEffort, usedTokens: raw.usedTokens, models };
}

function runtimeStatusTarget(env: Env): URL {
  const raw = env.ERRALIA_RUNTIME_STATUS_URL?.trim() || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("runtime_status_not_configured");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    target.search ||
    target.pathname !== "/api/v1/miniapp/ashuo/bootstrap"
  ) {
    throw new Error("runtime_status_not_configured");
  }
  return target;
}

export function projectAshuoRuntimePanel(raw: unknown): Record<string, unknown> {
  if (!isObject(raw) || raw.schema !== PANEL_SCHEMA || raw.residentId !== RESIDENT_ID) {
    throw new Error("runtime_status_contract_invalid");
  }
  if (
    typeof raw.available !== "boolean" ||
    typeof raw.stale !== "boolean" ||
    !Array.isArray(raw.windows) ||
    raw.windows.length > 4
  ) {
    throw new Error("runtime_status_contract_invalid");
  }

  const windows = raw.windows.map((item) => {
    if (!isObject(item) || !isObject(item.percentage)) {
      throw new Error("runtime_status_contract_invalid");
    }
    const value = item.percentage.value;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < -1_000_000 ||
      value > 1_000_000 ||
      item.percentage.meaning !== "used"
    ) {
      throw new Error("runtime_status_contract_invalid");
    }
    return {
      id: printableText(item.id, 64),
      label: printableText(item.label, 80),
      percentage: { meaning: "used", value },
      resetAt: optionalIso(item.resetAt)
    };
  });

  // Optional extension: old daemons still return only the Kimi v0 root.
  // Explicitly project each source so tokens/account fields cannot cross here.
  let quotaSources: Record<string, unknown>[] | undefined;
  if (raw.quotaSources !== undefined) {
    if (!Array.isArray(raw.quotaSources) || raw.quotaSources.length < 1 || raw.quotaSources.length > 2) {
      throw new Error("runtime_status_contract_invalid");
    }
    const seen = new Set<string>();
    quotaSources = raw.quotaSources.map((source) => {
      if (!isObject(source) || (source.id !== "kimi" && source.id !== "devin") || seen.has(source.id)) {
        throw new Error("runtime_status_contract_invalid");
      }
      seen.add(source.id);
      if (typeof source.available !== "boolean" || typeof source.stale !== "boolean" ||
          !Number.isInteger(source.freshForSeconds) || Number(source.freshForSeconds) < 1 ||
          Number(source.freshForSeconds) > 3600 || !Array.isArray(source.windows) ||
          source.windows.length > (source.id === "devin" ? 2 : 4)) {
        throw new Error("runtime_status_contract_invalid");
      }
      const expectedMeaning = source.id === "devin" ? "remaining" : "used";
      const windowIds = new Set<string>();
      const sourceWindows = source.windows.map((item) => {
        if (!isObject(item) || !isObject(item.percentage) ||
            item.percentage.meaning !== expectedMeaning || typeof item.percentage.value !== "number" ||
            !Number.isFinite(item.percentage.value) ||
            item.percentage.value < (source.id === "devin" ? 0 : -1_000_000) ||
            item.percentage.value > (source.id === "devin" ? 100 : 1_000_000)) {
          throw new Error("runtime_status_contract_invalid");
        }
        const id = printableText(item.id, 64);
        if (windowIds.has(id) || (source.id === "devin" && id !== "devin_daily" && id !== "devin_weekly")) {
          throw new Error("runtime_status_contract_invalid");
        }
        windowIds.add(id);
        return {
          id, label: printableText(item.label, 80),
          percentage: { meaning: expectedMeaning, value: item.percentage.value },
          resetAt: optionalIso(item.resetAt)
        };
      });
      if (source.available && (sourceWindows.length === 0 || (source.id === "devin" && sourceWindows.length !== 2))) {
        throw new Error("runtime_status_contract_invalid");
      }
      return {
        id: source.id, label: source.id === "devin" ? "Devin" : "Kimi",
        available: source.available, stale: source.stale,
        errorLabel: printableText(source.errorLabel, 120),
        collectedAt: optionalIso(source.collectedAt), freshForSeconds: source.freshForSeconds,
        windows: source.available ? sourceWindows : []
      };
    });
  }

  return {
    schema: PANEL_SCHEMA,
    residentId: RESIDENT_ID,
    available: raw.available,
    stale: raw.stale,
    errorLabel: printableText(raw.errorLabel, 120),
    collectedAt: optionalIso(raw.collectedAt),
    windows,
    ...(quotaSources ? { quotaSources } : {}),
    ...(raw.modelControl ? { modelControl: projectModelControl(raw.modelControl) } : {})
  };
}

export async function handleRuntimeStatus(
  request: Request,
  env: Env,
  fetchImpl: FetchLike = fetch,
  settings = false
): Promise<Response> {
  let target: URL;
  try {
    target = runtimeStatusTarget(env);
  } catch {
    return jsonResponse(503, { ok: false, error: "runtime_status_not_configured" });
  }
  if (settings) target.pathname = "/api/v1/miniapp/ashuo/settings";

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_INIT_DATA_CHARS * 2) throw new Error("too_large");
    body = JSON.parse(text);
  } catch {
    return jsonResponse(400, { ok: false, error: "runtime_status_request_invalid" });
  }
  if (
    !isObject(body) ||
    (settings ? Object.keys(body).sort().join(",") !== "effort,initData,model,revision" : Object.keys(body).length !== 1) ||
    typeof body.initData !== "string" ||
    body.initData.length < 1 ||
    body.initData.length > MAX_INIT_DATA_CHARS
  ) {
    return jsonResponse(400, { ok: false, error: "runtime_status_request_invalid" });
  }
  if (settings && (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision) ||
      typeof body.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(body.model) ||
      !["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(body.effort)))) {
    return jsonResponse(400, { ok: false, error: "runtime_status_request_invalid" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings ? 35_000 : 10_000);
  try {
    const upstream = await fetchImpl(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Aelios-Runtime-Status/1.0"
      },
      body: JSON.stringify(settings ? body : { initData: body.initData }),
      // Cloudflare Workers does not implement redirect="error". Keep the
      // boundary fail-closed by receiving redirects manually and rejecting
      // them before reading or projecting any upstream response.
      redirect: "manual",
      signal: controller.signal
    });
    if (
      upstream.redirected ||
      (upstream.status >= 300 && upstream.status < 400) ||
      upstream.headers.has("location")
    ) {
      return jsonResponse(502, { ok: false, error: "runtime_status_unavailable" });
    }
    const text = await upstream.text();
    if (text.length > MAX_UPSTREAM_BYTES) {
      return jsonResponse(502, { ok: false, error: "runtime_status_upstream_invalid" });
    }
    if (!upstream.ok) {
      if (settings && [400, 409, 503, 504].includes(upstream.status)) {
        let code: unknown;
        try { code = JSON.parse(text).error; } catch { code = null; }
        const allowed = ["miniapp_control_busy", "miniapp_control_stale", "miniapp_control_context_too_large", "miniapp_control_choice_invalid", "miniapp_control_not_confirmed", "miniapp_control_unavailable", "miniapp_control_unverified", "miniapp_control_identity_changed", "miniapp_control_label_ambiguous"];
        return jsonResponse(upstream.status, { ok: false, error: allowed.includes(String(code)) ? code : "miniapp_control_not_confirmed" });
      }
      const status = upstream.status === 401 || upstream.status === 403 ? 401 : 502;
      return jsonResponse(status, {
        ok: false,
        error: status === 401 ? "telegram_auth_failed" : "runtime_status_unavailable"
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return jsonResponse(502, { ok: false, error: "runtime_status_upstream_invalid" });
    }
    try {
      if (settings) {
        if (!isObject(raw)) throw new Error("invalid");
        return jsonResponse(200, { ok: true, data: { modelControl: projectModelControl(raw.modelControl) } });
      }
      return jsonResponse(200, { ok: true, data: projectAshuoRuntimePanel(raw) });
    } catch {
      return jsonResponse(502, { ok: false, error: "runtime_status_upstream_invalid" });
    }
  } catch {
    return jsonResponse(502, { ok: false, error: "runtime_status_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}
