/** BUILD.md Phase 9: "Measure feed cache hit rate on/off." Reads the
 * counters lib/feedCache.ts increments on every GET /api/listings call.
 *
 * Usage:
 *   pnpm run perf:cache-stats            print current hits/misses/rate
 *   pnpm run perf:cache-stats -- --reset zero the counters, then print
 */
import { getFeedCacheStats, resetFeedCacheStats } from '../src/lib/feedCache.js';
import { redis } from '../src/lib/redis.js';

async function main(): Promise<void> {
  if (process.argv.includes('--reset')) {
    await resetFeedCacheStats();
    console.log('Feed cache hit/miss counters reset.');
  }

  const stats = await getFeedCacheStats();
  console.log(JSON.stringify(stats, null, 2));
  console.log(`hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

  redis.disconnect();
}

main().catch((err: unknown) => {
  console.error('cacheStats failed:', err);
  process.exit(1);
});
