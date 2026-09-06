import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, loadConfig } from "../gateway/config";


/** Models catalog URL for any accepted address form: account ID, legacy gateway URL
 *  (with or without /compat), legacy REST base, or a custom OpenAI-compatible base. */
function catalogUrl(address: string, gatewayId: string): string {
  if (/^[a-f0-9]{32}$/i.test(address))
    return `https://gateway.ai.cloudflare.com/v1/${address}/${gatewayId}/compat/models`;
  const base = address.replace(/\/+$/, "");
  const gw = base.match(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([a-f0-9]{32})\/([^/]+?)(?:\/compat)?$/i);
  if (gw) return `https://gateway.ai.cloudflare.com/v1/${gw[1]}/${gw[2]}/compat/models`;
  const rest = base.match(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([a-f0-9]{32})\/ai\/v1$/i);
  if (rest) return `https://gateway.ai.cloudflare.com/v1/${rest[1]}/${gatewayId}/compat/models`;
  return `${base}/models`;
}
/** The upstream owns the real catalog; local main models are only hints when it cannot answer. */
export async function handleModels(request: Request, env: Env, slug: string | null = null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  let config;
  try { config = await loadConfig(env); }
  catch { return openAiError("Gateway configuration unavailable. Apply migrations.", 503); }

  const identity = findIdentity(config, auth, slug);
  if (!identity) return openAiError("No identity available for this key. Configure /admin/gateway.", 403);

  // The catalog lives on the AI Gateway compat surface; CF REST has no GET /models (405).
  const token = env.CLOUDFLARE_API_TOKEN;
  const address = config.upstream?.address?.trim() || env.AI_GATEWAY_BASE_URL || env.CLOUDFLARE_ACCOUNT_ID || "";
  let reason = !token ? "no-token" : !address ? "no-address" : "";
  if (!reason) {
    const url = catalogUrl(address, env.AI_GATEWAY_ID || "default");
    try {
      const upstream = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: request.signal });
      if (upstream.ok) return new Response(upstream.body, { status: 200, headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "private, no-store", "x-aelios-identity": identity.slug,
        "x-aelios-models": "upstream" } });
      reason = `upstream-${upstream.status}`;
    } catch { reason = "upstream-error"; }
  }
  return json(
    {
      object: "list",
      data: identity.models
        .filter(model => !model.includes("*"))
        .map(model => ({ id: model, object: "model", created: 0, owned_by: identity.slug }))
    },
    { headers: { "Cache-Control": "private, no-store", "x-aelios-models": `fallback:${reason}` } }
  );
}
