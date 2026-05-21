# Building a Chat on Top of llmems

llmems is abstract memory — it does not generate responses, assign roles, or maintain a persona. Those are consumer concerns. This document shows the pattern for building a chat (or any interactive agent) on top of the library.

## The core loop

```
user message
  → remember(sessionId, userMessage)     // store fragment, shift focus, load relevant mems
  → getCurrentContext(sessionId)         // get assembled context string
  → your LLM call with context prepended // you own the API call, model, and system prompt
  → remember(sessionId, assistantReply)  // store the reply too (shifts focus, feeds future mems)
  → return reply to user
```

Both turns — user and assistant — go through `remember`. The assistant reply shifts the session focus and becomes raw material for future mems. If the user leaves mid-conversation, the last assistant turn is preserved as a fragment.

## Minimal implementation

```typescript
import {
  ContextFactory,
  BackgroundIndexer,
  LLMSummarizer,
  InMemoryMemStore,
  type IEmbeddingService,
  type EmbeddingValue,
  ok, err,
} from '@alexmakeev/llmems';

// --- Your embedding service ---
// Replace with a real call to openai/text-embedding-3-small or similar.
const embeddingService: IEmbeddingService = {
  async embed(text: string) {
    const vector = await callYourEmbeddingApi(text); // returns number[]
    const value: EmbeddingValue = {
      full: vector,       // 1536-dim for openai/text-embedding-3-small
      compact: vector,    // same vector (compact alias, historical)
      micro: vector,      // same vector (micro alias, historical)
    };
    return ok(value);
  },
};

// --- Wire up llmems ---
const memStore = new InMemoryMemStore(); // or PostgresMemStore for persistence
const summarizer = new LLMSummarizer({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'google/gemini-2.5-flash',
});
const indexer = new BackgroundIndexer(summarizer, memStore);
const memory = new ContextFactory({ embeddingService, indexer, memStore });

// --- Your chat function ---
async function chat(sessionId: string, userMessage: string): Promise<string> {
  // 1. Feed the user message to memory (shifts focus, loads relevant mems)
  await memory.remember(sessionId, `User: ${userMessage}`);

  // 2. Assemble context — stable prefix + dynamic block + raw tail
  const memoryContext = await memory.getCurrentContext(sessionId);

  // 3. Build your messages array — you own the system prompt and model choice
  const messages = [
    {
      role: 'system',
      content: [
        'You are a helpful assistant.',
        '',
        '--- Memory context ---',
        memoryContext,
        '--- End of memory context ---',
      ].join('\n'),
    },
    { role: 'user', content: userMessage },
  ];

  // 4. Call your LLM (replace with real API call)
  const reply = await callYourLLM(messages);

  // 5. Store the assistant reply so future turns can build on it
  await memory.remember(sessionId, `Assistant: ${reply}`);

  return reply;
}
```

## What llmems provides in `getCurrentContext`

The returned string is structured as a layered block:

```
[stable prefix — already-cached mems, prompt-cache-friendly]
Loaded from memory:
<mem ts="2026-05-20T14:32:00Z">User's name is Alice. She is learning TypeScript.</mem>
<mem ts="2026-05-20T14:45:00Z">Alice asked about async/await and understood the Promise model.</mem>

[raw tail — recent unindexed fragments]
User: What is a closure?
Assistant: A closure is a function that captures variables from its outer scope...
User: Can you give an example?
```

Prepend this block to your system prompt or inject it as a dedicated system message — either way the LLM sees the assembled memory alongside the live conversation.

## Persistence across restarts

Swap `InMemoryMemStore` for `PostgresMemStore`. The same `sessionId` picks up all mems from previous process runs automatically:

```typescript
import { PostgresMemStore } from '@alexmakeev/llmems';

const memStore = new PostgresMemStore(process.env.POSTGRES_URL!);
// ... same setup as above

// On shutdown
await memStore.close();
```

## Reference implementation

`OpenRouterChat` (removed from llmems in v0.4.0) is the reference consumer implementation. It lives in altme-bot (`absorb-chat` branch) and demonstrates:

- `IEmbeddingService` wired to OpenRouter's embedding endpoint
- `LLMSummarizer` with retry logic
- `ContextFactory` used inside a `prompt()` method
- Tool calls via `promptWithTools()`
- Structured JSON output via `responseFormat`
- `getVocabulary()` callback for injecting domain terms into the system prompt

Use it as a reference when you need those features, not as a dependency.
