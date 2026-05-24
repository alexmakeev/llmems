# LLMems — Project Instructions

## Database Convention — Branch-per-DB

Each git branch gets its own PostgreSQL database to avoid conflicts with production data.

**Convention:**
- `main` branch → database `llmems` (production)
- Feature/experiment branches → database `llmems_{branch_name}` (sanitized: slashes → underscores)
- Example: branch `experiment/axis-projections` → database `llmems_axis_projections`

**Connection:**
- Host: localhost, Port: 5434, User: llmems
- Set `POSTGRES_URL` environment variable per branch
- Production: `postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems`
- Branch DB: `postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_{branch_name}`

**Creating a branch DB:**
1. `CREATE DATABASE llmems_{branch_name} OWNER llmems;`
2. Apply base schema (memstores, mems, mem_chunks, vocabulary, mem_vocabulary + indexes)
3. Apply any branch-specific migrations

**Schema reference:** `sandboxes/schema-dump-2026-04-02.sql` — full production schema dump

## Git Workflow

- Bare repo + worktrees: `~/llmems/` (bare), `~/llmems/main/` (main worktree)
- Branch naming: `experiment/{name}` for experiments, `feature/{name}` for features

## Tech Stack

- TypeScript, ESM-only, ultra-strict tsconfig
- PostgreSQL + pgvector (port 5434)
- Result pattern from `src/shared/result.ts` (NOT neverthrow)
- Tests: vitest

## Active Branches

| Branch | Database | Purpose |
|--------|----------|---------|
| `main` | `llmems` | Production |
| `experiment/axis-projections` | `llmems_axis_projections` | Projection-based knowledge graph |

## Notes

- Altme deploys from the separate `altme-bot.git` (gitea), NOT from any monolith. The old monolith gitea repo was archived as `altme-monolith-legacy` on 2026-05-23 and is dead.
