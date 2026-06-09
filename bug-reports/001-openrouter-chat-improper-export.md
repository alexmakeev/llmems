# Bug Report 001 — OpenRouterChat improperly exported from the abstract memory library

**Date:** 2026-05-21
**Severity:** Architectural (API surface pollution)
**Status:** Resolved (Stage B — chat moved into altme-bot)

## Title

OpenRouterChat improperly exported from the abstract memory library (@alexmakeev/llmems)

## Problem Description

The `OpenRouterChat` class — a chat wrapper that combines LLM inference (OpenRouter API calls,
retry logic, tool calling) with topic-aware context building — was included in and exported from
`@alexmakeev/llmems`, a library whose purpose is abstract memory management (storing, recalling,
and indexing conversation memory).

This caused:

- **Leaky API surface:** The library's public `index.ts` exported `OpenRouterChat`,
  `ToolDefinition`, `ToolCall`, `ChatResponseWithTools`, `LLMem`, `StoreResult`, `MemoryError`,
  `RecallMemoryResult`, and `ChatResponse` — all chat-layer concepts that have no place in an
  abstract memory library.
- **Improper dependency:** `altme-bot` (the production consumer) imported `OpenRouterChat` and
  associated chat types directly from `@alexmakeev/llmems`, creating a coupling between a
  concrete LLM provider integration and the abstract memory layer.
- **Hidden dependency chain:** `OpenRouterChat` internally used `BackgroundIndexer` and
  `LLMSummarizer` — services wired into the library internals — making it harder to reason about
  what `@alexmakeev/llmems` actually does.

## Root Cause

The `openrouter-chat.ts` file originated as an **example/integration layer** demonstrating how to
use the memory library with OpenRouter. Over time it was included in the library's published API
surface (`src/index.ts`) without being separated into its own package or repository. The example
leaked into the published surface.

## Resolution

**Stage B:** The chat layer has been absorbed into `altme-bot`'s own source code:

- A new folder `src/services/chat/` was created in `altme-bot`, containing:
  - `openrouter-chat.ts` — the `OpenRouterChat` class (copied from the lib)
  - `background-indexer.ts` — `BackgroundIndexer` service (copied from the lib)
  - `llm-summarizer.ts` — `LLMSummarizer` service (copied from the lib)
  - `retry-sleep.ts` — retry delay helper (copied from the lib)
  - `types.ts` — `IEmbeddingService` and `EmbeddingValue` (chat-layer types)
  - `index.ts` — barrel export for the local chat layer
- All abstract memory pieces (`MemManager`, `PostgresMemStore`, `ok`, `err`, `Result`,
  `VocabularyTerm`, `IMemStore`, `RecallNode`, `createMemoryLogger`) continue to be imported
  from `@alexmakeev/llmems`.
- Import sites in `altme-bot` were updated: `OpenRouterChat` and chat types now come from
  `./services/chat/` instead of `@alexmakeev/llmems`.

**Stage C (next):** Remove `OpenRouterChat` and all chat-specific exports from `@alexmakeev/llmems`
`src/index.ts` and `src/openrouter-chat.ts`, making the library a pure abstract memory module.

## Files Affected

### altme-bot (Stage B — chat absorbed)
- `src/services/chat/openrouter-chat.ts` — added (local copy)
- `src/services/chat/background-indexer.ts` — added (local copy)
- `src/services/chat/llm-summarizer.ts` — added (local copy)
- `src/services/chat/retry-sleep.ts` — added (local copy)
- `src/services/chat/types.ts` — added (IEmbeddingService, EmbeddingValue)
- `src/services/chat/index.ts` — added (barrel export)
- `src/services/chat-manager.ts` — updated (imports from local chat/)
- `src/tools/altme-tools.ts` — updated (ToolDefinition from local chat/)
- `src/__tests__/telegram-bot.test.ts` — updated (mocks adjusted for new module location)

### llmems (Stage C — pending)
- `src/index.ts` — remove OpenRouterChat + chat type exports
- `src/openrouter-chat.ts` — remove or move to examples/

## Verification

- altme-bot `tsc --noEmit`: clean (0 errors)
- altme-bot `vitest run`: 189/189 tests pass
- Branch: `absorb-chat` in altme-bot (not pushed, not deployed)
