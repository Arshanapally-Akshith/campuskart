import type { Listing as ListingDto } from '@campuskart/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, registerLoggedInUser } from './helpers.js';
import { Listing } from '../src/models/Listing.js';

function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// ARCHITECTURE.md §9 / BUILD.md Phase 7: express-mongo-sanitize strips
// `$`/`.` keys from req.body/query/params before any handler sees them.
//
// Most routes in this codebase validate every field with a Zod scalar
// schema (z.string(), z.enum(...), etc.), which already rejects an
// object-shaped injection payload on its own — so it doesn't actually
// prove the *sanitizer* is wired in versus "Zod caught it anyway". The one
// field in the API surface that's genuinely permissive enough to let a
// `$`-prefixed or dotted key *through* Zod is `attributes` on an OTHER
// listing (packages/shared/src/listings.ts: `z.record(z.string(), ...)`,
// no key restriction) — so that's the field these tests exercise.
describe('NoSQL injection protection (express-mongo-sanitize)', () => {
  it('strips a $-prefixed operator key from listing attributes before it is stored', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);

    const res = await request(app)
      .post('/api/listings')
      .set(...auth(seller.accessToken))
      .send({
        title: 'Injection probe listing',
        description: 'Exercises the mongo-sanitize middleware, not a real listing.',
        category: 'OTHER',
        attributes: {
          $where: 'sleep(10000)',
          normalKey: 'safe value',
        },
        priceInPaise: 100000,
        condition: 'GOOD',
      })
      .expect(201);

    const body = res.body as ListingDto;
    expect(body.attributes).not.toHaveProperty('$where');
    expect(body.attributes['normalKey']).toBe('safe value');

    // Confirm it never reached Mongo in the first place, not just that the
    // response happens to omit it.
    const stored = await Listing.findById(body.id);
    expect(stored?.attributes).not.toHaveProperty('$where');
  });

  it('strips a dotted key from listing attributes before it is stored', async () => {
    const app = buildApp();
    const seller = await registerLoggedInUser(app);

    const res = await request(app)
      .post('/api/listings')
      .set(...auth(seller.accessToken))
      .send({
        title: 'Injection probe listing 2',
        description: 'Exercises the mongo-sanitize middleware, not a real listing.',
        category: 'OTHER',
        attributes: {
          'this.has.dots': 'x',
          brand: 'ok',
        },
        priceInPaise: 100000,
        condition: 'GOOD',
      })
      .expect(201);

    const body = res.body as ListingDto;
    expect(body.attributes).not.toHaveProperty('this.has.dots');
    expect(body.attributes['brand']).toBe('ok');
  });
});
