import type { Env } from "../types";
import { PATHS, type GatewayConfig, type Identity, type Protocol } from "./config";
import { applyThinkingPolicy, type Body } from "./protocol";

const ACCOUNT_RE = /^[a-f0-9]{32}$/i;
/** Second path segment that is a protocol leftover, not a Gateway ID. */
const NOT_GATEWAY = /^(compat|v1|models|chat|messages|responses)$/i;
const GATEWAY_HOST_RE =
  /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([a-f0-9]{32})(?:\/([^/]+))?(?:\/(.*))?$/i;
const REST_HOST_RE =
  /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})(?:\/.*)?$/i;

export interface ResolvedUpstream {
  accountId: string | null;
  gatewayId: string;
  /** CF: the REST base (`.../ai/v1`). The compat base is derived only for the models catalog. */
  base: string;
}

function configuredAddress(env: Env, config: GatewayConfig): string {
  return config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
}

/** The only CF catalog that actually lists models. Do not change this shape. */
export function compatBase(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId.toLowerCase()}/${gatewayId}/compat`;
}

/** Chat, messages and responses live on CF REST; the compat surface only serves
 *  chat/completions plus the models catalog, so it must never carry chat traffic. */
export function restBase(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId.toLowerCase()}/ai/v1`;
}

export function resolveGatewayId(env: Env, address = ""): string {
  const fromUrl = stripAddress(address).match(GATEWAY_HOST_RE);
  if (fromUrl?.[2] && !NOT_GATEWAY.test(fromUrl[2])) return fromUrl[2];
  return env.AI_GATEWAY_ID?.trim() || "default";
}

function stripAddress(address: string): string {
  return address.trim().replace(/\/+$/, "");
}

function parseGatewayHost(address: string): { accountId: string } | null {
  const match = stripAddress(address).match(GATEWAY_HOST_RE);
  return match ? { accountId: match[1] } : null;
}

export function resolveUpstream(env: Env, config: GatewayConfig): ResolvedUpstream {
  const address = configuredAddress(env, config);
  if (!address) throw new Error("Upstream not configured. Set the CF account in /admin/gateway.");
  const trimmed = stripAddress(address);
  const gatewayId = resolveGatewayId(env, trimmed);

  if (ACCOUNT_RE.test(trimmed)) {
    return { accountId: trimmed.toLowerCase(), gatewayId, base: restBase(trimmed) };
  }

  const rest = trimmed.match(REST_HOST_RE);
  if (rest) {
    return { accountId: rest[1].toLowerCase(), gatewayId, base: restBase(rest[1]) };
  }

  const gw = parseGatewayHost(trimmed);
  if (gw) {
    return { accountId: gw.accountId.toLowerCase(), gatewayId, base: restBase(gw.accountId) };
  }

  return { accountId: null, gatewayId, base: trimmed };
}

/** Chat traffic base: CF REST for CF addresses, custom bases untouched. */
export function upstreamBaseUrl(env: Env, config: GatewayConfig, _protocol?: Protocol): string {
  return resolveUpstream(env, config).base;
}

/** Do not change this shape: GET {compat}/models is the catalog CF actually serves. */
export function catalogUrl(env: Env, config: GatewayConfig): string {
  const resolved = resolveUpstream(env, config);
  if (resolved.accountId) return `${compatBase(resolved.accountId, resolved.gatewayId)}/models`;
  return `${resolved.base}/models`;
}

export async function callGatewayUpstream(env: Env, config: GatewayConfig, identity: Identity,
  protocol: Protocol, original: Request, body: Body): Promise<Response> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("Missing Worker secret CLOUDFLARE_API_TOKEN");
  const resolved = resolveUpstream(env, config);
  const headers = new Headers({
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${token}`
  });
  for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-helper-method"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (protocol === "messages" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  if (resolved.accountId && resolved.gatewayId) headers.set("cf-aig-gateway-id", resolved.gatewayId);
  applyThinkingPolicy(body, identity, protocol, headers);
  return fetch(`${resolved.base}/${PATHS[protocol]}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: original.signal, redirect: "manual"
  });
}
