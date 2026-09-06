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
import { assembleRecallSurface, formatRecallSurface } from "../src/memory/surface";
import { filterAndCompressMemoriesWithMeta } from "../src/memory/filter";
import { formatDreamCursor, readDailyCursor } from "../src/memory/dreamDates";
import { listMessagesByNamespaceInRange } from "../src/db/messages";
import { parseRememberNow } from "../src/memory/rememberNow";
import { formatQuote, searchQuotes } from "../src/memory/quotes";
import { isEvidenceQuery, isTemporalQuery, tokenizeForIndex } from "../src/memory/queryShape";
import { searchMemoriesByText } from "../src/db/memories";
import { recentHumanTexts } from "../src/gateway/protocol";

test("topical questions do not mix the previous turn into lexical tokens", () => {
  const shaped = shapeRecallQuery({
    query: "调试暗号是什么？",
    recent: ["Claude 的陪伴让我觉得被接住"]
  });
  assert.equal(shaped.thin, false);
  assert.equal(shaped.embeddingQuery, "调试暗号是什么？");
  assert.ok(!shaped.lexicalTokens.some((token) => /claude|陪伴/.test(token)));
  assert.ok(shaped.lexicalTokens.some((token) => token.includes("暗号") || token.includes("调试")));
});

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

test("precious selection allows zero hits and ignores a leftover previous-topic note", () => {
  const rows = [
    { content: "Claude 的陪伴让我觉得被接住，这是一段很长的关系记忆。" },
    { content: "调试暗号是芝麻开门" }
  ];
  const tokens = shapeRecallQuery({
    query: "调试暗号是什么？",
    recent: ["Claude 的陪伴让我觉得被接住"]
  }).lexicalTokens;
  const selected = selectRelevantPrecious(rows, tokens);
  assert.ok(selected.some((row) => row.content.includes("芝麻开门")));
  assert.ok(!selected.some((row) => row.content.includes("陪伴")));
  assert.deepEqual(selectRelevantPrecious(rows, []), []);
});

test("surface applies a shared item and char budget", () => {
  const assembled = assembleRecallSurface([
    { kind: "precious", content: "很长的关系记忆".repeat(20) },
    { kind: "note", content: "普通记忆一" },
    { kind: "week", content: "不该超过条数的周记" }
  ], { budget: 6000, maxItems: 2, maxChars: 20 });
  assert.equal(assembled.entries.length, 2);
  assert.ok(assembled.entries[0].content.length <= 20);
  assert.ok(!assembled.text.includes("不该超过条数的周记"));
  assert.equal(formatRecallSurface([], { maxItems: 0 }), "");
});

test("reranker errors fail closed unless MEMORY_FILTER_FAIL_OPEN is true", async () => {
  const memories = [
    { id: "noise", namespace: "n", type: "note", content: "完全无关的旧话题", summary: null, importance: 0.2, confidence: 0.2, status: "active", pinned: false, tags: [], source: null, source_message_ids: [], vector_id: null, last_recalled_at: null, recall_count: 0, created_at: "2026-09-01", updated_at: "2026-09-01", expires_at: null, score: 0.9 }
  ];
  const env = {
    ENABLE_MEMORY_FILTER: "true",
    ENABLE_MEMORY_RERANKER: "true",
    MEMORY_FILTER_FAIL_OPEN: "false",
    MEMORY_RERANKER_MODEL: "workers-ai/@cf/baai/bge-reranker-base",
    AI: { run: async () => { throw new Error("reranker down"); } }
  } as any;
  const closed = await filterAndCompressMemoriesWithMeta(env, { query: "调试暗号", memories: memories as any });
  assert.equal(closed.data.length, 0);
  assert.equal(closed.meta.status, "error");
  assert.equal(closed.meta.fallback_used, undefined);

  const opened = await filterAndCompressMemoriesWithMeta({
    ...env,
    MEMORY_FILTER_FAIL_OPEN: "true"
  }, { query: "调试暗号", memories: memories as any });
  assert.equal(opened.data.length, 1);
  assert.equal(opened.meta.fallback_used, true);
});

test("same-timestamp messages are not skipped after a mid-batch cut", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT, namespace TEXT, role TEXT, content TEXT,
    source TEXT, created_at TEXT
  )`);
  const ts = "2026-09-06T12:00:00.000Z";
  sqlite.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("msg_a", "c", "ns", "user", "先说", "gw", ts);
  sqlite.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("msg_b", "c", "ns", "assistant", "后说", "gw", ts);
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
  const first = await listMessagesByNamespaceInRange(db as any, {
    namespace: "ns",
    startCreatedAt: "2026-09-06T00:00:00.000Z",
    endCreatedAt: "2026-09-07T00:00:00.000Z",
    limit: 1
  });
  assert.equal(first[0].id, "msg_a");
  const skipped = await listMessagesByNamespaceInRange(db as any, {
    namespace: "ns",
    startCreatedAt: "2026-09-06T00:00:00.000Z",
    endCreatedAt: "2026-09-07T00:00:00.000Z",
    afterCreatedAt: first[0].created_at,
    limit: 10
  });
  assert.equal(skipped.length, 0);
  const next = await listMessagesByNamespaceInRange(db as any, {
    namespace: "ns",
    startCreatedAt: "2026-09-06T00:00:00.000Z",
    endCreatedAt: "2026-09-07T00:00:00.000Z",
    afterCreatedAt: first[0].created_at,
    afterId: first[0].id,
    limit: 10
  });
  assert.equal(next[0].id, "msg_b");
  const cursor = formatDreamCursor({ done: false, createdAt: first[0].created_at, id: first[0].id });
  assert.deepEqual(
    readDailyCursor(cursor, "2026-09-06T00:00:00.000Z", "2026-09-07T00:00:00.000Z"),
    { done: false, after: ts, afterId: "msg_a" }
  );
  sqlite.close();
});

test("project names and codes stay in the index tokenizer", () => {
  const tokens = tokenizeForIndex("月亮邮局-0906 的暗号");
  assert.ok(tokens.some((token) => token.includes("月亮") || token.includes("邮局")));
  assert.ok(tokens.includes("0906"));
  assert.equal(isEvidenceQuery("调试暗号是什么？"), true);
  assert.equal(isEvidenceQuery("帮我写一段配置"), false);
  assert.equal(isTemporalQuery("上周日记写了什么"), true);
});

test("raw utterances are searchable before they become facts", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT, namespace TEXT, role TEXT, content TEXT,
    source TEXT, created_at TEXT
  )`);
  sqlite.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "msg_1", "c", "ns", "user", "请记住调试暗号是芝麻开门", "gw", "2026-09-06T12:00:00.000Z"
  );
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { args = values; return api; },
        async all() { return { results: statement.all(...args) }; },
        async first() { return statement.get(...args) || null; },
        async run() { return { meta: { changes: statement.run(...args).changes } }; }
      };
      return api;
    }
  };
  const hits = await searchQuotes(db as any, { namespace: "ns", query: "调试暗号是什么？" });
  assert.ok(hits.some((hit) => hit.content.includes("芝麻开门")));
  assert.match(formatQuote(hits[0]), /2026-09-06 用户: 「请记住调试暗号是芝麻开门」/);
  sqlite.close();
});

test("remember-now extracts the original words after the trigger", () => {
  assert.equal(parseRememberNow("请记住调试暗号是芝麻开门"), "调试暗号是芝麻开门");
  assert.equal(parseRememberNow("帮我记一下：喜欢 Cloudflare"), "喜欢 Cloudflare");
  assert.equal(parseRememberNow("remember that the passphrase is sesame"), "the passphrase is sesame");
  assert.equal(parseRememberNow("我们喜欢什么？"), null);
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
