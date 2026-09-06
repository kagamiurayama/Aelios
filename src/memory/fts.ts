import { tokenizeForIndex } from "./queryShape";

export function toFtsBody(text: string): string {
  return tokenizeForIndex(text).join(" ");
}

export function toFtsMatch(tokens: string[]): string {
  const unique = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length >= 2))];
  return unique
    .map((token) => `"${token.replace(/["*]/g, "")}"`)
    .filter((token) => token.length > 2)
    .slice(0, 12)
    .join(" OR ");
}

export async function deleteFtsRow(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  id: string
): Promise<void> {
  await db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(id).run();
}

export async function upsertMessageFts(
  db: D1Database,
  input: { namespace: string; messageId: string; content: string }
): Promise<boolean> {
  const body = toFtsBody(input.content);
  if (!body) return false;
  try {
    await deleteFtsRow(db, "message_fts", "message_id", input.messageId);
    await db
      .prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES (?, ?, ?)")
      .bind(body, input.namespace, input.messageId)
      .run();
    return true;
  } catch (error) {
    console.error("message fts index failed", { id: input.messageId, error });
    return false;
  }
}

export async function upsertMemoryFts(
  db: D1Database,
  input: { namespace: string; memoryId: string; content: string }
): Promise<boolean> {
  const body = toFtsBody(input.content);
  if (!body) return false;
  try {
    await deleteFtsRow(db, "memory_fts", "memory_id", input.memoryId);
    await db
      .prepare("INSERT INTO memory_fts (fts_body, namespace, memory_id) VALUES (?, ?, ?)")
      .bind(body, input.namespace, input.memoryId)
      .run();
    return true;
  } catch (error) {
    console.error("memory fts index failed", { id: input.memoryId, error });
    return false;
  }
}

export async function searchFtsIds(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  input: { namespace: string; tokens: string[]; limit: number }
): Promise<string[]> {
  const match = toFtsMatch(input.tokens);
  if (!match) return [];
  try {
    const result = await db
      .prepare(
        `SELECT ${idColumn} AS id FROM ${table}
         WHERE ${table} MATCH ? AND namespace = ?
         LIMIT ?`
      )
      .bind(match, input.namespace, input.limit)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id).filter(Boolean);
  } catch (error) {
    console.error("fts search failed", { table, error });
    return [];
  }
}
