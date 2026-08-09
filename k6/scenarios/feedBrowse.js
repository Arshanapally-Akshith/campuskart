// BUILD.md Phase 9: "k6 scenarios: feed browse (100 VU)."
// ARCHITECTURE.md §12 target: GET /api/listings p95 < 150ms.
//
// Run: k6 run k6/scenarios/feedBrowse.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL, randomToken } from '../lib/config.js';

export const options = {
  vus: 100,
  duration: '40s',
  thresholds: {
    // Informational, not enforced (default k6 behaviour): a threshold
    // failure is reported in the summary, the run still completes, which
    // is exactly what a before/after comparison needs.
    http_req_duration: ['p(95)<150'],
    http_req_failed: ['rate<0.01'],
  },
};

const page1Duration = new Trend('feed_page1_duration', true);
const page2Duration = new Trend('feed_page2_duration', true);

export default function () {
  const token = randomToken();
  const params = { headers: { Authorization: `Bearer ${token}` }, tags: { page: 'p1' } };

  const res1 = http.get(`${BASE_URL}/api/listings`, params);
  check(res1, { 'page1 status 200': (r) => r.status === 200 });
  page1Duration.add(res1.timings.duration);

  // 20% of iterations also scroll to page 2 — the second cacheable page
  // (ARCHITECTURE.md §6) — so the cache-hit-rate measurement exercises
  // both cacheable slots, not just page 1.
  if (Math.random() < 0.2 && res1.status === 200) {
    const body = res1.json();
    if (body && body.hasMore && body.nextCursor) {
      const res2 = http.get(
        `${BASE_URL}/api/listings?cursor=${encodeURIComponent(body.nextCursor)}`,
        { headers: { Authorization: `Bearer ${token}` }, tags: { page: 'p2' } },
      );
      check(res2, { 'page2 status 200': (r) => r.status === 200 });
      page2Duration.add(res2.timings.duration);
    }
  }

  sleep(0.5 + Math.random());
}
