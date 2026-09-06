-- Searchable original utterances and memory text.
-- fts_body is pre-tokenized (CJK bigrams + latin words) so write and query share one tokenizer.
-- D1 ships FTS5; if a local sqlite build lacks it, quote search falls back to LIKE.

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  fts_body,
  namespace UNINDEXED,
  message_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  fts_body,
  namespace UNINDEXED,
  memory_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);
