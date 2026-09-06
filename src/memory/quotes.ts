import { getMessagesByIds } from "../db/messages";
import type { MessageRecord } from "../types";
import { searchFtsIds } from "./fts";
import { isPreciousRelevant, lexicalOverlapScore, tokenizeForIndex } from "./queryShape";

export interface QuoteHit {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  created_at: string;
  conversation_id: string;
  score: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function searchQuotesLike(
  db: D1Database,
  input: { namespace: string; tokens: string[]; limit: number; excludeIds: Set<string> }
): Promise<QuoteHit[]> {
  const tokens = input.tokens.filter((token) => token.length >= 2).slice(0, 8);
  if (tokens.length === 0) return [];
  const clauses = tokens.map(() => "content LIKE ? ESCAPE '\\'");
  const binds: unknown[] = [input.namespace, ...tokens.map((token) => `%${escapeLike(token)}%`)];
  const result = await db
    .prepare(
      `SELECT id, conversation_id, namespace, role, content, source, created_at
       FROM messages
       WHERE namespace = ? AND role IN ('user', 'assistant') AND (${clauses.join(" OR ")})
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(...binds, Math.max(input.limit * 3, 24))
    .all<MessageRecord>();

  return (result.results ?? [])
    .filter((row) => !input.excludeIds.has(row.id))
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
      conversation_id: row.conversation_id,
      score: lexicalOverlapScore(row.content, tokens)
    }))
    .filter((row) => row.score > 0 && isPreciousRelevant(row.content, tokens))
    .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at));
}

export async function searchQuotes(
  db: D1Database,
  input: {
    namespace: string;
    query: string;
    tokens?: string[];
    limit?: number;
    excludeIds?: string[];
  }
): Promise<QuoteHit[]> {
  const tokens = input.tokens ?? tokenizeForIndex(input.query, 12);
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 12);
  const excludeIds = new Set(input.excludeIds ?? []);
  const ftsIds = await searchFtsIds(db, "message_fts", "message_id", {
    namespace: input.namespace,
    tokens,
    limit: limit * 3
  });
  const fromFts = ftsIds.length
    ? (await getMessagesByIds(db, { namespace: input.namespace, ids: ftsIds }))
      .filter((row) => !excludeIds.has(row.id) && (row.role === "user" || row.role === "assistant"))
      .map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        conversation_id: row.conversation_id,
        score: lexicalOverlapScore(row.content, tokens)
      }))
      .filter((row) => row.score > 0 && isPreciousRelevant(row.content, tokens))
    : [];

  const liked = await searchQuotesLike(db, { namespace: input.namespace, tokens, limit, excludeIds });
  const byId = new Map<string, QuoteHit>();
  for (const hit of [...fromFts, ...liked]) {
    const existing = byId.get(hit.id);
    if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
  }

  return clusterQuotes([...byId.values()], limit);
}

function clusterQuotes(hits: QuoteHit[], limit: number): QuoteHit[] {
  const kept: QuoteHit[] = [];
  for (const hit of hits.sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))) {
    const duplicate = kept.some((other) =>
      other.conversation_id === hit.conversation_id
      && (other.content.includes(hit.content) || hit.content.includes(other.content))
    );
    if (duplicate) continue;
    kept.push(hit);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function formatQuote(hit: QuoteHit): string {
  const day = hit.created_at.slice(0, 10);
  const speaker = hit.role === "assistant" ? "助手" : "用户";
  const quote = hit.content.replace(/\s+/g, " ").trim().slice(0, 280);
  return `${day} ${speaker}: 「${quote}」`;
}

export function quoteOverlaps(text: string, quote: string): boolean {
  const a = text.replace(/\s+/g, "");
  const b = quote.replace(/\s+/g, "");
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
