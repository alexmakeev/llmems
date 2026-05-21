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
  ContextFactory.remember(sessionId, fragment)
     ├── store chunk as raw fragment (mem_chunk, active)
     ├── shift session focus vector (EMA over recent embeddings)
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
- **`getEstablishedVocabulary(minCount?)`** — returns terms appearing in at least `minCount` mems (default 3)
- **`getVocabulary()`** — all terms regardless of frequency
- **`VocabularyTerm`** — exported from the library for use in consuming code

## Quick Start

### Installation

```bash
echo "@alexmakeev:registry=https://npm.pkg.github.com" >> .npmrc
npm install @alexmakeev/llmems
```

### Minimal example (in-memory, no persistence)

```typescript
import {
  ContextFactory,
  BackgroundIndexer,
  LLMSummarizer,
  InMemoryMemStore,
} from '@alexmakeev/llmems';

// Wire up the summarizer (any OpenAI-compatible endpoint)
const summarizer = new LLMSummarizer({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'google/gemini-2.5-flash',
});

const memStore = new InMemoryMemStore();
const indexer = new BackgroundIndexer(summarizer, memStore);

// IEmbeddingService — implement with your preferred embedding API
const embeddingService = {
  async embed(text: string) {
    // call your embedding API and return Result<EmbeddingValue, ...>
    throw new Error('implement me');
  },
};

const factory = new ContextFactory({
  embeddingService,
  indexer,
  memStore,
});

// Feed a fragment (conversation turn, document excerpt, etc.)
await factory.remember('session-1', 'User: Tell me about Paris.');

// Get context to prepend to your LLM prompt
const context = await factory.getCurrentContext('session-1');
// → "Loaded from memory:\n...\n\nUser: Tell me about Paris."

// Call your own LLM here with `context` prepended to your messages
```

### With PostgreSQL persistence

```typescript
import {
  ContextFactory,
  BackgroundIndexer,
  LLMSummarizer,
  PostgresMemStore,
} from '@alexmakeev/llmems';

const memStore = new PostgresMemStore(process.env.POSTGRES_URL!);
const summarizer = new LLMSummarizer({ apiKey: process.env.OPENROUTER_API_KEY! });
const indexer = new BackgroundIndexer(summarizer, memStore);

const factory = new ContextFactory({ embeddingService, indexer, memStore });

// Persist across restarts — same sessionId picks up where it left off
await factory.remember('user-123', 'My name is Alice.');
const context = await factory.getCurrentContext('user-123');
// context includes all mems accumulated across previous process runs

await memStore.close(); // drain connection pool on shutdown
```

See [docs/building-a-chat.md](docs/building-a-chat.md) for the full consumer pattern that builds a chat on top of this.

## API Reference

### `ContextFactory`

Main entry point. Manages per-session focus vectors, mem caches, and context assembly.

**Constructor** (`ContextFactoryConfig`):

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `embeddingService` | `IEmbeddingService` | yes | Generates embeddings for focus shifts and mem loading |
| `indexer` | `BackgroundIndexer` | yes | Converts raw chunks into closed mems in the background |
| `memStore` | `IMemStore` | yes | Storage backend for chunks and mems |
| `recalledMemoryMarker` | `string` | no | Label injected before the dynamic mem block (default: `"Loaded from memory:"`) |
| `rebuildThreshold` | `number` | no | How many out-of-order mems trigger a soft cache rebuild (default: `30`) |

**Methods:**

- `remember(sessionId, fragment)` — store a fragment, shift session focus, load newly-relevant mems into cache. Returns `Promise<void>`.
- `getCurrentContext(sessionId)` — serialize the current session cache into a single string ready for prepending to your LLM prompt. Returns `Promise<string>`.
- `getOrCreateSession(sessionId)` — return (or create) the in-memory per-session state (`SessionWorkingState`). Useful for inspection.

### `BackgroundIndexer`

Converts accumulated raw chunks into closed mems (summaries + embeddings). Triggered count-based (default: every 16 active chunks). Used internally by `ContextFactory`.

**Constructor:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `summarizer` | `ILLMSummarizer` | yes | LLM that segments chunks into topic mems |
| `memStore` | `IMemStore` | yes | Storage backend |
| `indexThreshold` | `number` | no | Active-chunk count that triggers indexing (default: `16`) |

### `LLMSummarizer`

Concrete `ILLMSummarizer` implementation using any OpenAI-compatible chat completions endpoint.

**Constructor** (`LLMSummarizerConfig`):

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `apiKey` | `string` | yes | API key |
| `baseUrl` | `string` | no | API base URL, default OpenRouter (`https://openrouter.ai/api/v1`) |
| `model` | `string` | no | Model name, default `google/gemini-2.5-flash` |

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

- `getEstablishedVocabulary(minCount?)` — returns `VocabularyTerm[]` for terms that appear in at least `minCount` mems (default 3)
- `getVocabulary()` — returns all `VocabularyTerm[]` regardless of frequency

```typescript
import { PostgresMemStore, VocabularyTerm } from '@alexmakeev/llmems';

const store = new PostgresMemStore(process.env.POSTGRES_URL!);
const terms: VocabularyTerm[] = await store.getEstablishedVocabulary(5);
// [{ id: 1, term: 'pgvector', firstSeenAt: Date, memCount: 12 }, ...]
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
  buildMemContext(contextId: string): Promise<MemContextData>;
  applyBackgroundResult(
    mems: { summary: string; chunkIds: string[]; embeddings: { full: number[]; compact: number[]; micro: number[] } }[],
    tailChunkIds: string[],
    newGeneralSummary: string | null,
    contextId: string,
  ): Promise<void>;
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
  embeddings: { full: number[]; compact: number[]; micro: number[] };
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
  summarize(systemPrompt: string, detectionPrompt: string): Promise<SummarizationResult | null>;
}
```

`LLMSummarizer` is the built-in implementation for OpenAI-compatible APIs.

### Context quality metric

Pure, deterministic scoring — no IO. Useful for evaluating how well the assembled context matches the current session focus.

```typescript
import { computeContextQualityScore } from '@alexmakeev/llmems';

const score = computeContextQualityScore({
  focusVector: session.focusVector,
  loadedMems: session.loadedMems,
  rawTail: session.rawTail,
  // ...
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

- Each mem ≈ 15–26 tokens (language-dependent)
- Default mem limit: 500 per context ID
- 500 mems ≈ 8–13k tokens — fits comfortably in modern context windows
- 500 mems ≈ a week of intensive daily conversations

Beyond 500 mems the oldest are no longer included in context. Keep separate context IDs for separate topics to stay well under the limit.

```bash
export LLMEMS_MAX_MEMS=500  # default
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
  id                SERIAL PRIMARY KEY,
  memstore_id       INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
  summary           TEXT NOT NULL,
  chunk_ids         INTEGER[] NOT NULL DEFAULT '{}',
  embedding         vector(1024),
  embedding_compact vector(256),
  embedding_micro   vector(64),
  closed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mem_chunks (
  id           SERIAL PRIMARY KEY,
  memstore_id  INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
);

-- Vocabulary support
CREATE TABLE IF NOT EXISTS vocabulary (
  id            SERIAL PRIMARY KEY,
  term          TEXT NOT NULL,
  term_lower    TEXT NOT NULL UNIQUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

All fallible methods return `Result<T, E>` (from [neverthrow](https://github.com/supermacro/neverthrow)):

```typescript
const result = await embeddingService.embed('hello');
if (result.ok) {
  console.log(result.value); // EmbeddingValue
} else {
  console.error(result.error.message);
}
```

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm test           # run all tests with vitest (no external services required)
npm run test:watch
```

## License

MIT
