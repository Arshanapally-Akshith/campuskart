// BUILD.md Phase 9: "k6 scenarios: ... reserve contention (50 VU on 10
// listings)." ARCHITECTURE.md §12 target: reserve p95 under 50 concurrent
// < 200ms. ARCHITECTURE.md §4 is the thing actually under test here: the
// atomic findOneAndUpdate guard, not "does reserve work" (reservations.
// concurrency.spec.ts already proves correctness — this measures latency
// and throughput under sustained load).
//
// Each VU has a stable identity (its own buyer token) for the whole run,
// so it can cancel a reservation it wins — that's what turns this into
// *sustained* contention across the full duration instead of the 10
// listings all being claimed once in the first second and then just
// 409ing for the rest of the run.
//
// Run: k6 run k6/scenarios/reserveContention.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, fixtures } from '../lib/config.js';

export const options = {
  vus: 50,
  duration: '40s',
  thresholds: {
    // Only the *winning* requests are the "reserve" ARCHITECTURE.md §12
    // means — a 409 is a correct, fast rejection, not a slow success — but
    // http_req_duration below covers every reserve attempt regardless of
    // outcome, since a slow 409 would also be a real problem.
    http_req_duration: ['p(95)<200'],
  },
};

const reserveDuration = new Trend('reserve_duration', true);
const reserveWonRate = new Rate('reserve_won_rate');

function tokenForThisVU() {
  const tokens = fixtures.userTokens;
  return tokens[__VU % tokens.length];
}

export default function () {
  const token = tokenForThisVU();
  const listingId =
    fixtures.reserveContentionListingIds[
      Math.floor(Math.random() * fixtures.reserveContentionListingIds.length)
    ];
  const headers = { Authorization: `Bearer ${token}` };

  const res = http.post(`${BASE_URL}/api/listings/${listingId}/reserve`, null, { headers });
  reserveDuration.add(res.timings.duration);

  const won = res.status === 200;
  reserveWonRate.add(won);
  check(res, {
    'reserve status is 200 (won) or 409 (lost, correctly)': (r) =>
      r.status === 200 || r.status === 409,
  });

  if (won) {
    // Release it immediately so the next contender has something to
    // actually contend over.
    http.post(`${BASE_URL}/api/listings/${listingId}/cancel`, null, { headers });
  }

  sleep(0.1 + Math.random() * 0.2);
}
