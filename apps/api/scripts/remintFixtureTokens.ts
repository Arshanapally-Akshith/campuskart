/**
 * Operational helper, not a Phase 9 deliverable in itself: access tokens
 * are 15 minutes (apps/api/src/lib/jwt.ts, ACCESS_TOKEN_TTL) — real and
 * correct for the app, but a k6/fixtures.json minted once by
 * scripts/loadSeed.ts goes stale partway through a multi-scenario
 * load-testing session that runs longer than 15 minutes. Re-signs every
 * fixture token with the same `sub`/`email` (decoded from the existing
 * token, not re-queried from Mongo — no DB connection needed) and a fresh
 * expiry, in place. Run this immediately before each k6 scenario.
 *
 * Usage: pnpm --filter @campuskart/api run perf:remint
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { signAccessToken, type AccessTokenPayload } from '../src/lib/jwt.js';

interface Fixtures {
  generatedAt: string;
  userTokens: string[];
  chatConversations: { conversationId: string; tokenA: string; tokenB: string }[];
  [key: string]: unknown;
}

function remint(oldToken: string): string {
  const decoded = jwt.decode(oldToken) as AccessTokenPayload | null;
  if (!decoded) {
    throw new Error('Could not decode an existing fixture token to re-mint it.');
  }
  return signAccessToken({ sub: decoded.sub, email: decoded.email });
}

function main(): void {
  const path = fileURLToPath(new URL('../../../k6/fixtures.json', import.meta.url));
  const fixtures = JSON.parse(readFileSync(path, 'utf8')) as Fixtures;

  fixtures.userTokens = fixtures.userTokens.map(remint);
  fixtures.chatConversations = fixtures.chatConversations.map((c) => ({
    conversationId: c.conversationId,
    tokenA: remint(c.tokenA),
    tokenB: remint(c.tokenB),
  }));
  fixtures.generatedAt = new Date().toISOString();

  writeFileSync(path, JSON.stringify(fixtures, null, 2));
  console.log(
    `Re-minted ${String(fixtures.userTokens.length)} user tokens and ` +
      `${String(fixtures.chatConversations.length)} chat conversation token pairs (fresh 15-minute expiry).`,
  );
}

main();
