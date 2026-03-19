# LLMems — Next Steps

## Текущее состояние
- Код памяти перенесён на GitHub: https://github.com/alexmakeev/llmems
- 30 файлов, 139 тестов (зелёные)
- Публичный репо, open source

## Следующая задача: оформить как npm-пакет

### 1. Package.json
- `name`: `@alexmakeev/llmems` или `llmems`
- `version`: `0.1.0`
- `description`: "Long-term memory for LLM agents — Zettelkasten-style atomic summarization with PostgreSQL"
- `main` / `exports` — правильные entry points для ESM/CJS
- `types` — TypeScript declarations
- `license`: MIT
- `repository`, `keywords`, `author`

### 2. Build pipeline
- TypeScript → JavaScript compilation (`tsc`)
- Генерация `.d.ts` type declarations
- `dist/` для скомпилированного кода
- `npm run build` скрипт

### 3. GitHub Actions CI
- На каждый PR: lint + tests
- На tag (v*): build + publish to npm (или GitHub Packages)
- Badge в README: tests passing

### 4. README.md (open source quality)
- Что это: long-term memory для LLM-агентов
- Как работает: chunks → background summarization → atomic mems (Zettelkasten)
- Quick start: `npm install llmems` + 10 строк кода
- Architecture diagram (ASCII)
- API reference: OpenRouterChat, MemManager, PostgresMemStore
- Benchmarks: Alena case (7 mems from 135 chunks), topic43 (40 mems from 93 chunks)
- Supported models: Gemini, any OpenAI-compatible
- Storage: PostgreSQL + pgvector

### 5. Exports structure
```
llmems/
  ├── OpenRouterChat     — main class (LLM + memory + summarization)
  ├── MemManager         — chunk/mem orchestration
  ├── PostgresMemStore   — PostgreSQL storage backend
  ├── ChatManager        — multi-context management
  └── types              — IMemStore, ChatResponse, etc.
```

### 6. Примеры использования
- `examples/basic.ts` — минимальный пример
- `examples/telegram-bot.ts` — как подключить к Telegram боту
- `examples/custom-store.ts` — свой storage backend

### 7. После публикации npm
- Altme-bot подключает llmems через `npm install`
- Оркестратор подключает llmems через `npm install`
- Старый монолит (`~/llmems/`) можно удалить

## Контекст для агента

- Рабочая директория: `~/llmems-new/main/`
- GitHub remote: `git@github.com:alexmakeev/llmems.git`
- Старый код (для справки): `~/llmems-old/main/`
- Бот работает из: `~/llmems/main/` (Dokploy деплоит оттуда, НЕ ТРОГАТЬ)
- PostgreSQL: `postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems`
- Тесты: `npx vitest run` (139 тестов, все зелёные)

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/openrouter-chat.ts` | Ядро: LLM + память + Zettelkasten суммаризация |
| `src/services/mem-manager.ts` | Оркестрация chunks → mems |
| `src/services/postgres-mem-store.ts` | PostgreSQL storage |
| `src/services/chat-manager.ts` | Multi-context (разные чаты) |
| `src/types.ts` | Интерфейсы IMemStore и др. |

Дата: март 2026
