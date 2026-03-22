# Changelog

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
