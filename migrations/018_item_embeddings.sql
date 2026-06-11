-- Item embeddings: one vector per preprocessed item, produced by the embedding
-- stage. BAAI/bge-m3 is the target model at 1024 dims; dims column is recorded
-- per-row so the table survives a future model switch without a schema change.
--
-- Requires the pgvector extension. The docker-compose postgres image must be
-- pgvector/pgvector:pg16 (or compatible) for CREATE EXTENSION to succeed.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE item_embeddings (
  id                   BIGSERIAL    PRIMARY KEY,
  preprocessed_item_id BIGINT       NOT NULL UNIQUE REFERENCES preprocessed_items(id),
  model                TEXT         NOT NULL,
  dims                 INT          NOT NULL,
  embedding            vector(1024) NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- HNSW index for cosine-similarity nearest-neighbor search.
CREATE INDEX item_embeddings_embedding_hnsw_idx
  ON item_embeddings
  USING hnsw (embedding vector_cosine_ops);
