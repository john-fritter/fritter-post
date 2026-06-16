-- Add title_embedding to item_embeddings for the attach pass rework (2026-06-16).
-- The attach pass now scores candidates on title-only cosine similarity; same
-- model and dims (qwen/qwen3-embedding-8b, 4096) as the body embedding. Column
-- is nullable: existing rows have no title embedding and are populated on the
-- next grouping run via the upsert in step 1. See docs/decisions.md.

ALTER TABLE item_embeddings
  ADD COLUMN IF NOT EXISTS title_embedding vector(4096);

-- Partial HNSW index — only rows that have a title embedding (post-migration rows).
CREATE INDEX IF NOT EXISTS item_embeddings_title_embedding_hnsw_idx
  ON item_embeddings
  USING hnsw (title_embedding vector_cosine_ops)
  WHERE title_embedding IS NOT NULL;
