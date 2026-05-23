# Changelog

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
