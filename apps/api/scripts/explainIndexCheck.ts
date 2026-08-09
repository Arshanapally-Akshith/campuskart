/**
 * BUILD.md Phase 9: "Measure with indexes dropped, then restored. Save
 * explain() output showing COLLSCAN → IXSCAN with totalDocsExamined for
 * both." ARCHITECTURE.md §12: the `{status, createdAt, _id}` compound
 * index is the specific one this deliverable is about — it backs both the
 * plain browse feed (ARCHITECTURE.md §6) and cursor pagination's sort.
 *
 * Turned up a more interesting result than a scripted demo: this
 * collection also has a `{status, category, priceInPaise, createdAt}`
 * index (the "filtered browse" index — models/Listing.ts) that shares the
 * `status` prefix. Drop *only* the primary index and the planner doesn't
 * fall back to COLLSCAN — it silently picks that other index instead,
 * scans every ACTIVE document through it anyway (it can't serve the sort),
 * and pays for an in-memory SORT stage on top. Same real cost as a
 * collection scan, different label. So this script reports three plans,
 * not two:
 *   1. baseline        — the real index present
 *   2. index dropped    — what actually happens (still "IXSCAN", full scan)
 *   3. forced COLLSCAN  — `.hint({ $natural: 1 })` while the index is still
 *                         dropped, for the textbook comparison
 * — all wrapped in try/finally so a mid-run failure still leaves the real
 * index restored.
 *
 * Usage: pnpm --filter @campuskart/api run perf:explain
 */
import mongoose from 'mongoose';
import { connectMongo } from '../src/lib/mongo.js';
import { Listing } from '../src/models/Listing.js';

const INDEX_SPEC = { status: 1, createdAt: -1, _id: -1 } as const;
const INDEX_NAME = 'status_1_createdAt_-1__id_-1';

interface WinningPlanStage {
  stage: string;
  inputStage?: WinningPlanStage;
}

interface ExecutionStatsShape {
  nReturned: number;
  executionTimeMillis: number;
  totalKeysExamined: number;
  totalDocsExamined: number;
}

interface ExplainOutput {
  queryPlanner: { winningPlan: WinningPlanStage };
  executionStats: ExecutionStatsShape;
}

interface ExplainSummary {
  stageChain: string;
  totalDocsExamined: number;
  totalKeysExamined: number;
  nReturned: number;
  executionTimeMillis: number;
}

function stageChain(plan: WinningPlanStage): string {
  const stages: string[] = [];
  let node: WinningPlanStage | undefined = plan;
  while (node) {
    stages.push(node.stage);
    node = node.inputStage;
  }
  return stages.join(' -> ');
}

async function runExplain(useNaturalHint = false): Promise<ExplainSummary> {
  let query = Listing.find({ status: 'ACTIVE' }).sort({ createdAt: -1, _id: -1 }).limit(21);
  if (useNaturalHint) {
    query = query.hint({ $natural: 1 });
  }
  const raw = (await query.explain('executionStats')) as unknown as ExplainOutput;

  return {
    stageChain: stageChain(raw.queryPlanner.winningPlan),
    totalDocsExamined: raw.executionStats.totalDocsExamined,
    totalKeysExamined: raw.executionStats.totalKeysExamined,
    nReturned: raw.executionStats.nReturned,
    executionTimeMillis: raw.executionStats.executionTimeMillis,
  };
}

function printRow(label: string, s: ExplainSummary): void {
  console.log(
    `${label.padEnd(34)} plan=${s.stageChain.padEnd(28)} totalDocsExamined=${String(s.totalDocsExamined).padStart(8)} ` +
      `totalKeysExamined=${String(s.totalKeysExamined).padStart(8)} nReturned=${String(s.nReturned).padStart(4)} ` +
      `executionTimeMillis=${String(s.executionTimeMillis)}`,
  );
}

async function main(): Promise<void> {
  await connectMongo();
  const collection = Listing.collection;

  const countActive = await Listing.countDocuments({ status: 'ACTIVE' });
  console.log(`Query: Listing.find({status:'ACTIVE'}).sort({createdAt:-1,_id:-1}).limit(21)`);
  console.log(`ACTIVE listings in collection: ${String(countActive)}\n`);

  console.log('--- 1. baseline (primary index present) ---');
  const before = await runExplain();
  printRow('with index', before);

  console.log('\n--- dropping index ---');
  await collection.dropIndex(INDEX_NAME);
  console.log(`Dropped index ${INDEX_NAME}`);

  try {
    console.log('\n--- 2. index dropped (planner picks a different index) ---');
    const dropped = await runExplain();
    printRow('index dropped (fallback plan)', dropped);

    console.log('\n--- 3. index dropped, forced COLLSCAN via $natural hint ---');
    const forcedCollscan = await runExplain(true);
    printRow('forced COLLSCAN', forcedCollscan);

    console.log('\n=== SUMMARY (paste into docs/PERFORMANCE.md) ===');
    printRow('WITH index', before);
    printRow('WITHOUT index (fallback plan)', dropped);
    printRow('WITHOUT index (forced COLLSCAN)', forcedCollscan);
  } finally {
    console.log('\n--- restoring index ---');
    await collection.createIndex(INDEX_SPEC, { name: INDEX_NAME });
    console.log(`Restored index ${INDEX_NAME}`);

    console.log('\n--- post-restore verification ---');
    const restored = await runExplain();
    printRow('restored', restored);
    if (!restored.stageChain.includes('IXSCAN') || restored.totalDocsExamined > 21) {
      console.error(
        'WARNING: index restore did not produce the expected tight IXSCAN plan — check manually.',
      );
      process.exitCode = 1;
    }
  }

  await mongoose.disconnect();
}

main().catch((err: unknown) => {
  console.error('explainIndexCheck failed:', err);
  process.exit(1);
});
