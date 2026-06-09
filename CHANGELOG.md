# Changelog

## 0.4.0 (unreleased)

The pivot to **pure abstract memory**. llmems no longer calls any LLM for chat, builds prompts, or generates responses — it manages long-term memory and projects it into a ready-to-prepend context block. Generation, system prompt, and persona are now entirely the consumer's responsibility (see `docs/building-a-chat.md`).

### BREAKING
- **Removed `OpenRouterChat`** and the entire LLM-calling chat layer (`prompt`, `ask`, `promptWithTools`, `dryRun`). The package no longer performs any chat/generation. Consumers importing `OpenRouterChat` must move that logic into their own code. This is a hard, one-way API break (acceptable under 0.x semver, and the documented intent of v0.4.0).

### Added
- **`ContextFactory`** (`src/services/context-factory.ts`) — the new entry point. Core API:
  - `remember(sessionId, fragment, contextId)` — mutates per-session working state: raw-tail append, fresh per-turn focus vector (the fragment's normalized embedding, used directly for ANN recall and soft-rebuild scoring — no EMA accumulation), dedup mem-load, soft-rebuild trigger, and fire-and-forget background indexing.
  - `getCurrentContext(sessionId)` — pure projection (no DB calls) into a single prompt-block string: stable backbone prefix → "Loaded from memory:" marker → dynamic mems (timestamped `<mem ts="…">` XML) → raw tail. The stable prefix is prompt-cache-friendly.
  - `getCurrentContextParts(sessionId)` — structured variant returning the three layers separately as `{ backbone, dynamic, rawTail }`, so a consumer can place a provider cache breakpoint at the layer boundary (the stable `backbone` is the cacheable prefix). `getCurrentContext` is implemented on top of it; the non-empty segments joined by `\n` (trimmed) reproduce the flat output exactly.
- **`BackgroundIndexer`** (`src/services/background-indexer.ts`) — standalone raw-chunk → closed-mem converter; count-based trigger (default 16 active chunks); fire-and-forget from `remember()`.
- **`LLMSummarizer`** (`src/services/llm-summarizer.ts`) — standalone OpenAI-compatible summarizer (retry policy, deterministic temperature) implementing the `ILLMSummarizer` port.
- **Context quality metric** (`src/services/context-metric.ts`) — `computeContextQualityScore` plus `computeFocusRelevance` / `computeDedupCorrectness` / `computeChronologyIntegrity`; pure, deterministic, no IO.
- **`IVectorMemStore`** — narrower store interface required by `ContextFactory` (adds `searchMemsByVector` + `getActiveChunkIds`). `PostgresMemStore` satisfies it; `InMemoryMemStore` does not, by design (compile-time enforced).
- **Soft cache rebuild** — `softRebuild` prunes the working set to `keepRatio` (default 70%) once `rebuildThreshold` (default 30) out-of-order appends accumulate; survivors are re-sorted chronologically.
- **Session/theme vector** — backbone recall over a normalized mean of recent closed-mem embeddings (`sessionVecN`, default 100).

### Changed
- **Public barrel (`src/index.ts`) rewritten** — now exports `ContextFactory`, `BackgroundIndexer`, `LLMSummarizer`, `MemManager`, store classes, `computeContextQualityScore`, `Result`/`ok`/`err`, and `memoryModuleConfigSchema`. `OpenRouterChat` is no longer exported.
- **Docs** — added `docs/vision.md`, `docs/building-a-chat.md`, `docs/baseline-metric.md`; README rewritten for the v0.4.0 API.

## 0.3.3 (2026-05-23)

- docs: document build & release process (README + CLAUDE.md)
- chore: no functional changes — first validation of the tag-driven CD publish pipeline

## 0.3.2 (2026-05-23)

### Changed
- **Unified OpenRouter request construction** — every chat path (`prompt`, `ask`, `promptWithTools`, background summarization) now assembles its request body through a single canonical builder, so structured output, provider routing, and the output-token cap apply uniformly. Previously each method built the body differently and only `ask()` honored the configured `responseFormat`.
  - **`prompt()` now sends `max_tokens`** (previously uncapped → risk of silent truncation) and, when a `responseFormat` schema is configured, a strict `json_schema` `response_format` plus `provider.require_parameters: true` (previously sent neither, so structured-output consumers got fenced/incomplete JSON from `prompt()`).
  - **`promptWithTools()`** keeps its existing behavior (tools + `max_tokens`, no `response_format`); the tools-vs-structured-output mutual exclusion is now encoded once in the shared builder.
  - Background summarization now derives its strict schema from the `BackgroundSummarizationSchema` Zod source of truth (the hand-written duplicate wire schema was removed) and gains `max_tokens`. Side effect: the `count` field is now typed `number` (matching the parser) instead of the previously hand-written `integer`.

### Fixed
- **Strict schema nullable-optional promotion** — when the strict-mode transform promotes an optional Zod property into `required` (as OpenAI/OpenRouter strict mode demands), it now also widens that property's type to allow `null`, so an omitted field stays expressible. Already-nullable and already-required properties are untouched. Previously optional fields were forced into `required` while keeping a single non-null type, making the schema unsatisfiable when the field was absent.

## 0.3.1 (2026-05-23)

### Fixed
- **`ask()` structured output** — `ask()` now forwards structured output to OpenRouter: it converts the configured Zod `responseFormat` schema into a strict `json_schema` `response_format`, sends `max_tokens`, and sets `provider.require_parameters: true`. Previously `ask()` sent a bare `{model, messages}` body, so models returned JSON wrapped in markdown fences and truncated output (~4K). Consumers configuring a `responseFormat` now receive clean, complete, schema-conformant JSON.

## 0.3.0 (2026-03-22)

### Added
- **Vocabulary storage** — domain-specific terminology extraction and persistence
  - LLM extracts terms per-topic during background summarization
  - `vocabulary` table with case-insensitive deduplication (LOWER unique index)
  - `mem_vocabulary` join table with `count_in_mem` for term-to-mem linking
  - Known terms passed to LLM prompt for consistent matching
  - Voice-aware extraction: only matches known terms from voice-transcribed content
  - `getEstablishedVocabulary(minCount?)` — returns terms with count ≥ threshold (default 3)
  - `getVocabulary()` — returns all terms
  - `VocabularyTerm` type exported from library
