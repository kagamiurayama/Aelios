import { authenticate } from "../auth/apiKey";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { allowedProfiles, loadConfig } from "../gateway/config";

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  let config;
  try { config = await loadConfig(env); }
  catch { return openAiError("Gateway configuration unavailable. Apply migrations.", 503); }

  return json(
    {
      object: "list",
      data: allowedProfiles(config, auth).map(profile => (
        {
          id: profile.alias,
          object: "model",
          created: 0,
          owned_by: "aelios",
          protocols: Object.keys(profile.routes)
        }
      ))
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
