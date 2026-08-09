// BUILD.md Phase 9: "k6 scenarios: ... listing detail ..."
// ARCHITECTURE.md §12 target: GET /api/listings/:id p95 < 80ms.
// VU count isn't specified by BUILD.md for this scenario (only feed=100VU
// and reserve=50VU/10 listings are) — 50 VUs is a reasonable "browsing
// detail pages" load, well under the feed scenario's.
//
// Run: k6 run k6/scenarios/listingDetail.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, randomListingIdForDetail, randomToken } from '../lib/config.js';

export const options = {
  vus: 50,
  duration: '40s',
  thresholds: {
    http_req_duration: ['p(95)<80'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const token = randomToken();
  const listingId = randomListingIdForDetail();

  const res = http.get(`${BASE_URL}/api/listings/${listingId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });

  sleep(0.3 + Math.random() * 0.7);
}
