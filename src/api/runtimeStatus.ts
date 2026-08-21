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
  if (typeof value !== "string" || value.length > maxChars || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("runtime_status_contract_invalid");
  }
  return value;
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

  return {
    schema: PANEL_SCHEMA,
    residentId: RESIDENT_ID,
    available: raw.available,
    stale: raw.stale,
    errorLabel: printableText(raw.errorLabel, 120),
    collectedAt: optionalIso(raw.collectedAt),
    windows
  };
}

export async function handleRuntimeStatus(
  request: Request,
  env: Env,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  let target: URL;
  try {
    target = runtimeStatusTarget(env);
  } catch {
    return jsonResponse(503, { ok: false, error: "runtime_status_not_configured" });
  }

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
    Object.keys(body).length !== 1 ||
    typeof body.initData !== "string" ||
    body.initData.length < 1 ||
    body.initData.length > MAX_INIT_DATA_CHARS
  ) {
    return jsonResponse(400, { ok: false, error: "runtime_status_request_invalid" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetchImpl(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Aelios-Runtime-Status/1.0"
      },
      body: JSON.stringify({ initData: body.initData }),
      redirect: "error",
      signal: controller.signal
    });
    const text = await upstream.text();
    if (text.length > MAX_UPSTREAM_BYTES) {
      return jsonResponse(502, { ok: false, error: "runtime_status_upstream_invalid" });
    }
    if (!upstream.ok) {
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
