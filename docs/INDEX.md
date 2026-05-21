# llmems — State Recap (feature/context-factory)

Последнее обновление: 2026-05-21

---

## Где мы сейчас

Ветка `feature/context-factory`. Фаза 1 baseline реализована и покрыта тестами.

**Что реализовано:**
- `ContextFactory.remember()` — сохранение фрагмента в rawTail, EMA-сдвиг вектора фокуса, ANN-поиск по фокусу, dedup-фильтр (уже загруженные + raw-present чанки), мягкая перестройка по порогу.
- `ContextFactory.getCurrentContext()` — чистая проекция: слоёнка (стабильный prefix → маркер + динамический блок → сырьевой хвост), без обращений к БД.
- Recalled-memory marker (`"Loaded from memory:"`, конфигурируемый).
- Raw/mem dedup при загрузке (исключение уже загруженных + мемов с активными исходными чанками).
- Мягкая перестройка (`softRebuild`): отбор по cosine-sim к фокусу, хронологическая сортировка выживших.
- Эмбеддинги: `openai/text-embedding-3-small` @ 1536 dim, single-resolution, через OpenRouter.
- Тесты: 150/150 green.
- Архитектурный ревью завершён: 0 critical, все FIX1–5 применены.

---

## Что дальше

**Ближайший шаг: замер baseline-метрики (vp3.5).**
Методика описана в `docs/baseline-metric.md`. После замера — выход на фазу 2 (llmems-xcz: структура + граф досборка).

Фаза 2 gated на baseline: строим структуру только после того, как есть измерение точки отсчёта.

---

## Активные биды

| ID | Описание | Статус |
|----|----------|--------|
| vp3 | Epic: context-factory фаза 1 | open (baseline pending) |
| vp3.1 | SessionWorkingState + ContextFactory скелет | done |
| vp3.3 | remember(): EMA-сдвиг + dedup загрузки | done |
| vp3.4 | getCurrentContext(): слоёнка-сериализатор | done |
| vp3.5 | Замер baseline-метрики | **open — следующий** |
| vp3.6 | Raw/mem dedup при загрузке | done |
| vp3.7 | Recalled-memory marker | done |

**Отложенные биды:**
- `drc` — rawTail drain (полный жизненный цикл сырьевого хвоста)
- `e08` — session lifecycle (TTL, очистка, персистентность пер-сессионного состояния)
- `mai` — граничные тесты (edge cases)
- `fqx` — переименование `EmbeddingValue.compact` → `vector`
- `dnh` — gold-set для baseline
- `jvu` — schema-init в репо
- `zij` — переключение эмбеддингов (исследование альтернатив)

---

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/services/context-factory.ts` | Основная реализация ContextFactory |
| `src/services/postgres-mem-store.ts` | PostgreSQL-реализация IVectorMemStore |
| `src/types.ts` | Доменные типы (Mem, EmbeddingValue, IVectorMemStore, …) |
| `docs/vision.md` | Архитектурное видение (north-star) |
| `docs/baseline-metric.md` | Методика замера baseline-метрики |
| `sandboxes/schema-native.sql` | DDL схемы БД (pgvector HNSW) |
