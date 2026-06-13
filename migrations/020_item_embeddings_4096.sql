-- Resize item_embeddings.embedding from vector(1024) to vector(4096).
--
-- Migration 018 created the column for BAAI/bge-m3 at 1024 dims. The target
-- model is now Qwen3-Embedding-8B at 4096 dims. Any stored embeddings are
-- stale after a model change regardless, so we truncate before the column
-- swap. The ADD COLUMN NOT NULL is safe on an empty table.
--
-- pgvector does not support changing vector dimensions via ALTER COLUMN TYPE,
-- so the column is dropped and re-added instead.

-- Remove the HNSW index before altering the column.
DROP INDEX IF EXISTS item_embeddings_embedding_hnsw_idx;

-- Clear stale 1024-dim embeddings.
TRUNCATE item_embeddings;

-- Swap column to the new dimension.
ALTER TABLE item_embeddings DROP COLUMN embedding;
ALTER TABLE item_embeddings ADD COLUMN embedding vector(4096) NOT NULL;

-- Rebuild the HNSW index for cosine-similarity search at 4096 dims.
CREATE INDEX item_embeddings_embedding_hnsw_idx
  ON item_embeddings
  USING hnsw (embedding vector_cosine_ops);
