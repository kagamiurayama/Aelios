import type { Env } from "../types";
import { PATHS, resolveSecret, type GatewayConfig, type GatewayProfile, type Protocol, type Target } from "./config";
import { applyThinkingPolicy, isStateful, type Body } from "./protocol";

export async function callGatewayUpstream(env: Env, config: GatewayConfig, profile: GatewayProfile,
  protocol: Protocol, original: Request, body: Body): Promise<{ response: Response; target: Target }> {
  const targets = profile.routes[protocol]!;
  // Fix routes from the first call when later responses carry upstream-owned state.
  const fixedRoute = protocol === "responses" || protocol === "messages" && body.thinking?.type !== "disabled" || isStateful(body, protocol);
  const candidates = fixedRoute ? targets.slice(0, 1) : targets;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i];
    const provider = config.providers[target.provider];
    const payload = { ...body, model: target.model };
    const headers = new Headers({ "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" });
    for (const name of ["anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-helper-method"]) {
      const value = original.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (protocol === "messages" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    for (const [name, value] of Object.entries(provider.headers || {})) headers.set(name, value);
    for (const [name, ref] of Object.entries(provider.secretHeaders || {})) headers.set(name, (ref.prefix || "") + resolveSecret(env, ref.secret));
    applyThinkingPolicy(payload, profile, protocol, headers);
    let response: Response;
    try {
      if (provider.gateway) {
        if (!env.AI) throw new Error("Missing AI binding");
        response = await env.AI.gateway(provider.gateway).run({
          provider: provider.provider!, endpoint: provider.paths?.[protocol] || PATHS[protocol],
          headers: Object.fromEntries(headers), query: payload
        }, { signal: original.signal });
      } else {
        const url = provider.baseUrl!.replace(/\/$/, "") + "/" + (provider.paths?.[protocol] || PATHS[protocol]);
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: original.signal, redirect: "error" });
      }
    } catch (error) {
      if (original.signal.aborted || i === candidates.length - 1) throw error;
      continue;
    }
    if (i < candidates.length - 1 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      continue;
    }
    return { response, target };
  }
  throw new Error("No gateway route available");
}
