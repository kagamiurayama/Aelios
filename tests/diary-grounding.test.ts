import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatBootStable } from "../src/assembler/types";
import { buildDiaryWriterPrompt, normalizeDiaryWriterResult } from "../src/memory/diaryWriter";
import { groundedSourceIds, IMPRESSION_DISCLAIMER } from "../src/memory/impression";

test("diary prompt forbids invented specifics and requires source ids", () => {
  const prompt = buildDiaryWriterPrompt({
    dateLabel: "2026-08-27",
    messages: [{
      id: "msg_1",
      conversation_id: "c1",
      namespace: "partner-a",
      role: "user",
      content: "今天有点累",
      source: "chat",
      created_at: "2026-08-27T12:00:00.000Z"
    }],
    existingDraft: null
  });
  assert.match(prompt, /source_message_ids/);
  assert.match(prompt, /没有原文支撑/);
  assert.match(prompt, /傍晚下班后抱怨/);
  assert.doesNotMatch(prompt, /具体细节优先于抽象概括/);
  assert.doesNotMatch(prompt, /古法PPT/);
});

test("claimed source ids that are not in the day's transcript are dropped", () => {
  assert.deepEqual(
    groundedSourceIds(["msg_1", "msg_fake", "msg_1"], ["msg_1", "msg_2"]),
    ["msg_1"]
  );
});

test("diary JSON keeps title/summary and reads source_message_ids", () => {
  const parsed = normalizeDiaryWriterResult({
    title: "有点累",
    summary: "她今天显得累。",
    source_message_ids: ["msg_1", ""]
  });
  assert.equal(parsed?.title, "有点累");
  assert.deepEqual(parsed?.source_message_ids, ["msg_1"]);
});

test("boot impressions carry the issue #35 disclaimer", () => {
  const text = formatBootStable({
    impressions: {
      daily: { label: "2026-08-27", title: "昨日", summary: "聊了缓存" },
      weekly: null,
      monthly: null,
      max_chars: 1000
    },
    precious: [],
    glossary: [],
    schema_version: "v3-1",
    cache_prefix_end: true
  });
  assert.match(text, new RegExp(IMPRESSION_DISCLAIMER));
  assert.match(text, /聊了缓存/);
});
