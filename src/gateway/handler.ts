import { authenticate } from "../auth/apiKey";
import { runRecall, buildCoreFingerprint } from "../memory/v2/recall";
import { listPrecious } from "../db/v2";
import { selectRelevantPrecious, shapeRecallQuery } from "../memory/queryShape";
import { formatRecallSurface } from "../memory/surface";
import type { Env } from "../types";
import { findIdentity, identityNamespace, isMainModel, loadConfig, type Identity, type Protocol } from "./config";
import { appendMemory, classifyTurn, hasServerState, recentHumanTexts, validateBody, type Body } from "./protocol";
import { dispatchExchange, observeResponse, prepareExchange } from "./record";
import { callGatewayUpstream } from "./upstream";

export function gatewayError(protocol: Protocol, message: string, status: number): Response {
  const type = status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return Response.json(protocol === "messages" ? { type: "error", error: { type, message } } : { error: { type, message } }, { status });
}
export async function recallPatch(
  env: Env,
  identity: Identity,
  query: string,
  ctx: ExecutionContext,
  recent: string[] = []
): Promise<string> {
  const namespace = identityNamespace(identity);
  const shaped = shapeRecallQuery({ query, recent });
  const precious = await listPrecious(env.DB, { namespace, limit: 20 });
  const relevantPrecious = selectRelevantPrecious(precious, shaped.lexicalTokens);
  const recall = await runRecall(env, {
    namespace,
    query,
    recent,
    k: 12,
    core_fingerprint: buildCoreFingerprint(precious.map(p => p.content)),
    waitUntil: promise => ctx.waitUntil(promise.catch(() => console.error("gateway recall accounting failed")))
  });
  return formatRecallSurface([
    ...relevantPrecious.map(p => ({ kind: "precious", content: p.content })),
    ...recall.glossary_hits.map(p => ({ kind: "glossary", content: `${p.term}: ${p.definition}` })),
    ...recall.hits.map(p => ({ kind: p.type, content: p.content })),
    ...recall.week_blocks.map(p => ({ kind: "week", content: `${p.week}: ${p.summary}` }))
  ], identity.maxMemoryChars || 6000);
}
export async function handleGateway(request: Request, env: Env, ctx: ExecutionContext,
  protocol: Protocol, slug: string | null = null): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return gatewayError(protocol, "Unauthorized", 401);
  let body: Body;
  try { body = await request.json(); validateBody(body, protocol); }
  catch (error) { return gatewayError(protocol, error instanceof Error ? error.message : "Invalid JSON", 400); }
  let config;
  try { config = await loadConfig(env); }
  catch { return gatewayError(protocol, "Gateway configuration unavailable. Apply migrations and check /admin/gateway.", 503); }
  const identity = findIdentity(config, auth, slug);
  if (!identity) {
    return gatewayError(protocol, slug
      ? `No identity "${slug}" available for this key. Configure /admin/gateway, then use https://<host>/<identity>/v1.`
      : "This key has no identity. Configure one at /admin/gateway.", 403);
  }
  // Only main models carry memory and feed Dream; every other model passes through quietly.
  const main = isMainModel(identity, body.model);
  if (protocol === "responses" && main && hasServerState(body, protocol)) {
    return gatewayError(protocol, "Request-only memory requires stateless Responses input: send full history without previous_response_id, conversation or item_reference; or use a model outside the main list.", 400);
  }
  const turn = classifyTurn(body, protocol, request.headers.get("x-aelios-purpose") === "auxiliary");
  let patch = "";
  let memoryStatus = !main ? "off" : turn.kind !== "human" ? "skipped" : "empty";
  const thinkingCompatible = protocol !== "messages" || identity.anthropicThinking === "drop_block" || body.thinking?.type === "disabled";
  if (main && turn.kind === "human" && turn.text && thinkingCompatible) {
    try {
      const prior = recentHumanTexts(body, protocol).slice(0, -1).slice(-3);
      patch = await recallPatch(env, identity, turn.text, ctx, prior);
      memoryStatus = patch ? "injected" : "empty";
    }
    catch (error) {
      memoryStatus = "unavailable";
      console.error("gateway recall unavailable", { identity: identity.slug, error });
    }
  } else if (!thinkingCompatible && main) memoryStatus = "thinking-passthrough";
  const payload = appendMemory(body, protocol, patch);
  if (protocol === "responses" && main) payload.store = false;
  const exchange = main ? await prepareExchange(request, body, identity, protocol, turn, auth.profile.source) : null;
  try {
    const upstream = await callGatewayUpstream(env, config, identity, protocol, request, payload);
    const headers = new Headers(upstream.headers);
    headers.set("x-aelios-identity", identity.slug);
    headers.set("x-aelios-memory", memoryStatus);
    headers.set("x-aelios-provider", upstream.headers.get("cf-aig-provider") || "");
    headers.set("x-aelios-model", upstream.headers.get("cf-aig-model") || body.model);
    headers.set("cache-control", "no-store");
    const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    if (!exchange) return response;
    exchange.httpStatus = upstream.status;
    exchange.model = headers.get("x-aelios-model")!;
    exchange.provider = headers.get("x-aelios-provider")!;
    if (!response.body) {
      exchange.completion = "failed";
      ctx.waitUntil(dispatchExchange(env, exchange).catch(() => console.error("gateway exchange recording failed")));
      return response;
    }
    return observeResponse(response, protocol, ctx, async (out, interrupted) => {
      exchange.assistantText = out.text;
      if (out.model) exchange.model = out.model;
      exchange.completion = !upstream.ok || out.failed ? "failed" :
        out.truncated || exchange.completion === "truncated" ? "truncated" :
        interrupted || !out.complete ? "incomplete" : "complete";
      await dispatchExchange(env, exchange);
    });
  } catch (error) {
    console.error("gateway upstream error", error);
    if (exchange) {
      exchange.completion = "failed";
      exchange.httpStatus = 502;
      ctx.waitUntil(dispatchExchange(env, exchange).catch(() => console.error("gateway exchange recording failed")));
    }
    return gatewayError(protocol, `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
}
