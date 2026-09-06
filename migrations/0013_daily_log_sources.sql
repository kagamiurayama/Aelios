-- Issue #35: daily_log 挂上可核验的原文消息 id，编造的具体情节才能被自查。
ALTER TABLE daily_log ADD COLUMN source_message_ids TEXT;
