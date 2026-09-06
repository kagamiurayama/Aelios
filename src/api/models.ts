import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { findIdentity, loadConfig } from "../gateway/config";

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
  if (token && address) {
    const url = /^[a-f0-9]{32}$/i.test(address)
      ? `https://gateway.ai.cloudflare.com/v1/${address}/${env.AI_GATEWAY_ID || "default"}/compat/models`
      : `${address.replace(/\/+$/, "")}/models`;
    try {
      const upstream = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: request.signal });
      if (upstream.ok) return new Response(upstream.body, { status: 200, headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "private, no-store", "x-aelios-identity": identity.slug } });
    } catch { /* fall through to local hints */ }
  }
  return json(
    {
      object: "list",
      data: identity.models
        .filter(model => !model.includes("*"))
        .map(model => ({ id: model, object: "model", created: 0, owned_by: identity.slug }))
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
