/**
 * BUILD.md Phase 9: "k6 scenarios: ... chat throughput."
 *
 * Deviation, documented here and in docs/PERFORMANCE.md: chat delivery in
 * this app is Socket.IO (ARCHITECTURE.md §5), not plain HTTP, and k6 has no
 * built-in Socket.IO client — only raw WebSockets. Real Socket.IO support
 * needs the xk6-socketio extension, which means building a custom k6
 * binary with the Go toolchain; no Go toolchain is available in this
 * environment. Rather than fake it with a bare-WebSocket script that
 * wouldn't actually speak the Socket.IO/Engine.IO protocol the real app
 * uses, this measures the same thing (concurrent conversations sending
 * messages, round-trip latency, p50/p95/p99) with `socket.io-client`
 * directly — the same client the frontend and the Phase 6 test suite use.
 *
 * Usage: pnpm --filter @campuskart/api run perf:chat
 * Env: CHAT_DURATION_MS (default 40000), CHAT_CONCURRENT_PAIRS (default 50),
 *      CHAT_SEND_INTERVAL_MS (default 300)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';

interface Fixtures {
  apiUrl: string;
  chatConversations: { conversationId: string; tokenA: string; tokenB: string }[];
}

interface SendAck {
  ok: boolean;
  seq?: number;
  code?: string;
}

const DURATION_MS = Number(process.env['CHAT_DURATION_MS'] ?? 40_000);
const CONCURRENT_PAIRS = Number(process.env['CHAT_CONCURRENT_PAIRS'] ?? 50);
const SEND_INTERVAL_MS = Number(process.env['CHAT_SEND_INTERVAL_MS'] ?? 300);

function loadFixtures(): Fixtures {
  const path = fileURLToPath(new URL('../../../k6/fixtures.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Fixtures;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

interface RunResult {
  latenciesMs: number[];
  errors: number;
  sent: number;
}

async function runPair(
  apiUrl: string,
  conversationId: string,
  tokenA: string,
  tokenB: string,
  deadline: number,
): Promise<RunResult> {
  const [socketA, socketB] = await Promise.all([connect(apiUrl, tokenA), connect(apiUrl, tokenB)]);
  await Promise.all([
    socketA.emitWithAck('sync', { conversationId, lastSeq: 0 }),
    socketB.emitWithAck('sync', { conversationId, lastSeq: 0 }),
  ]);

  const latenciesMs: number[] = [];
  let errors = 0;
  let sent = 0;
  let turn = 0;

  while (Date.now() < deadline) {
    const sender = turn % 2 === 0 ? socketA : socketB;
    turn += 1;
    const start = Date.now();
    try {
      const ack = (await sender.timeout(5_000).emitWithAck('message:send', {
        conversationId,
        clientMsgId: randomUUID(),
        body: `load test message ${String(sent)}`,
      })) as SendAck;
      sent += 1;
      if (ack.ok) {
        latenciesMs.push(Date.now() - start);
      } else {
        errors += 1;
      }
    } catch {
      errors += 1;
    }
    await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }

  socketA.close();
  socketB.close();
  return { latenciesMs, errors, sent };
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  const pairs = fixtures.chatConversations.slice(0, CONCURRENT_PAIRS);
  console.log(
    `chatThroughput: ${String(pairs.length)} concurrent conversation pairs, ` +
      `${String(DURATION_MS / 1000)}s, one send every ${String(SEND_INTERVAL_MS)}ms per pair`,
  );

  const deadline = Date.now() + DURATION_MS;
  const results = await Promise.all(
    pairs.map((p) => runPair(fixtures.apiUrl, p.conversationId, p.tokenA, p.tokenB, deadline)),
  );

  const allLatencies = results.flatMap((r) => r.latenciesMs).sort((a, b) => a - b);
  const totalSent = results.reduce((sum, r) => sum + r.sent, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

  const summary = {
    concurrentPairs: pairs.length,
    durationMs: DURATION_MS,
    totalMessagesSent: totalSent,
    errors: totalErrors,
    errorRate: totalSent === 0 ? 0 : totalErrors / totalSent,
    throughputPerSec: totalSent / (DURATION_MS / 1000),
    latencyMs: {
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      min: allLatencies[0] ?? 0,
      max: allLatencies[allLatencies.length - 1] ?? 0,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('chatThroughput failed:', err);
  process.exit(1);
});
