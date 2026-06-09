# @alexmakeev/llmems

Long-term memory for LLM agents. Feed it fragments (conversation turns, file contents, anything) and it remembers. Building a chat or agent on top is the consumer's job — the library handles only the memory.

## What is this

Most LLM agents either stuff the entire history into the context window (expensive, hits limits fast) or forget everything between sessions.

`llmems` takes a Zettelkasten-inspired approach:

- Every fragment is a **chunk** — a raw input fragment (a dialogue turn, a document excerpt, anything text-based)
- Background indexing groups related chunks into **mems** — atomic topic units with a 1-2 sentence summary and a vector embedding
- On each `remember()` call the session's focus vector shifts, and new relevant mems are pulled from long-term storage into the session's working cache automatically
- `getCurrentContext()` serializes the current cache (stable prefix + dynamic block + raw tail) into a single text block, ready to prepend to your LLM prompt

The result: the agent remembers everything important across arbitrarily long histories, within a bounded context window.

> **What llmems is NOT:** a chat wrapper, a prompt builder, or a response generator. Those are consumer concerns. See [Building a chat on top of llmems](docs/building-a-chat.md) for a worked example.

## How it works

```
fragment (user turn, file line, anything)
     │
     ▼
  ContextFactory.remember(sessionId, fragment, contextId)
     ├── store chunk as raw fragment (mem_chunk, active)
     ├── compute per-turn focus vector (fresh normalized embedding of this fragment)
     └── load newly-relevant mems into session cache (ANN search, dedup)
              ↕ background (count-based trigger, default 16 chunks)
         BackgroundIndexer + ILLMSummarizer
              raw chunks → closed mems (summary + embedding)
              archived chunks removed from raw tail

     ▼
  ContextFactory.getCurrentContext(sessionId)
     ├── stable prefix  (already-cached mems, prompt-cache-friendly)
     ├── "Loaded from memory:" marker
     ├── dynamic block  (newly loaded mems, timestamped XML)
     └── raw tail       (unindexed chunks, most recent last)
     → single string ready to feed to your LLM
```

### Vocabulary

As mems are created, the LLM also extracts domain-specific terms (names, jargon, abbreviations) and stores them in a `vocabulary` table. On subsequent indexing runs the known terms list is injected into the summarization prompt so that spellings and capitalizations stay consistent across all mems.

- **Extraction during indexing** — terms collected per-topic by `BackgroundIndexer`
- **Case-insensitive deduplication** — stored with a `LOWER` unique index; canonical form preserved on first occurrence
- **`getEstablishedVocabulary(contextId, minCount?)`** — returns terms appearing in at least `minCount` mems (default `3`)
- **`getVocabulary(contextId)`** — all terms regardless of frequency
- **`VocabularyTerm`** — exported from the library for use in consuming code

## Quick Start

### Installation

```bash
echo "@alexmakeev:registry=https://npm.pkg.github.com" >> .npmrc
npm install @alexmakeev/llmems
```

### Minimal example

`ContextFactory` requires a vector-capable store (`IVectorMemStore`) — PostgreSQL + pgvector.
(`InMemoryMemStore` backs only the lower-level `MemManager`/`BackgroundIndexer` layer and is rejected
by `ContextFactory` at compile time by design.)

```typescript
import {
  ContextFactory,
  BackgroundIndexer,
  LLMSummarizer,
  MemManager,
  PostgresMemStore,
} from '@alexmakeev/llmems';

// IEmbeddingService — implement with your preferred embedding API.
// embed() returns Result<EmbeddingValue, …>, where EmbeddingValue = { compact: number[] }.
const embeddingService = {
  async embed(text: string) {
    // call your embedding API and return ok({ compact: vector })
    throw new Error('implement me');
  },
};

// Summarizer — any OpenAI-compatible endpoint
const summarizer = new LLMSummarizer({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'google/gemini-2.5-flash',
});

// Vector store (PostgreSQL + pgvector) → MemManager → BackgroundIndexer
const memStore = new PostgresMemStore(process.env.POSTGRES_URL!);
const memManager = new MemManager(memStore);
const indexer = new BackgroundIndexer(memManager, embeddingService, summarizer);

// ContextFactory(store, embeddingService, indexer, config?)
const factory = new ContextFactory(memStore, embeddingService, indexer);

// Feed a fragment — remember(sessionId, fragment, contextId).
// Persists across restarts: the same sessionId picks up where it left off.
await factory.remember('session-1', 'User: Tell me about Paris.', 'context-1');

// Get context to prepend to your LLM prompt (pure projection, no DB calls)
const context = await factory.getCurrentContext('session-1');
// → stable backbone block + "Loaded from memory:" marker + dynamic mems + raw tail

// Call your own LLM here with `context` prepended to your messages

await memStore.close(); // drain connection pool on shutdown
```

See [docs/building-a-chat.md](docs/building-a-chat.md) for the full consumer pattern that builds a chat on top of this.

## API Reference

### `ContextFactory`

Main entry point. Manages per-session focus vectors, mem caches, and context assembly.

**Constructor:** `new ContextFactory(store, embeddingService, indexer, config?)`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `store` | `IVectorMemStore` | yes | Vector-capable backend, e.g. `PostgresMemStore` (`InMemoryMemStore` is rejected at compile time by design) |
| `embeddingService` | `IEmbeddingService` | yes | Generates embeddings for focus shifts and mem loading |
| `indexer` | `BackgroundIndexer` | yes | Converts raw chunks into closed mems in the background |
| `config` | `Partial<ContextFactoryConfig>` | no | Tuning options (see below) |

**`ContextFactoryConfig` options** (all optional; defaults shown):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rebuildThreshold` | `number` | `30` | Out-of-order mem appends before a soft cache rebuild |
| `searchK` | `number` | `10` | Nearest mems retrieved via ANN search per `remember()` |
| `markerText` | `string` | `"Loaded from memory:"` | Label injected before the dynamic mem block |
| `keepRatio` | `number` | `0.7` | Fraction of mems kept on soft rebuild |
| `indexThreshold` | `number` | `16` | Active-chunk count that triggers background indexing |
| `sessionVecN` | `number` | `100` | Recent closed mems averaged into the session/theme vector |

**Methods:**

- `remember(sessionId, fragment, contextId)` — store a fragment, shift session focus, load newly-relevant mems into cache. Returns `Promise<void>`.
- `getCurrentContext(sessionId)` — serialize the current session cache into a single string ready for prepending to your LLM prompt. Returns `Promise<string>`.
- `getOrCreateSession(sessionId)` — return (or create) the in-memory per-session state (`SessionWorkingState`). Useful for inspection.

### `BackgroundIndexer`

Converts accumulated raw chunks into closed mems (summaries + embeddings). Triggered count-based (default: every 16 active chunks). Used internally by `ContextFactory`.

**Constructor:** `new BackgroundIndexer(memManager, embeddingService, llmSummarizer)`

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `memManager` | `MemManager` | yes | Mem-store orchestrator (wraps the `IMemStore`) |
| `embeddingService` | `IEmbeddingService \| undefined` | yes | Generates topic embeddings (may be `undefined`) |
| `llmSummarizer` | `ILLMSummarizer` | yes | LLM that segments chunks into topic mems |

The indexing trigger threshold lives in `ContextFactoryConfig.indexThreshold` (default `16`), not here.

### `LLMSummarizer`

Concrete `ILLMSummarizer` implementation using any OpenAI-compatible chat completions endpoint.

**Constructor** (`LLMSummarizerConfig`):

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `baseURL` | `string` | yes | OpenAI-compatible endpoint base URL, e.g. `https://openrouter.ai/api/v1` |
| `model` | `string` | yes | Model identifier, e.g. `google/gemini-2.5-flash` |
| `apiKey` | `string` | yes | API key for the `Authorization: Bearer` header |
| `logger` | `MemoryLogger` | no | Optional pino-compatible logger |

### `MemManager`

Orchestrates the chunk/mem lifecycle inside a mem store. Used internally; rarely needed directly.

- `addChunk(content, timestamp, contextId)` — add a raw conversation chunk
- `getContextData(contextId)` — returns `MemContextData` for building LLM context
- `applyBackgroundResult(mems, tailChunkIds, newGeneralSummary, contextId)` — commit a background indexing result
- `getClosedMemCount(contextId)`, `getAllClosedMems(contextId)`, `getLastClosedMem(contextId)` — introspection

### `PostgresMemStore`

PostgreSQL + pgvector storage for chunks and mems. Persists state across process restarts.

```typescript
const store = new PostgresMemStore('postgresql://user:pass@localhost:5432/mydb');
await store.close(); // drain connection pool on shutdown
```

**Vocabulary methods:**

- `getEstablishedVocabulary(contextId, minCount?)` — returns `VocabularyTerm[]` for terms that appear in at least `minCount` mems (default `3`)
- `getVocabulary(contextId)` — returns all `VocabularyTerm[]` regardless of frequency

```typescript
import { PostgresMemStore, VocabularyTerm } from '@alexmakeev/llmems';

const store = new PostgresMemStore(process.env.POSTGRES_URL!);
const terms: VocabularyTerm[] = await store.getEstablishedVocabulary('context-1', 5);
// [{ term: 'pgvector', count: 12 }, ...]
```

### `InMemoryMemStore`

In-process storage — no dependencies, no persistence. Suitable for testing and short-lived sessions.

### Key interfaces

```typescript
// Storage backend — implement for a custom store
interface IMemStore {
  addChunk(content: string, timestamp: Date, contextId: string): Promise<MemChunk>;
  getActiveChunks(contextId: string): Promise<MemChunk[]>;
  getClosedMems(contextId: string, limit?: number): Promise<Mem[]>;
  getGeneralSummary(contextId: string): Promise<string>;
  updateGeneralSummary(summary: string, contextId: string): Promise<void>;
  removeOldestClosedMem(contextId: string): Promise<void>;
  getLastClosedMem(contextId: string): Promise<Mem | null>;
  buildMemContext(contextId: string): Promise<MemContextData>;
  applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[] }; vocabulary?: { term: string; count: number }[] }[],
    tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void>;
  // Optional — required only on IVectorMemStore (see below)
  getEstablishedVocabulary?(contextId: string, minCount?: number): Promise<VocabularyTerm[]>;
  getVocabulary?(contextId: string): Promise<VocabularyTerm[]>;
  searchMemsByVector?(vector: number[], k: number, contextId: string): Promise<Mem[]>;
  getActiveChunkIds?(contextId: string): Promise<Set<string>>;
}

// ContextFactory requires the narrower vector store — these two become mandatory.
// PostgresMemStore satisfies it; InMemoryMemStore (base IMemStore only) does NOT, by design.
interface IVectorMemStore extends IMemStore {
  searchMemsByVector(vector: number[], k: number, contextId: string): Promise<Mem[]>;
  getActiveChunkIds(contextId: string): Promise<Set<string>>;
}

// Embedding service — implement with your preferred embedding API
interface IEmbeddingService {
  embed(text: string): Promise<Result<EmbeddingValue, { message: string }>>;
}

// A raw conversation fragment (unindexed)
interface MemChunk { id: string; content: string; timestamp: Date; }

// A closed (summarized + embedded) topic unit
interface Mem {
  id: string;
  summary: string;
  chunkIds: string[];
  embeddings: { full: number[] };
  closedAt: Date;
}

// Context assembled from the mem store for building LLM context
interface MemContextData {
  generalSummary: string;
  recentClosedMems: Mem[];
  lastClosedMem: Mem | null;
  activeChunks: MemChunk[];
}
```

### `ILLMSummarizer` port

Implement this to plug in a custom LLM backend for background indexing:

```typescript
interface ILLMSummarizer {
  summarize(
    systemPrompt: string,
    detectionPrompt: string,
  ): Promise<{
    topics: Array<{ summary: string; chunkIds: string[]; vocabulary: Array<{ term: string; count: number }> }>;
    tailChunkIds: string[];
  } | null>;
}
```

`LLMSummarizer` is the built-in implementation for OpenAI-compatible APIs.

### Context quality metric

Pure, deterministic scoring — no IO. Useful for evaluating how well the assembled context matches the current session focus.

```typescript
import { computeContextQualityScore } from '@alexmakeev/llmems';

const score = computeContextQualityScore({
  currentVec,        // per-turn embedding (unit-normalized)
  sessionVec,        // session/theme vector (mean of recent closed mem embeddings)
  loadedMems,        // ProvenanceMem[] assembled into the context
  activeChunkIds,    // Set<string> of chunks still active (dedup/contamination signal)
  threshold: 0.5,    // similarity floor for the focusRelevance sub-metric
  rebuildOccurred: false,
});
// score.composite — 0.0 to 1.0 composite quality
// score.focusRelevance, score.dedupCorrectness, score.chronologyIntegrity
```

### `memoryModuleConfigSchema`

Zod schema for the full memory module config (embedding + LLM + mem store backend). Use when wiring up the full pipeline with vector search.

```typescript
import { memoryModuleConfigSchema } from '@alexmakeev/llmems';

const config = memoryModuleConfigSchema.parse({
  embedding: { apiKey: '...', model: 'openai/text-embedding-3-small' },
  llmExtractor: { apiKey: '...' },
  graphExtractor: { apiKey: '...' },
  memStore: { type: 'postgres', postgres: { connectionString: '...' } },
});
```

Key fields: `embedding.model` (default `openai/text-embedding-3-small`), `memStore.type` (`'memory'` | `'postgres'`).

Environment variable shortcuts: `MEM_STORE_TYPE` and `POSTGRES_URL` are read automatically by the schema defaults.

## Token economics

`ContextFactory` bounds its working set **structurally**, not by a fixed mem cap: `getCurrentContext()`
emits the live session cache (backbone + dynamic mems + raw tail), and `softRebuild` prunes that cache to
`keepRatio` (default 70%) once `rebuildThreshold` (default 30) out-of-order appends accumulate. Size is
governed by ANN recall + pruning.

- Each mem ≈ 15–26 tokens (language-dependent)
- 500 mems ≈ 8–13k tokens — fits comfortably in modern context windows; ≈ a week of intensive daily conversations

The legacy `buildMemContext()` / `MemContextData` path (used by `MemManager` directly, **not** by
`ContextFactory`) instead caps how many closed mems it pulls — default 500 per context, overridable via
`LLMEMS_MAX_MEMS`:

```bash
export LLMEMS_MAX_MEMS=500  # default for PostgresMemStore.buildMemContext()
```

## Storage

### PostgreSQL schema

`PostgresMemStore` requires the `pgvector` extension and these tables:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memstores (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  general_summary       TEXT NOT NULL DEFAULT '',
  behavior_instructions TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mems (
  id          SERIAL PRIMARY KEY,
  memstore_id INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  chunk_ids   INTEGER[] NOT NULL DEFAULT '{}',
  embedding   vector(1536),
  closed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ANN recall uses cosine distance (embedding <=> query); HNSW index recommended
CREATE INDEX IF NOT EXISTS mems_embedding_hnsw
  ON mems USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS mem_chunks (
  id           SERIAL PRIMARY KEY,
  memstore_id  INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
);

-- Vocabulary support
CREATE TABLE IF NOT EXISTS vocabulary (
  id          SERIAL PRIMARY KEY,
  memstore_id INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upsert key used by applyBackgroundResult: ON CONFLICT (memstore_id, LOWER(term))
CREATE UNIQUE INDEX IF NOT EXISTS vocabulary_memstore_term_lower
  ON vocabulary (memstore_id, LOWER(term));

CREATE TABLE IF NOT EXISTS mem_vocabulary (
  mem_id        INTEGER NOT NULL REFERENCES mems(id) ON DELETE CASCADE,
  vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
  count_in_mem  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mem_id, vocabulary_id)
);
```

Connection string format: `postgresql://user:password@host:5432/database`

`PostgresMemStore` creates `memstores` rows on demand (one per `contextId`). Table creation is your responsibility.

## Result type

The library exports a `Result<T, E>` discriminated union (`{ ok: true; value: T } | { ok: false; error: E }`) with `ok()` / `err()` constructors. It is the return contract for the `IEmbeddingService.embed()` port **you** implement — return `ok(value)` on success, `err({ message })` on failure:

```typescript
const result = await embeddingService.embed('hello');
if (result.ok) {
  console.log(result.value); // EmbeddingValue
} else {
  console.error(result.error.message);
}
```

`ContextFactory.remember()` / `getCurrentContext()` do **not** use `Result` — they return `Promise<void>` / `Promise<string>` and throw on error (e.g. embedding failure or a vector-dimension mismatch).

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm test           # run all tests with vitest (no external services required)
npm run test:watch
```

## Build & Release

### Build

```bash
npm run build      # runs `tsc`, emits compiled output to dist/
```

### Test

```bash
npm test           # runs the test suite with vitest (no external services required)
```

### Continuous integration

`/.github/workflows/ci.yml` runs on every push to `main` and on every pull request targeting `main`. It checks out the code on Node.js 22 and runs `npm ci` → `npm run build` → `npm test`. A red CI run blocks the change.

### Publishing (automated CD)

Publishing is fully automated and **tag-driven** — there is no manual `npm publish` step. `/.github/workflows/publish.yml` fires whenever a tag matching `v*` is pushed to the repository. The workflow runs on Node.js 22 with the registry set to GitHub Packages (`https://npm.pkg.github.com`) and executes:

1. `npm ci` — install dependencies
2. `npm run build` — compile to `dist/`
3. `npm test` — run the full test suite
4. `npm publish` — publish `@alexmakeev/llmems` to GitHub Packages (auth via the workflow's `GITHUB_TOKEN`, with `packages: write` permission)

If any of build/test fails, nothing is published.

### Maintainer release steps

To cut a new release `X.Y.Z`:

1. Bump `version` in `package.json` to `X.Y.Z`.
2. Add a new top section to `CHANGELOG.md` describing the changes.
3. Commit the changes to `main`.
4. Push `main`: `git push origin main`.
5. Create an annotated tag: `git tag -a vX.Y.Z -m "release vX.Y.Z"`.
6. Push the tag: `git push origin vX.Y.Z`.
7. The `publish.yml` workflow runs automatically and publishes the package.

> **Do not run `npm publish` manually.** Publishing is handled exclusively by the tag-driven CD pipeline. The package version on GitHub Packages cannot be overwritten, so a manual publish would conflict with — or pre-empt — the automated release.

## License

MIT
