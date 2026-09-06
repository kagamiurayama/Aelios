import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  isThinQuery,
  lexicalOverlapScore,
  mergeHybridRanks,
  selectRelevantPrecious,
  shapeRecallQuery,
  tokenizeQuery
} from "../src/memory/queryShape";
import { formatRecallSurface } from "../src/memory/surface";
import { searchMemoriesByText } from "../src/db/memories";
import { recentHumanTexts } from "../src/gateway/protocol";

test("thin continuations expand with recent turns; topical questions stay as-is", () => {
  assert.equal(isThinQuery("那个呢？"), true);
  assert.equal(isThinQuery("继续"), true);
  assert.equal(isThinQuery("我们喜欢什么？"), false);
  assert.ok(tokenizeQuery("我们喜欢什么？").includes("喜欢"));

  const shaped = shapeRecallQuery({
    query: "那个呢？",
    recent: ["我们在做 Cloudflare 记忆网关", "先别动 Dream"]
  });
  assert.equal(shaped.thin, true);
  assert.match(shaped.embeddingQuery, /Cloudflare/);
  assert.ok(shaped.lexicalTokens.includes("cloudflare") || shaped.lexicalTokens.includes("网关"));
});

test("precious selection keeps lexical overlap and drops stale notes", () => {
  const rows = [
    { content: "喜欢 Cloudflare" },
    { content: "昨天吃了番茄炒蛋" },
    { content: "网关只给主模型召回记忆" }
  ];
  const tokens = tokenizeQuery("我们喜欢 Cloudflare 网关什么？");
  const selected = selectRelevantPrecious(rows, tokens);
  assert.ok(selected.some((row) => row.content.includes("Cloudflare")));
  assert.ok(selected.some((row) => row.content.includes("网关")));
  assert.ok(!selected.some((row) => row.content.includes("番茄炒蛋")));
  assert.ok(lexicalOverlapScore("喜欢 Cloudflare", tokens) > lexicalOverlapScore("昨天吃了番茄炒蛋", tokens));
});

test("surface is markdown, not a JSON blob", () => {
  const text = formatRecallSurface([
    { kind: "precious", content: "喜欢 Cloudflare" },
    { kind: "project", content: "你正在做记忆网关" }
  ]);
  assert.match(text, /\[Aelios memory reference/);
  assert.match(text, /- \[precious\] 喜欢 Cloudflare/);
  assert.match(text, /- \[project\] 你正在做记忆网关/);
  assert.doesNotMatch(text, /\[\{"kind"/);
});

test("RRF keeps a lexical hit that the vector channel missed", () => {
  const vector = [
    { id: "noise", score: 0.41 },
    { id: "maybe", score: 0.22 }
  ];
  const lexical = [
    { id: "hit", score: 0.8 },
    { id: "maybe", score: 0.6 }
  ];
  const merged = mergeHybridRanks(vector, lexical, 3);
  assert.equal(merged[0].id, "maybe");
  assert.ok(merged.some((row) => row.id === "hit"));
  assert.equal(merged.find((row) => row.id === "hit")?.score, 0.8);
});

test("token lexical search matches a phrase the full query would miss", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, namespace TEXT, type TEXT, content TEXT, summary TEXT,
    importance REAL, confidence REAL, status TEXT, pinned INTEGER, tags TEXT,
    source TEXT, source_message_ids TEXT, vector_id TEXT, last_recalled_at TEXT,
    recall_count INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, expires_at TEXT,
    version_status TEXT, fact_key TEXT, superseded_by TEXT, authored_by TEXT, response_tendency TEXT
  )`);
  sqlite.prepare(`INSERT INTO memories (
    id, namespace, type, content, summary, importance, confidence, status, pinned, tags,
    source, source_message_ids, vector_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "mem_cf", "partner-a", "project", "你正在做 Cloudflare Worker 记忆网关。", null,
    0.9, 0.9, "active", 0, "[]", "extract", "[]", "mem_mem_cf", "2026-09-01", "2026-09-01"
  );
  sqlite.prepare(`INSERT INTO memories (
    id, namespace, type, content, summary, importance, confidence, status, pinned, tags,
    source, source_message_ids, vector_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "mem_food", "partner-a", "note", "昨天吃了番茄炒蛋。", null,
    0.4, 0.8, "active", 0, "[]", "extract", "[]", "mem_mem_food", "2026-09-02", "2026-09-02"
  );

  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { args = values; return api; },
        async all() { return { results: statement.all(...args) }; }
      };
      return api;
    }
  };

  const missed = await searchMemoriesByText(db as any, {
    namespace: "partner-a",
    query: "我们喜欢什么？",
    limit: 10
  });
  assert.equal(missed.length, 0);

  const hits = await searchMemoriesByText(db as any, {
    namespace: "partner-a",
    query: "我们喜欢什么？",
    tokens: tokenizeQuery("我们喜欢 Cloudflare 网关什么？"),
    limit: 10
  });
  assert.ok(hits.some((row) => row.id === "mem_cf"));
  assert.ok(!hits.some((row) => row.id === "mem_food"));
  sqlite.close();
});

test("recentHumanTexts walks user turns in chronological order", () => {
  const texts = recentHumanTexts({
    messages: [
      { role: "system", content: "ignore" },
      { role: "user", content: "先做网关" },
      { role: "assistant", content: "好" },
      { role: "user", content: "那个呢？" }
    ]
  }, "chat");
  assert.deepEqual(texts, ["先做网关", "那个呢？"]);
});
