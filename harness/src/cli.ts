/**
 * Harness CLI — thin shell wiring REAL collaborators (plan v2, D9/D11).
 * All logic lives in the tested modules; this file only assembles them.
 *
 * Usage (on the AM32 host, see harness/README.md):
 *   npx tsx src/cli.ts seed   [--env-file ~/llmems-stand/.env]
 *   npx tsx src/cli.ts recall [--env-file ~/llmems-stand/.env]
 *
 * seed:   fresh run scope → fixture turns → wait for mems (D16) → write state file
 * recall: read state file → probe turn → planted-fact assert (exit 1 on fail)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ContextFactory,
  PostgresMemStore,
  MemManager,
  BackgroundIndexer,
  LLMSummarizer,
} from '@alexmakeev/llmems';
import { EmbeddingAdapter } from './embedding-adapter.js';
import { HarnessLogger } from './logger.js';
import { parseEnvFile, loadHarnessConfig, type HarnessConfig } from './env.js';
import { makeRunScope } from './run-scope.js';
import { buildFixture } from './fixture.js';
import { runSeed, type RunState } from './seed.js';
import { runRecall } from './recall.js';

const DEFAULT_ENV_FILE = join(homedir(), 'llmems-stand', '.env');

function parseArgs(argv: string[]): { command: string; envFile: string } {
  const [command] = argv;
  if (command !== 'seed' && command !== 'recall') {
    throw new Error(`Usage: cli.ts <seed|recall> [--env-file <path>] — got "${command ?? ''}"`);
  }
  const flagIdx = argv.indexOf('--env-file');
  const envFile = flagIdx !== -1 ? argv[flagIdx + 1] : DEFAULT_ENV_FILE;
  if (!envFile) throw new Error('--env-file requires a path argument');
  return { command, envFile };
}

function buildCollaborators(config: HarnessConfig) {
  const store = new PostgresMemStore(config.postgresUrl);
  const embedding = new EmbeddingAdapter({
    baseUrl: config.litellmBaseUrl,
    apiKey: config.litellmApiKey,
    model: config.embeddingsModel,
  });
  const summarizer = new LLMSummarizer({
    baseURL: `${config.litellmBaseUrl.replace(/\/$/, '')}/v1`,
    model: config.summarizerModel,
    apiKey: config.litellmApiKey,
  });
  const indexer = new BackgroundIndexer(new MemManager(store), embedding, summarizer);
  const factory = new ContextFactory(store, embedding, indexer, {
    markerText: config.markerText,
    ...(config.indexThreshold !== undefined ? { indexThreshold: config.indexThreshold } : {}),
  });
  return { store, factory };
}

async function main(): Promise<number> {
  const { command, envFile } = parseArgs(process.argv.slice(2));
  const env = parseEnvFile(await readFile(envFile, 'utf8'));
  const config = loadHarnessConfig(env);
  const stateFile = env['LLMEMS_RUN_STATE_FILE'] ?? join(dirname(envFile), 'last-run.json');
  const logger = new HarnessLogger();
  const { store, factory } = buildCollaborators(config);

  try {
    if (command === 'seed') {
      const scope = makeRunScope();
      const state = await runSeed({
        factory, store, logger, scope,
        fixture: buildFixture(scope.nonce),
        config,
        writeState: (s: RunState) => writeFile(stateFile, `${JSON.stringify(s, null, 2)}\n`, 'utf8'),
      });
      process.stdout.write(`SEED OK ${JSON.stringify(state)}\n`);
      return 0;
    }

    // recall
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as RunState;
    const report = await runRecall({ factory, logger, state, config });
    process.stdout.write(
      `RECALL ${report.pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ ...report, context: undefined })}\n`,
    );
    process.stdout.write(`--- recalled context (full, for human review) ---\n${report.context}\n`);
    return report.pass ? 0 : 1;
  } finally {
    await store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`HARNESS FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
