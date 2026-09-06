import type { Env } from "../types";
import { PATHS, type GatewayConfig, type Identity, type Protocol } from "./config";
import { applyThinkingPolicy, type Body } from "./protocol";

const ACCOUNT_RE = /^[a-f0-9]{32}$/i;
const GATEWAY_HOST_RE =
  /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([a-f0-9]{32})\/([^/]+)(?:\/(.*))?$/i;
const REST_HOST_RE =
  /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})\/ai(?:\/v1)?$/i;

export interface ResolvedUpstream {
  accountId: string | null;
  gatewayId: string;
  /** OpenAI-compat / custom-provider / dynamic-route base (no trailing slash). */
  compatBase: string | null;
  /** CF REST AI base for Anthropic Messages and Responses. */
  restBase: string | null;
  /** Non-CF OpenAI-compatible base the user typed. */
  customBase: string | null;
}

function configuredAddress(env: Env, config: GatewayConfig): string {
  return config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
}

export function resolveGatewayId(env: Env, address = ""): string {
  const fromUrl = address.match(GATEWAY_HOST_RE);
  if (fromUrl?.[2] && fromUrl[2].toLowerCase() !== "compat") return fromUrl[2];
  return env.AI_GATEWAY_ID?.trim() || "default";
}

export function resolveUpstream(env: Env, config: GatewayConfig): ResolvedUpstream {
  const address = configuredAddress(env, config);
  if (!address) {
    throw new Error("Upstream not configured. Set the CF account in /admin/gateway.");
  }
  const trimmed = address.replace(/\/+$/, "");
  const gatewayId = resolveGatewayId(env, trimmed);

  if (ACCOUNT_RE.test(trimmed)) {
    return {
      accountId: trimmed,
      gatewayId,
      compatBase: `https://gateway.ai.cloudflare.com/v1/${trimmed}/${gatewayId}/compat`,
      restBase: `https://api.cloudflare.com/client/v4/accounts/${trimmed}/ai/v1`,
      customBase: null
    };
  }

  const rest = trimmed.match(REST_HOST_RE);
  if (rest) {
    return {
      accountId: rest[1],
      gatewayId,
      compatBase: `https://gateway.ai.cloudflare.com/v1/${rest[1]}/${gatewayId}/compat`,
      restBase: `https://api.cloudflare.com/client/v4/accounts/${rest[1]}/ai/v1`,
      customBase: null
    };
  }

  const gw = trimmed.match(GATEWAY_HOST_RE);
  if (gw) {
    const accountId = gw[1];
    const namedGateway = gw[2];
    const restPath = (gw[3] || "").replace(/\/+$/, "");
    const isBareGateway = !restPath || restPath.toLowerCase() === "compat";
    return {
      accountId,
      gatewayId: namedGateway,
      compatBase: isBareGateway
        ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${namedGateway}/compat`
        : trimmed,
      restBase: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      customBase: isBareGateway ? null : trimmed
    };
  }

  return { accountId: null, gatewayId, compatBase: null, restBase: null, customBase: trimmed };
}

/**
 * Chat (and anything OpenAI-compat) must hit the Gateway Unified URL that includes
 * `{gateway_id}/compat`. Custom providers and dynamic routes only exist on that host.
 * Messages/Responses stay on the CF REST AI base, which documents those schemas.
 */
export function upstreamBaseUrl(env: Env, config: GatewayConfig, protocol: Protocol = "chat"): string {
  const resolved = resolveUpstream(env, config);
  if (resolved.customBase && !resolved.compatBase) return resolved.customBase;
  if (protocol === "chat") return resolved.compatBase || resolved.customBase || resolved.restBase!;
  return resolved.restBase || resolved.customBase || resolved.compatBase!;
}

export function catalogUrl(env: Env, config: GatewayConfig): string {
  const resolved = resolveUpstream(env, config);
  if (resolved.compatBase) return `${resolved.compatBase}/models`;
  return `${resolved.customBase}/models`;
}

// One call, one upstream. Model names pass through as written; provider routing,
// retries and fallback are AI Gateway's job, configured in its own dashboard.
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
  if (resolved.gatewayId) headers.set("cf-aig-gateway-id", resolved.gatewayId);
  applyThinkingPolicy(body, identity, protocol, headers);
  return fetch(`${upstreamBaseUrl(env, config, protocol)}/${PATHS[protocol]}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: original.signal, redirect: "manual"
  });
}
