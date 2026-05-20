// scripts/compare-benchmarks.ts
// CLI wrapper: loads two benchmark JSON files and prints a comparison table.
//
// Usage:
//   npx tsx scripts/compare-benchmarks.ts <baseline.json> <variant.json>
//
// Output:
//   Aligned table to stdout: strategy × metric × K with baseline | variant | Δ columns.
//   Best strategy per metric (recall@5, recall@10, precision@5, precision@10) highlighted.
//   Optionally writes sandboxes/benchmark-compare.json.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  compareBenchmarks,
} from '../src/services/graph/compare-benchmarks.js';
import type { BenchmarkFile, StrategyComparison } from '../src/services/graph/compare-benchmarks.js';

// ── CLI arg validation ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npx tsx scripts/compare-benchmarks.ts <baseline.json> <variant.json>');
  process.exit(1);
}

const [baselinePath, variantPath] = args as [string, string];

function loadBenchmark(filePath: string, label: string): BenchmarkFile {
  const resolved = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot read ${label} file at ${resolved}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot parse ${label} file at ${resolved} as JSON: ${message}`);
  }

  // Schema validation: must have strategyAggregates array and metadata object
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('strategyAggregates' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>)['strategyAggregates']) ||
    !('metadata' in parsed) ||
    typeof (parsed as Record<string, unknown>)['metadata'] !== 'object'
  ) {
    throw new Error(
      `${label} file at ${resolved} does not match expected BenchmarkOutput schema: ` +
      `missing or invalid "strategyAggregates" array or "metadata" object.`,
    );
  }

  return parsed as BenchmarkFile;
}

// ── Load files ─────────────────────────────────────────────────────────────────

const baseline = loadBenchmark(baselinePath, 'baseline');
const variant = loadBenchmark(variantPath, 'variant');

// ── Run comparison ─────────────────────────────────────────────────────────────

const rows = compareBenchmarks(baseline, variant);

// ── Report metadata header ─────────────────────────────────────────────────────

const bm = baseline.metadata;
const vm = variant.metadata;

console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('║  BENCHMARK COMPARISON                                                      ║');
console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

console.log('── Baseline ──────────────────────────────────────────────────────────────────');
console.log(`  File:          ${baselinePath}`);
console.log(`  Test name:     ${bm.testName}`);
console.log(`  Memstore:      ${bm.memstoreId}`);
console.log(`  Run at:        ${bm.runAt}`);
console.log(`  Questions:     ${bm.questionsTotal} total, ${bm.questionsSucceeded} succeeded`);

console.log('\n── Variant ───────────────────────────────────────────────────────────────────');
console.log(`  File:          ${variantPath}`);
console.log(`  Test name:     ${vm.testName}`);
console.log(`  Memstore:      ${vm.memstoreId}`);
console.log(`  Run at:        ${vm.runAt}`);
console.log(`  Questions:     ${vm.questionsTotal} total, ${vm.questionsSucceeded} succeeded`);

// Warn if question counts differ
if (bm.questionsTotal !== vm.questionsTotal || bm.questionsSucceeded !== vm.questionsSucceeded) {
  console.log('\n  NOTE: Question counts differ between baseline and variant.');
  console.log(`    Baseline: ${bm.questionsTotal} total, ${bm.questionsSucceeded} succeeded`);
  console.log(`    Variant:  ${vm.questionsTotal} total, ${vm.questionsSucceeded} succeeded`);
  console.log('    Metric deltas may not be directly comparable.');
}

// ── Mismatch warnings ──────────────────────────────────────────────────────────

const mismatches = rows.filter(r => r.mismatch !== undefined);
if (mismatches.length > 0) {
  const missingInVariant = [...new Set(
    mismatches.filter(r => r.mismatch === 'missing-in-variant').map(r => r.strategy),
  )];
  const missingInBaseline = [...new Set(
    mismatches.filter(r => r.mismatch === 'missing-in-baseline').map(r => r.strategy),
  )];

  console.log('\n── Strategy Mismatches ───────────────────────────────────────────────────────');
  if (missingInVariant.length > 0) {
    console.log(`  Present in baseline but MISSING in variant: ${missingInVariant.join(', ')}`);
  }
  if (missingInBaseline.length > 0) {
    console.log(`  Present in variant but MISSING in baseline: ${missingInBaseline.join(', ')}`);
  }
  console.log('  (Rows for mismatched strategies are shown with [MISMATCH] marker.)');
}

// ── Find best strategy per metric (K=5 and K=10) ─────────────────────────────

type MetricKey = 'recall5' | 'recall10' | 'precision5' | 'precision10';

function findBestStrategy(
  allRows: StrategyComparison[],
  side: 'baseline' | 'variant',
  metric: MetricKey,
): string {
  const paired = allRows.filter(r => r.mismatch === undefined);
  if (paired.length === 0) return '';

  let best = '';
  let bestVal = -Infinity;

  for (const row of paired) {
    let val: number;
    if (metric === 'recall5' && row.K === 5) val = row.recall[side];
    else if (metric === 'recall10' && row.K === 10) val = row.recall[side];
    else if (metric === 'precision5' && row.K === 5) val = row.precision[side];
    else if (metric === 'precision10' && row.K === 10) val = row.precision[side];
    else continue;

    if (val > bestVal) {
      bestVal = val;
      best = row.strategy;
    }
  }
  return best;
}

// Best strategy per metric based on variant (the "new" run)
const bestVariantByMetric: Record<MetricKey, string> = {
  recall5: findBestStrategy(rows, 'variant', 'recall5'),
  recall10: findBestStrategy(rows, 'variant', 'recall10'),
  precision5: findBestStrategy(rows, 'variant', 'precision5'),
  precision10: findBestStrategy(rows, 'variant', 'precision10'),
};

// ── Print comparison table ─────────────────────────────────────────────────────

const STRATEGY_COL = 26;
const NUM_COL = 8;
const SIGN_COL = 10;

function pct(val: number): string {
  return (val * 100).toFixed(1).padStart(NUM_COL - 1) + '%';
}

function delta(val: number): string {
  const sign = val >= 0 ? '+' : '';
  return (sign + (val * 100).toFixed(1) + '%').padStart(SIGN_COL);
}

function isBest(strategy: string, k: number, metric: 'recall' | 'precision'): boolean {
  if (k === 5) {
    return metric === 'recall'
      ? bestVariantByMetric['recall5'] === strategy
      : bestVariantByMetric['precision5'] === strategy;
  }
  return metric === 'recall'
    ? bestVariantByMetric['recall10'] === strategy
    : bestVariantByMetric['precision10'] === strategy;
}

function printTable(
  title: string,
  kFilter: 5 | 10,
  metric: 'recall' | 'precision',
): void {
  console.log(`\n── ${title} ──────────────────────────────────────────────────────────────────`);
  console.log(
    '  ' +
    'Strategy'.padEnd(STRATEGY_COL) +
    'Baseline'.padStart(NUM_COL) +
    'Variant'.padStart(NUM_COL) +
    'Δ (variant-baseline)'.padStart(SIGN_COL + 2) +
    '  Excl(base/var)',
  );
  console.log('  ' + '─'.repeat(STRATEGY_COL + NUM_COL + NUM_COL + SIGN_COL + 18));

  const tableRows = rows.filter(r => r.K === kFilter);
  for (const row of tableRows) {
    const baseVal = metric === 'recall' ? row.recall.baseline : row.precision.baseline;
    const varVal = metric === 'recall' ? row.recall.variant : row.precision.variant;
    const d = metric === 'recall' ? row.recall.delta : row.precision.delta;

    const best = row.mismatch === undefined && isBest(row.strategy, kFilter, metric);
    const label = best ? ' ★' : '  ';
    const mismatchNote = row.mismatch !== undefined ? ` [${row.mismatch}]` : '';

    console.log(
      label +
      row.strategy.padEnd(STRATEGY_COL) +
      pct(baseVal) +
      pct(varVal) +
      delta(d) +
      `  ${row.excludedQuestions.baseline}/${row.excludedQuestions.variant}` +
      mismatchNote,
    );
  }
}

printTable('Recall@5', 5, 'recall');
printTable('Recall@10', 10, 'recall');
printTable('Precision@5', 5, 'precision');
printTable('Precision@10', 10, 'precision');

console.log('\n  ★ = best strategy in variant run for that metric\n');

// ── Write JSON output ──────────────────────────────────────────────────────────

const compareOutputPath = 'sandboxes/benchmark-compare.json';
mkdirSync('sandboxes', { recursive: true });
const jsonOutput = {
  generatedAt: new Date().toISOString(),
  baselineFile: baselinePath,
  variantFile: variantPath,
  baselineTestName: bm.testName,
  variantTestName: vm.testName,
  questionCountMismatch:
    bm.questionsTotal !== vm.questionsTotal || bm.questionsSucceeded !== vm.questionsSucceeded,
  strategyMismatches: {
    missingInVariant: [...new Set(
      rows.filter(r => r.mismatch === 'missing-in-variant').map(r => r.strategy),
    )],
    missingInBaseline: [...new Set(
      rows.filter(r => r.mismatch === 'missing-in-baseline').map(r => r.strategy),
    )],
  },
  bestVariantStrategy: bestVariantByMetric,
  comparisons: rows,
};

writeFileSync(compareOutputPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
console.log(`Comparison saved to: ${compareOutputPath}\n`);
