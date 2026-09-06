import type { Env } from "../types";
import { PATHS, type GatewayConfig, type Identity, type Protocol } from "./config";
import { applyThinkingPolicy, type Body } from "./protocol";

/** Panel config first, then Worker vars; a bare 32-hex account ID expands to the CF REST base. */
export function upstreamBaseUrl(env: Env, config: GatewayConfig): string {
  const address = config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
  if (/^[a-f0-9]{32}$/i.test(address)) return `https://api.cloudflare.com/client/v4/accounts/${address}/ai/v1`;
  if (address) return address.replace(/\/+$/, "");
  throw new Error("Upstream not configured. Set the CF account in /admin/gateway.");
}

// One call, one upstream. Model names pass through as written; provider routing,
// retries and fallback are AI Gateway's job, configured in its own dashboard.
export async function callGatewayUpstream(env: Env, config: GatewayConfig, identity: Identity,
  protocol: Protocol, original: Request, body: Body): Promise<Response> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("Missing Worker secret CLOUDFLARE_API_TOKEN");
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
  applyThinkingPolicy(body, identity, protocol, headers);
  return fetch(`${upstreamBaseUrl(env, config)}/${PATHS[protocol]}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: original.signal, redirect: "manual"
  });
}
