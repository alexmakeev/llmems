# LLMems — Long-term memory for LLM agents

Persistent memory system for LLM-based agents with PostgreSQL + pgvector storage, semantic search, and automatic memory lifecycle management.

## Features

- Automatic memory extraction from conversations
- Semantic search via pgvector embeddings
- Memory importance scoring and decay
- Temporal awareness (chrono-node)
- OpenRouter LLM integration
- Concurrency-safe with semaphore locking

## Setup

```bash
npm install
```

## Configuration

Requires environment variables:
- `DATABASE_URL` — PostgreSQL connection string (with pgvector extension)
- `OPENROUTER_API_KEY` — OpenRouter API key

## Tests

```bash
npm test
```
