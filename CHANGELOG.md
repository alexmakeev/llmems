# Changelog

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
