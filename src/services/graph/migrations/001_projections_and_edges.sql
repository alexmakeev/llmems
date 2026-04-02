-- Projection-based knowledge graph tables
-- Each mem gets up to 7 projections (one per semantic axis)
-- Edges are proposed by Gemini based on per-axis similarity

CREATE TABLE IF NOT EXISTS mem_projections (
  id SERIAL PRIMARY KEY,
  mem_id INTEGER NOT NULL REFERENCES mems(id) ON DELETE CASCADE,
  memstore_id INTEGER NOT NULL REFERENCES memstores(id),
  axis TEXT NOT NULL CHECK (axis IN ('chronos', 'topos', 'agents', 'theme', 'cause', 'emotion', 'certainty')),
  text TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (mem_id, axis)
);

CREATE INDEX IF NOT EXISTS idx_mem_projections_memstore ON mem_projections(memstore_id);
CREATE INDEX IF NOT EXISTS idx_mem_projections_axis ON mem_projections(memstore_id, axis);

-- NOTE: The ivfflat index requires at least some data to build efficiently.
-- For small datasets (< 1000 rows), a plain index or hnsw may be more appropriate.
-- Consider running this index creation separately after initial data load:
--   CREATE INDEX idx_mem_projections_embedding ON mem_projections
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_mem_projections_embedding ON mem_projections
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS mem_edges (
  id SERIAL PRIMARY KEY,
  memstore_id INTEGER NOT NULL REFERENCES memstores(id),
  source_mem_id INTEGER NOT NULL REFERENCES mems(id) ON DELETE CASCADE,
  target_mem_id INTEGER NOT NULL REFERENCES mems(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('temporal', 'spatial', 'social', 'semantic', 'causal', 'emotional', 'epistemic')),
  label TEXT NOT NULL,
  relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
  discovery_axis TEXT NOT NULL CHECK (discovery_axis IN ('chronos', 'topos', 'agents', 'theme', 'cause', 'emotion', 'certainty')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_mem_id, target_mem_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_mem_edges_source ON mem_edges(source_mem_id);
CREATE INDEX IF NOT EXISTS idx_mem_edges_target ON mem_edges(target_mem_id);
CREATE INDEX IF NOT EXISTS idx_mem_edges_memstore ON mem_edges(memstore_id);
