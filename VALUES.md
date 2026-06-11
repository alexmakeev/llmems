# Project Values

> Project-level values discovered through interaction with this codebase. Loaded into context via `@VALUES.md` in project CLAUDE.md.
>
> Each value answers: "When this trigger appears, prefer THIS user choice over THAT default agent suggestion, because REASON."
>
> Values are accumulated manually via `/value` skill OR auto-promoted from FAQ.jsonl (Phase 2). Never edited directly — use `/value` to ensure consistent format and timestamp.

## Format

Each value follows this structure:

### When [trigger condition]
**Prefer:** [user choice]
**Over:** [agent default suggestion]
**Because:** [reason]
**Evidence:** [link to FAQ entry id or session date]
**Recorded:** YYYY-MM-DD

---

## Values

### When describing llmems work in any of our artifacts (docs, plans, beads)
**Prefer:** нейтральные инфра-термины («общий dev-прокси (AM32)», «compose-стек общего прокси», «платформа-применение»)
**Over:** привязка продукта к именам применений (One Liner и т.п.)
**Because:** llmems — самостоятельный продукт; правило про именование, не про инфраструктуру (переиспользование чужого прокси — нормально); операционные адреса (имена контейнеров/репо/путей) остаются точными там, где нужны для исполнения — адрес ≠ аффилиация
**Evidence:** Session 2026-06-11, owner correction after CEO over-interpretation
**Recorded:** 2026-06-11
