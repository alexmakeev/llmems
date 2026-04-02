# Bug Report: Missing Database Migration for Vocabulary Tables

**Date:** 2026-03-22
**Severity:** High

---

## Issue: Library 0.3.0 adds vocabulary tables but provides no migration mechanism

### Actual behavior

Version 0.3.0 introduced vocabulary storage (tables `vocabulary` and `mem_vocabulary`). However:

1. There is no auto-migration or `ensureSchema()` method that creates these tables on initialization
2. There is no migration SQL file shipped with the package
3. The CHANGELOG mentions the vocabulary feature but does not mention the required database schema changes
4. The README schema documentation is outdated and does not match the actual table structure used in code

When a host application upgrades from 0.2.x to 0.3.0 without manually creating the new tables, every call to `buildTopicContext()` fails with PostgreSQL error `42P01: relation "vocabulary" does not exist`.

The error is caught internally and falls back silently, so the bot appears functional. In reality:

- Topic context building operates in degraded fallback mode
- Vocabulary is never populated
- Background summarization vocabulary extraction silently fails on every message

The host application developer is required to manually reverse-engineer the schema from INSERT queries in the library source code in order to apply the migration.

### Expected behavior

One of the following must be true after upgrading to 0.3.0:

**(A) Auto-migration** — The library creates missing tables automatically on startup, for example via an `ensureSchema()` or `initDb()` method called during `PostgresMemStore` initialization. The library already knows the exact schema it needs, so this is the natural place to ensure tables exist.

**(B) Shipped migration SQL** — The package includes versioned migration files (e.g., `migrations/0.3.0-vocabulary.sql`) that the host application can run as part of its deployment pipeline.

**(C) At minimum, documented schema** — The CHANGELOG entry for 0.3.0 and the README both include the exact `CREATE TABLE` statements required, so developers are not left reverse-engineering from source.

Option A (auto-migration) is strongly preferred. Silent schema failures violate the principle that a library should not corrupt application behavior after a version upgrade without any diagnostic output.

### Impact

- Every message triggers an internal error on databases without vocabulary tables
- Topic context quality is permanently degraded for all affected users until manual intervention
- The failure is invisible to the host application — no exception surfaces, no log warning is emitted at a level visible outside the library
- Developers upgrading from 0.2.x have no indication from documentation, CHANGELOG, or runtime behavior that a manual migration step is required

### Actual schema required (reverse-engineered from source)

```sql
CREATE TABLE IF NOT EXISTS vocabulary (
    id SERIAL PRIMARY KEY,
    memstore_id INTEGER NOT NULL REFERENCES memstores(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS vocabulary_memstore_term_lower_idx
    ON vocabulary (memstore_id, LOWER(term));

CREATE TABLE IF NOT EXISTS mem_vocabulary (
    mem_id INTEGER NOT NULL REFERENCES mems(id) ON DELETE CASCADE,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    count_in_mem INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (mem_id, vocabulary_id)
);
```

### Workaround applied

Manual `CREATE TABLE` statements executed via `docker exec` directly on the production database. This is not a sustainable upgrade path.

### Recommendation

Implement Option A: add `ensureSchema()` logic inside `PostgresMemStore` that runs the `CREATE TABLE IF NOT EXISTS` statements above on initialization. This is a non-destructive operation — existing tables are left untouched. It eliminates the upgrade gap entirely without requiring any action from the host application.
