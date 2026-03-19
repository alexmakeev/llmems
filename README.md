# @alexmakeev/llmems

Long-term memory for LLM agents. Conversations are broken into chunks, chunks are summarized into atomic "mems" in the background, mems are stored with embeddings. The LLM always sees layered context: general summary + recent topic summaries + semantic recall + current conversation.

## What is this

Most LLM chat wrappers either stuff the entire conversation history into the context (expensive, hits limits quickly) or forget everything between sessions (useless for long-term agents).

`llmems` takes a Zettelkasten-inspired approach:

- Every message is a **chunk** — a raw conversation fragment
- Background summarization groups related chunks into **mems** — atomic topic units with a 1-2 sentence summary
- Mems get **embeddings** (Matryoshka: 1024/256/64 dims) for semantic search
- On each new message, relevant mems are **recalled** and injected into context alongside recent conversation

The result: the LLM remembers everything important across arbitrarily long conversations, within a bounded context window.

## How it works

```
User message
     │
     ▼
┌────────────────────────────────────────────┐
│              OpenRouterChat                │
│                                            │
│  1. Store message as chunk                 │
│  2. Recall relevant mems (semantic search) │
│  3. Build layered context:                 │
│     ┌─────────────────────────────────┐    │
│     │ System prompt                   │    │
│     │ General summary (oldest mems)   │    │
│     │ Recent topic summaries (N-2,N-1)│    │
│     │ Recalled mems (semantic match)  │    │
│     │ Last closed topic (N)           │    │
│     │ Active chunks (current convo)   │    │
│     └─────────────────────────────────┘    │
│  4. Call LLM API (OpenRouter)              │
│  5. Store response as chunk                │
│  6. Schedule background summarization      │
└────────────────────────────────────────────┘
     │
     ▼
  LLM response

Background (after debounce, default 10 min):
  Active chunks → LLM detects topic boundaries
               → closed topics get summaries + embeddings
               → active chunks trimmed to tail
               → general summary updated
```

**The Zettelkasten analogy:** each mem is like an atomic note card — one topic, a clear summary. When you ask something, the relevant cards are pulled from the archive and placed in front of the LLM, just like a researcher pulling relevant notes before writing.

> **Not a chat history.** `llmems` does not store raw conversation logs and replay them. It compacts conversations into structured, summarized memories — preserving facts while using a fraction of the tokens that verbatim history would require.

## Memory in practice

### How memory works

The system operates transparently during conversation pauses:

1. **Conversation flows normally** — user talks to the bot, bot responds
2. **Background compaction** — when there's a pause (default: 10 min of silence), the system automatically summarizes the conversation into atomic mems. Each mem is 1-2 sentences capturing key facts
3. **Growing context** — mems accumulate over time. On each new message, the last 500 mems are included in the prompt alongside semantically recalled mems, giving the bot a rich history
4. **User doesn't notice** — compaction happens in the background; the experience is seamless

### Token economics

- Each mem ≈ 15–26 tokens (depending on language)
- 500 mems ≈ 8–13k tokens — fits comfortably in modern context windows
- 500 mems represents roughly a week of intensive daily conversations
- Each context ID (mem store) has its own independent history, so multiple topics can each hold 500 mems independently

### Beyond 500 mems

When a conversation accumulates more than 500 mems, older ones are no longer included in the context window. The system continues to work — it just loses the oldest memories. We're working on infinite memory through hierarchical summarization.

Current best practice: keep separate context IDs for separate topics, so each stays well under the limit.

### Configuring the mem limit

```bash
# Default: 500
export LLMEMS_MAX_MEMS=500
```

Or set it per instance via the mem store — 500 is the default used by `PostgresMemStore.getClosedMems()`.

## Quick Start

### Installation

```bash
# Add the GitHub Packages registry for this scope
echo "@alexmakeev:registry=https://npm.pkg.github.com" >> .npmrc

npm install @alexmakeev/llmems
```

### Minimal example (in-memory, no persistence)

```typescript
import { OpenRouterChat, InMemoryMemStore } from '@alexmakeev/llmems';

// Minimal LLMem — no vector search, topic context only
const llmem = {
  contextId: 'my-chat',
  async store() { return { ok: true as const, value: { stored: true as const } }; },
  async recall() { return { ok: true as const, value: { recall: { nodes: [], edges: [] } } }; },
};

const chat = new OpenRouterChat({
  apiKey: process.env.OPENROUTER_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
  llmem,
  memStore: new InMemoryMemStore(),
  model: 'google/gemini-2.5-flash', // default
});

const result = await chat.prompt('Tell me about Paris.');
if (result.ok) {
  console.log(result.value.text);
}
```

### With PostgreSQL persistence

```typescript
import { OpenRouterChat, PostgresMemStore } from '@alexmakeev/llmems';

const memStore = new PostgresMemStore(process.env.POSTGRES_URL!);

const llmem = {
  contextId: 'user-123',
  async store() { return { ok: true as const, value: { stored: true as const } }; },
  async recall() { return { ok: true as const, value: { recall: { nodes: [], edges: [] } } }; },
};

const chat = new OpenRouterChat({
  apiKey: process.env.OPENROUTER_API_KEY!,
  systemPrompt: 'You are a helpful assistant.',
  llmem,
  memStore,
});

// Conversation persists across restarts
const result = await chat.prompt('My name is Alice.');
if (result.ok) {
  console.log(result.value.text);
}

// On app shutdown
await memStore.close();
```

## API Reference

### `OpenRouterChat`

Main entry point. Wraps an LLM call with memory context.

**Constructor** (`OpenRouterChatOptions`):

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `apiKey` | `string` | yes | OpenRouter API key |
| `systemPrompt` | `string` | yes | Your system prompt (appended after base prompt) |
| `llmem` | `LLMem` | yes | Memory backend (store + recall interface) |
| `model` | `string` | no | Model name, default `google/gemini-2.5-flash` |
| `memStore` | `IMemStore` | no | Chunk/mem storage, default `InMemoryMemStore` |
| `embeddingService` | `IEmbeddingService` | no | Generates embeddings for closed mems |
| `backgroundDebounceMs` | `number` | no | Delay before background summarization, default `600000` (10 min) |
| `debugLog` | `boolean` | no | Log all LLM calls to JSONL file |
| `debugLogPath` | `string` | no | Path to debug log, default `logs/llm-calls.jsonl` |
| `responseFormat` | `{ schema: ZodSchema, systemInstructions?: string }` | no | Structured JSON output |
| `getBehaviorInstructions` | `() => Promise<string>` | no | Dynamic instructions injected into context per message |

**Methods:**

- `prompt(message, options?)` — send a message, get a response. Stores both sides in memory and schedules background summarization. Returns `Result<ChatResponse, MemoryError>`.
- `ask(question)` — read-only query. Uses memory context but does NOT store messages or modify state. Returns `Promise<string>`.
- `dryRun(message)` — full prompt cycle with no state changes. Returns `DryRunResult` showing what the LLM saw (context layers, recall nodes, active chunks).
- `promptWithTools(message, tools, options?)` — send a message with tool definitions. Returns `Result<ChatResponseWithTools, MemoryError>`.
- `getTopicStats()` — returns current memory state: closed topic count, active chunk count, general summary.
- `storeAssistantMessage(text)` — manually store an assistant message (use when handling tool calls externally).
- `buildContext(messages, recallNodes)` — format recalled nodes into text (exposed for custom chat loops).

### `MemManager`

Orchestrates the chunk/mem lifecycle. Used internally by `OpenRouterChat`; rarely needed directly.

- `addChunk(content, timestamp, contextId)` — add a raw conversation chunk
- `getContextData(contextId)` — returns `MemContextData` for building LLM context
- `applyBackgroundResult(mems, tailChunkIds, newGeneralSummary, contextId)` — commit a background summarization result
- `getClosedMemCount(contextId)`, `getAllClosedMems(contextId)`, `getLastClosedMem(contextId)` — introspection

### `PostgresMemStore`

PostgreSQL + pgvector storage for chunks and mems. Persists state across process restarts.

```typescript
const store = new PostgresMemStore('postgresql://user:pass@localhost:5432/mydb');
// use with OpenRouterChat via memStore option
await store.close(); // drain connection pool on shutdown
```

### `InMemoryMemStore`

In-process storage — no dependencies, no persistence. Suitable for testing and short-lived sessions.

```typescript
const store = new InMemoryMemStore();
```

### Key interfaces

```typescript
// Storage backend — implement to use a custom store
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
  // optional:
  getBehaviorInstructions?(contextId: string): Promise<string>;
  setBehaviorInstructions?(instructions: string, contextId: string): Promise<void>;
}

// A raw conversation fragment
interface MemChunk { id: string; content: string; timestamp: Date; }

// A closed (summarized) topic unit
interface Mem {
  id: string;
  summary: string;
  chunkIds: string[];
  embeddings: { full: number[]; compact: number[]; micro: number[] }; // 1024/256/64 dims
  closedAt: Date;
}

// Context assembled for the LLM
interface MemContextData {
  generalSummary: string;
  recentClosedMems: Mem[];
  lastClosedMem: Mem | null;
  activeChunks: MemChunk[];
}

// Memory backend used by OpenRouterChat
interface LLMem {
  contextId: string;
  store(text: string, metadata?: { sessionId?: string }): Promise<Result<StoreResult, MemoryError>>;
  recall(query: string): Promise<Result<RecallMemoryResult, MemoryError>>;
}
```

### `memoryModuleConfigSchema`

Zod schema for the full memory module config (embedding + LLM extractors + mem store backend). Use when building a pipeline with vector search.

```typescript
import { memoryModuleConfigSchema } from '@alexmakeev/llmems';

const config = memoryModuleConfigSchema.parse({
  embedding: { apiKey: '...', model: 'qwen/qwen3-embedding-8b' },
  llmExtractor: { apiKey: '...' },
  graphExtractor: { apiKey: '...' },
  memStore: { type: 'postgres', postgres: { connectionString: '...' } },
});
```

Key fields: `embedding.model` (default `qwen/qwen3-embedding-8b`), `memStore.type` (`'memory'` | `'postgres'`), `useEntityNodes` (toggle entity-based recall, default `true`).

Environment variable shortcuts: `MEM_STORE_TYPE` and `POSTGRES_URL` are read automatically by the schema defaults.

## Configuration

### Background summarization

Summarization runs in the background after `backgroundDebounceMs` milliseconds of silence (no new messages). Each call to `prompt()` resets the timer. The default is 10 minutes — tune it based on your conversation cadence:

```typescript
const chat = new OpenRouterChat({
  // ...
  backgroundDebounceMs: 30_000, // 30 seconds — aggressive, for short sessions
});
```

### Debug logging

Enable to capture every LLM call as a JSONL file for debugging:

```typescript
const chat = new OpenRouterChat({
  // ...
  debugLog: true,
  debugLogPath: 'logs/llm-calls.jsonl',
});
```

## Storage

### PostgreSQL schema

`PostgresMemStore` requires the `pgvector` extension and three tables:

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
```

Connection string format: `postgresql://user:password@host:5432/database`

`PostgresMemStore` creates `memstores` rows on demand (one per `contextId`). Table creation is your responsibility.

## Supported Models

Works with any OpenAI-compatible chat completions API:

- **OpenRouter** (default) — access Gemini, Claude, GPT-4, Llama, and others via a single key at `https://openrouter.ai/api/v1`
- **OpenAI directly** — set `model` to any OpenAI model name, provide your OpenAI key
- **Local models** — Ollama, LM Studio, vLLM, or any server implementing the `/v1/chat/completions` endpoint

Default model: `google/gemini-2.5-flash`

## Result type

All fallible methods return `Result<T, E>` (from [neverthrow](https://github.com/supermacro/neverthrow)):

```typescript
const result = await chat.prompt('Hello');
if (result.ok) {
  console.log(result.value.text);   // ChatResponse
} else {
  console.error(result.error.type, result.error.message); // MemoryError
}
```

Error types: `'config'` | `'connection'` | `'extraction'` | `'storage'` | `'query'`

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm test           # run tests with vitest (no external services required)
npm run test:watch
```

## License

MIT
