# llmems — State Recap (feature/context-factory)

Последнее обновление: 2026-05-21

---

## Где мы сейчас

Ветка `feature/context-factory`. **Epic `llmems-flf` Stage 1 завершён.**

### Фаза 1 baseline context factory (закрыта, epic `vp3`)

- `ContextFactory.remember()` — rawTail, EMA-сдвиг фокус-вектора, ANN-поиск, dedup, мягкая перестройка по порогу.
- `ContextFactory.getCurrentContext()` — чистая проекция слоёнки (stable prefix → marker → dynamic block → raw tail), без БД.
- Per-session working state (focusVector + loaded-mem cache + out-of-order counter).
- Recalled-memory marker (конфигурируемый). Raw/mem dedup. SoftRebuild по cosine-sim.
- Эмбеддинги: `openai/text-embedding-3-small` @ 1536 dim, OpenRouter.
- Архитектурный ревью: 0 critical, FIX1–5 применены.
- Baseline composite ≈ 0.9167 (`docs/baseline-metric.md`).

### Epic `llmems-flf` Stage 1 (закрыт, commits 1089906 / c2a822e / 57721e1)

Биды flf.1–flf.4, drc — **done**.

- **flf.1** — Standalone `BackgroundIndexer` извлечён из `OpenRouterChat`, инжектирован в `ContextFactory`; старый путь зелёный через делегирование.
- **flf.2** — `remember()` сохраняет каждый фрагмент как `mem_chunk(active)`, `chunkId` хранится в rawTail.
- **flf.3** — Count-based trigger индексера: active-chunk count ≥ `indexThreshold` (default 16), fire-and-forget + guard против параллельного запуска.
- **flf.4** — Session/theme vector = normalize(mean(last N=100 mems embeddings.full)); пересчитывается после каждого запуска индексера; кэшируется в per-session state.
- **drc** — rawTail drain при reconciliation: raw-чанки заменяются mem-ом после индексации (bead был в Phase-1 known gaps).

Тесты: **212/212 green**. `tsc` — чисто.

---

## Что дальше

**Epic `llmems-flf` Stage 2** — **GATED** на решение пользователя по дизайну:

> Управляет ли session-vector отдельным recall-запросом (dual-vector recall), или тема = накопленный cache-prefix backbone, а recall — только через current-vector?

До ответа Stage 2 заблокирован. Когда решение принято:

| Бид | Описание |
|-----|----------|
| flf.5 | S2.6 Dual-vector recall (session + current queries) + per-mem provenance |
| 991 | S2.7 Слоёнка layer 2/3: provenance split (focus-loaded vs raw-tail) |
| tda | S2.8 Remove old context path (buildContext/buildTopicContext) |
| flf.6 | S2.9 Metric update для dual-vector (per-provenance) + re-measure baseline |

После Stage 2 — **epic `llmems-xcz`** (структура памяти + граф досборка, uplift vs baseline).

---

## Активные биды

### P1 — Epic flf (открыт, Stage 2 gated)

| ID | Описание | Статус |
|----|----------|--------|
| flf | Dual-vector recall + background indexer (EPIC) | open |
| flf.5 | S2.6 Dual-vector recall + per-mem provenance | open (gated) |
| flf.6 | S2.9 Metric update + re-measure baseline | open (gated) |

### P2 — Фаза 2 (gated on flf)

| ID | Описание | Статус |
|----|----------|--------|
| 991 | Слоёнка layer 2/3: provenance split | open |
| tda | Remove old context path (Path A cleanup) | open |
| e08 | Session lifecycle (TTL/LRU/eviction) | open |
| xcz | Phase 2 — Structure + graph dosborka | open |
| xcz.1 | Mem typing (event/period, ts vs event-time) | open |
| xcz.2 | Hierarchical mems (year/quarter/month/day) | open |
| xcz.3 | Graph dosborka — neighborhood expansion по 7 осям | open |
| xcz.4 | Измерение uplift Phase 2 vs baseline | open |

### P3 — Deferred

| ID | Описание |
|----|----------|
| mai | Edge cases тесты ContextFactory |
| fqx | Rename `EmbeddingValue.compact` → `vector` |
| dnh | Gold-set для baseline (не на этой машине) |
| jvu | Schema-init/migration в репо |
| sbg | Cleanup stale gitea remote |
| bgy | Experiment: сравнение embedding моделей |
| 76f | Redesign graphEnrichedRecall scoring |

### Backlog

| ID | Описание |
|----|----------|
| 2le | fix: re-extract-projections без openaiModel/openaiBaseUrl |
| wji | Runbook benchmark pipeline (docs/benchmark.md) |
| a9r | security: dev-DB password в defaults benchmark scripts |

---

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/services/context-factory.ts` | Основная реализация ContextFactory |
| `src/services/background-indexer.ts` | Standalone BackgroundIndexer (raw→mem→archive) |
| `src/services/postgres-mem-store.ts` | PostgreSQL-реализация IVectorMemStore |
| `src/services/context-metric.ts` | Метрика качества контекста |
| `src/types.ts` | Доменные типы (Mem, EmbeddingValue, IVectorMemStore, …) |
| `docs/vision.md` | Архитектурное видение (north-star) |
| `docs/baseline-metric.md` | Методика и результат замера baseline |
| `sandboxes/schema-native.sql` | DDL схемы БД (pgvector HNSW) |
