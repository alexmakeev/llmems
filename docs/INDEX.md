# Project: llmems

**Last updated:** 2026-05-20
**Mode:** coding
**Status:** A/B recall experiment complete (branch experiment/axis-projections). Next: act on findings or close branch.

## Что это

Библиотека долгосрочной памяти для LLM-агентов (TypeScript). Хранит воспоминания в PostgreSQL с pgvector, структурирует по семантическим осям (персона, интересы, события и т.д.), поддерживает recall через векторный поиск и граф связей.

## Архитектура (коротко)

```
ingest  →  ProjectionExtractor (LLM → 7 axes)  →  pgvector (mems + mem_chunks)
                                                  ↓
recall  ←  vectorRecall / per-axis projections / graphEnrichedRecall
                                                  ↑
benchmark →  gold-set (LLM-judge)  →  recall@K metrics  →  compare-benchmarks
```

Ключевые env vars: `POSTGRES_URL`, `OPENROUTER_API_KEY`, `PROMPT` (путь к файлу промпта), `MEMSTORE_ID`.

## Ключевые точки входа

- `src/memstore.ts` — основной API: ingest, vectorRecall, getGraph
- `src/recall/benchmark-aggregation.ts` — per-axis агрегации: maxPerAxis / sumAcrossAxes / intersection
- `src/recall/recall-metrics.ts` — recall@K / precision@K
- `scripts/run-benchmark.ts` — запуск бенчмарка (MEMSTORE_ID + PROMPT из env)
- `scripts/compare-benchmarks.ts` — сравнение двух JSON-результатов бенчмарка
- `scripts/generate-gold-set.ts` — генерация gold-set через Gemini LLM-judge
- `scripts/clone-memstore.ts` — клонирование memstore (для изоляции экспериментов)
- `config/prompts/baseline.md` — мульти-осевой промпт (memstore 4)
- `config/prompts/strict-mece.md` — strict-MECE промпт (memstore 5, one-fact-one-axis)

## Результаты A/B эксперимента (experiment/axis-projections)

**Датасет:** katya-year, 100 eval вопросов. Gold-sets: gold-set-4.json (baseline) / gold-set-5.json (strict-MECE).

| Стратегия | R@5 | R@10 |
|-----------|-----|------|
| vectorRecall (naive baseline) | 0.524 | 0.668 |
| SumAcrossAxes (baseline prompt) | 0.369 | — |
| SumAcrossAxes (strict-MECE) | 0.241 | — |
| graphEnrichedRecall | исключён | edge.relevance несопоставим с cosine |

**Выводы:**
- strict-MECE СНИЖАЕТ recall vs мульти-осевого промпта. Избыточность мульти-осей помогает.
- Все per-axis проекции проигрывают naive vectorRecall на ~15pp.
- graphEnrichedRecall сломан архитектурно (соседи по графу заполняют top-K нерелевантным).
- Простой vectorRecall — сильный дешёвый baseline; per-axis подход не даёт прироста на этом датасете.

**Артефакты** (gitignored, в sandboxes/): benchmark-baseline.json, benchmark-strict-mece.json, gold-set-4.json, gold-set-5.json, review-synthesis.md.

## Active beads (top 3)

- [llmems-76f] [P3] redesign graphEnrichedRecall scoring (open)
- [llmems-a9r] [P2] security: POSTGRES_URL hardcoded default → fail-fast + rotate secret (open)
- [llmems-2le] [P2] fix: re-extract-projections.ts footgun — align embedding config (open)
- [llmems-wji] [P2] docs: benchmark pipeline runbook (open)

## Тесты

247/247 зелёных. `tsc --noEmit` чист.

## Принятые решения

| Решение | Суть |
|---------|------|
| vectorRecall = baseline | простейший cosine-поиск по embedding, без per-axis проекций |
| OpenRouter для embeddings | унифицированный провайдер для query + ingestion embeddings |
| gold-set freeze | gold-set генерируется один раз по session_date gate, затем фиксируется |
| PROMPT / MEMSTORE_ID через env | fail-fast, без магических дефолтов в бенчмарке |

## Связанные источники

- **beads:** `.beads/issues.jsonl` — atomic actions (см. `bd list`)
- **README:** `../README.md` — обзор для людей
- **CLAUDE.md:** `../CLAUDE.md` — инструкции для агента
