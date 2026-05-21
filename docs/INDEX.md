# llmems — State Recap (feature/context-factory)

Последнее обновление: 2026-05-21

---

## Где мы сейчас

Ветка `feature/context-factory`. **Фаза 1 baseline context factory завершена.**

Epic `vp3` закрыт. Все суббиды vp3.1–vp3.7 и `zij` (переключение эмбеддингов) — done.

**Что реализовано:**
- `ContextFactory.remember()` — сохранение фрагмента в rawTail, EMA-сдвиг вектора фокуса, ANN-поиск по фокусу, dedup-фильтр (уже загруженные + raw-present чанки), мягкая перестройка по порогу.
- `ContextFactory.getCurrentContext()` — чистая проекция: слоёнка (стабильный prefix → маркер + динамический блок → сырьевой хвост), без обращений к БД.
- Per-session working state (focusVector + loaded-mem cache + out-of-order counter), ключ sessionId.
- Recalled-memory marker (`"Loaded from memory:"`, конфигурируемый).
- Raw/mem dedup при загрузке (исключение уже загруженных + мемов с активными исходными чанками).
- Мягкая перестройка (`softRebuild`): отбор по cosine-sim к фокусу, хронологическая сортировка выживших.
- Эмбеддинги: `openai/text-embedding-3-small` @ 1536 dim, single-resolution, через OpenRouter (Matryoshka/256/64 убраны).
- Тесты: 177/177 green. `tsc` — без ошибок.
- Архитектурный ревью фазы 1: 0 critical, все FIX1–5 применены.
- Baseline-метрика зафиксирована: composite ≈ 0.9167 (методика: `docs/baseline-metric.md`).

---

## Что дальше

**Фаза 2 разблокирована** (`vp3` закрыт). Следующий epic — `llmems-xcz` (структура памяти + граф досборка).

Baseline composite 0.9167 — точка отсчёта. Фаза 2 должна показать uplift (bead xcz.4).

---

## Активные биды

### P2 — Фаза 2

| ID | Описание | Статус |
|----|----------|--------|
| xcz | Epic: Phase 2 — Structure + graph dosborka (gated on vp3) | open |
| xcz.1 | Mem typing (event/period, ts vs event-time) | open |
| xcz.2 | Hierarchical mems (year/quarter/month/day) | open |
| xcz.3 | Graph dosborka — neighborhood expansion по 7 осям | open |
| xcz.4 | Измерение uplift Phase 2 vs baseline | open |

### Deferred

| ID | Описание |
|----|----------|
| 991 | Слоёнка layer 2/3: provenance split (focus-loaded vs raw-tail) |
| tda | Remove old context path (buildContext/buildTopicContext) — Path A coexistence cleanup |
| drc | rawTail drain (raw→mem replacement) |
| e08 | Session lifecycle (TTL/LRU/eviction) |
| mai | Edge cases тесты ContextFactory |
| fqx | Rename `EmbeddingValue.compact` → `vector` |
| dnh | Gold-set для baseline (не на этой машине) |
| jvu | Schema-init/migration в репо |

### Backlog

| ID | Описание |
|----|----------|
| 2le | fix: re-extract-projections без openaiModel/openaiBaseUrl |
| bgy | Experiment: сравнение embedding моделей на baseline vectorRecall |
| a9r | security: dev-DB password в defaults benchmark scripts |
| wji | Runbook benchmark pipeline (docs/benchmark.md) |
| sbg | Cleanup stale gitea remote |
| 76f | Redesign graphEnrichedRecall scoring |

---

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/services/context-factory.ts` | Основная реализация ContextFactory |
| `src/services/postgres-mem-store.ts` | PostgreSQL-реализация IVectorMemStore |
| `src/services/context-metric.ts` | Метрика качества контекста |
| `src/types.ts` | Доменные типы (Mem, EmbeddingValue, IVectorMemStore, …) |
| `docs/vision.md` | Архитектурное видение (north-star) |
| `docs/baseline-metric.md` | Методика и результат замера baseline |
| `sandboxes/schema-native.sql` | DDL схемы БД (pgvector HNSW) |
