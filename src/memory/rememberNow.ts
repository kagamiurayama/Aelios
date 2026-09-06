import { upsertMemoryByFactKey } from "../db/v2";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { upsertMemoryFts } from "./fts";

const REMEMBER_RE = /^(?:请)?(?:帮我)?(?:记住|记一下)(?:一下|了)?[：:，,\s]*(.+)$/s;
const REMEMBER_EN_RE = /^(?:please\s+)?remember(?:\s+that)?[：:\s]+(.+)$/is;

export function parseRememberNow(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pattern of [REMEMBER_RE, REMEMBER_EN_RE]) {
    const match = trimmed.match(pattern);
    const content = match?.[1]?.trim();
    if (content && content.length >= 2) return content.slice(0, 2000);
  }
  return null;
}

export async function captureRememberNow(
  env: Env,
  input: { namespace: string; userText: string; messageId?: string }
): Promise<{ wrote: boolean; indexed?: boolean; id?: string; content?: string }> {
  const content = parseRememberNow(input.userText);
  if (!content) return { wrote: false };

  const factKey = `remember:${(await sha256Hex(content.toLowerCase())).slice(0, 24)}`;
  const result = await upsertMemoryByFactKey(env, {
    namespace: input.namespace,
    factKey,
    content,
    type: "fact",
    importance: 0.92,
    confidence: 0.96,
    tags: ["remember_now"],
    source: "remember_now",
    sourceMessageIds: input.messageId ? [input.messageId] : [],
    authoredBy: "user"
  });
  const indexed = await upsertMemoryFts(env.DB, {
    namespace: input.namespace,
    memoryId: result.id,
    content
  });
  return { wrote: true, indexed, id: result.id, content };
}
