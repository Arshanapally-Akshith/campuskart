// Shared by every scenario script. `open()` only works at init time and
// resolves relative to *this* file, so every scenario gets the same
// fixtures.json regardless of where it's invoked from.
export const fixtures = JSON.parse(open('../fixtures.json'));
export const BASE_URL = __ENV.BASE_URL || fixtures.apiUrl;

export function randomToken() {
  return fixtures.userTokens[Math.floor(Math.random() * fixtures.userTokens.length)];
}

export function randomListingIdForDetail() {
  const ids = fixtures.listingIdsForDetail;
  return ids[Math.floor(Math.random() * ids.length)];
}

export function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}
