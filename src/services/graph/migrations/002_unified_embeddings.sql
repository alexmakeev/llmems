-- Migration: unified 1536d embeddings (text-embedding-3-small)
-- Removes compact/micro columns, expands embedding to 1536d

-- Drop old indexes
DROP INDEX IF EXISTS idx_mems_embedding;
DROP INDEX IF EXISTS idx_mems_embedding_compact;

-- Drop compact/micro columns
ALTER TABLE mems DROP COLUMN IF EXISTS embedding_compact;
ALTER TABLE mems DROP COLUMN IF EXISTS embedding_micro;

-- Change embedding dimension
ALTER TABLE mems ALTER COLUMN embedding TYPE vector(1536);

-- Rebuild HNSW index
CREATE INDEX idx_mems_embedding ON mems USING hnsw (embedding vector_cosine_ops);
