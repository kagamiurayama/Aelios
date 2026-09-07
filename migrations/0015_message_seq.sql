-- Turn-local sequence so same-timestamp user/assistant rows stay in ask-then-answer order.
-- Hash IDs are unique only; they must not decide chronological order.
ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

UPDATE messages
SET seq = CASE role
  WHEN 'user' THEN 0
  WHEN 'assistant' THEN 1
  ELSE 2
END
WHERE seq = 0;

CREATE INDEX IF NOT EXISTS idx_messages_namespace_created_seq
ON messages(namespace, created_at, seq);
