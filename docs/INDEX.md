# llmems — State Recap (feature/context-factory)

Последнее обновление: 2026-05-21

---

## Где мы сейчас

Ветка `feature/context-factory`. **llmems = чистая абстрактная память v0.4.0.**

Эта сессия закрыла три эпика:

- **vp3** (Phase 1 baseline context factory) — `ContextFactory.remember()` + `getCurrentContext()` + per-session state + EMA-фокус + ANN-recall + dedup + softRebuild. Baseline composite ≈ 0.9167 (`docs/baseline-metric.md`).
- **flf** (dual-vector recall + background indexer) — `BackgroundIndexer` standalone, `remember()` → `mem_chunk(active)`, count-based trigger, session/theme vector, dual-vector recall (session + current), sloyonka per-provenance, context-quality metric. Тесты: 222/222 green (flake fixed, 8x stable). `tsc` чисто.
- **e0b** (abstract-cleanup) — `OpenRouterChat` удалён, `LLMSummarizer` standalone, порты почищены, публичный API минимален. Чат-слой перенесён в altme-bot (ветка `absorb-chat`). Релиз: v0.4.0.

---

## Что дальше (user-owned)

1. **altme-bot** — review + merge + deploy ветки `absorb-chat`.
2. **npm** — опубликовать `@alexmakeev/llmems@0.4.0`.
3. **Altme upgrade** — поднять до v0.4.0; опционально: принять dual-vector `ContextFactory`.
4. **Phase 2** (`xcz`) — структура памяти + граф досборка; gated on baseline. Биды ниже.

---

## Активные биды

### flf epic (открыт, sub-задачи done)

| ID | Описание | Статус |
|----|----------|--------|
| llmems-flf | Dual-vector recall + background indexer (EPIC) | open |

### P2 — Фаза 2 (gated on Phase 1 baseline)

| ID | Описание | Статус |
|----|----------|--------|
| llmems-xcz | Phase 2 — Structure + graph dosborka | open |
| llmems-xcz.1 | Mem typing (event/period, ts vs event-time) | open |
| llmems-xcz.2 | Hierarchical mems (year/quarter/month/day) | open |
| llmems-xcz.3 | Graph dosborka — neighborhood expansion по 7 осям | open |
| llmems-xcz.4 | Измерение uplift Phase 2 vs baseline | open |
| llmems-e08 | Session lifecycle (TTL/LRU/eviction) | open |
| llmems-dnh | Gold-set для baseline (не на этой машине) | open |
| llmems-wji | Runbook benchmark pipeline (docs/benchmark.md) | open |
| llmems-2le | fix: re-extract-projections без openaiModel/openaiBaseUrl | open |
| llmems-a9r | security: dev-DB password в defaults benchmark scripts | open |

### P3 — Deferred / Backlog

| ID | Описание |
|----|----------|
| llmems-7zm | Graph densification (backbone subgraph) |
| llmems-mai | Edge cases тесты ContextFactory |
| llmems-fqx | Rename `EmbeddingValue.compact` → `vector` |
| llmems-jvu | Schema-init/migration в репо |
| llmems-sbg | Cleanup stale gitea remote |
| llmems-bgy | Experiment: сравнение embedding моделей |
| llmems-76f | Redesign graphEnrichedRecall scoring |

---

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/services/context-factory.ts` | Основная реализация ContextFactory |
| `src/services/background-indexer.ts` | Standalone BackgroundIndexer (raw→mem→archive) |
| `src/services/llm-summarizer.ts` | Standalone LLMSummarizer (OpenAI-compatible) |
| `src/services/postgres-mem-store.ts` | PostgreSQL-реализация IVectorMemStore |
| `src/services/context-metric.ts` | Метрика качества контекста |
| `src/types.ts` | Доменные типы (Mem, EmbeddingValue, IVectorMemStore, …) |
| `src/index.ts` | Публичный barrel-экспорт библиотеки |
| `docs/vision.md` | Архитектурное видение (north-star) |
| `docs/building-a-chat.md` | Паттерн потребителя: чат поверх llmems |
| `docs/baseline-metric.md` | Методика и результат замера baseline |
| `docs/axis-experiment.md` | Эксперимент с осями (dual-vector recall) |
| `sandboxes/schema-native.sql` | DDL схемы БД (pgvector HNSW) |
