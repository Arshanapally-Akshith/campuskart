/**
 * Seeds the single public "Try Demo" account (packages/shared/src/auth.ts's
 * DEMO_ACCOUNT_EMAIL/PASSWORD, used by apps/web's login screen) plus a
 * small amount of sample data for it to explore.
 *
 * Unlike scripts/seed.ts and scripts/loadSeed.ts, this script:
 *   - never deletes anything,
 *   - is idempotent (safe to run more than once), and
 *   - is NOT blocked under NODE_ENV=production — it needs to run there,
 *     once, against the real deployment, since the destructive dev seed
 *     scripts refuse to.
 *
 * Usage: pnpm run seed:demo
 */
import { randomUUID } from 'node:crypto';
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_PASSWORD,
  createListingSchema,
  type Category,
} from '@campuskart/shared';
import mongoose, { Types } from 'mongoose';
import { connectMongo } from '../src/lib/mongo.js';
import { hashPassword } from '../src/lib/password.js';
import { Conversation } from '../src/models/Conversation.js';
import { Listing } from '../src/models/Listing.js';
import { Message } from '../src/models/Message.js';
import { User, type UserDocument } from '../src/models/User.js';

// Not a real, usable account — nothing ever logs in as these. They only
// exist so the demo account has other sellers' listings to browse and
// message about. The schema requires *some* password hash per user.
const FLAVOR_PASSWORD = 'not-a-real-account-2026';
const FLAVOR_SELLERS = [
  { email: 'demo.seller1@campuskart.dev', name: 'Ananya (Demo Seller)' },
  { email: 'demo.seller2@campuskart.dev', name: 'Rohan (Demo Seller)' },
];

interface DemoImage {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
}

/**
 * Real, freely-licensed product photography hotlinked from Wikimedia
 * Commons — not Cloudinary. Cloudinary is optional in this deployment
 * (apps/api/src/lib/cloudinary.ts) and seeding must never depend on a
 * paid/configured service or an actual upload flow. Commons' file CDN
 * (upload.wikimedia.org) is free, has no API key or rate-limit concerns for
 * normal hotlinking, and every file below is public domain or CC-BY/BY-SA
 * (reuse permitted). Each entry: a full-size image for the listing detail
 * page and a smaller one for feed/grid cards, matching the real pipeline's
 * url vs. thumbUrl split (apps/api/src/lib/thumbnailProcessor.ts) without
 * actually running it. Verified live (HTTP 200, image content-type) before
 * committing — see PR description.
 */
const DEMO_IMAGES = {
  macbookAirM1: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/MacBook_Air_M1.png/1280px-MacBook_Air_M1.png',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/MacBook_Air_M1.png/500px-MacBook_Air_M1.png',
    width: 1280,
    height: 1031,
  },
  bookStack: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Old_Books_01.JPG/1280px-Old_Books_01.JPG',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Old_Books_01.JPG/500px-Old_Books_01.JPG',
    width: 1280,
    height: 960,
  },
  oscilloscope: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/New_Oscilloscope.jpg/1280px-New_Oscilloscope.jpg',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/New_Oscilloscope.jpg/500px-New_Oscilloscope.jpg',
    width: 1280,
    height: 960,
  },
  mountainBike: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/39/Mountain_bike.JPG/1280px-Mountain_bike.JPG',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/3/39/Mountain_bike.JPG/500px-Mountain_bike.JPG',
    width: 1280,
    height: 960,
  },
  woodenBookshelf: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/IKEA_Billy_bookshelf_%2880x106_cm_birch_veneer%29.jpg/1280px-IKEA_Billy_bookshelf_%2880x106_cm_birch_veneer%29.jpg',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/IKEA_Billy_bookshelf_%2880x106_cm_birch_veneer%29.jpg/500px-IKEA_Billy_bookshelf_%2880x106_cm_birch_veneer%29.jpg',
    width: 900,
    height: 1280,
  },
  casioCalculator: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8f/Casio_fx-991ES_Calculator_New.jpg',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Casio_fx-991ES_Calculator_New.jpg/500px-Casio_fx-991ES_Calculator_New.jpg',
    width: 1200,
    height: 1600,
  },
  libraryBooks: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Stacks_of_Books.JPG/1280px-Stacks_of_Books.JPG',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Stacks_of_Books.JPG/500px-Stacks_of_Books.JPG',
    width: 1280,
    height: 960,
  },
  solderingIronKit: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/Soldering_iron_and_accessories.jpg/1280px-Soldering_iron_and_accessories.jpg',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/Soldering_iron_and_accessories.jpg/500px-Soldering_iron_and_accessories.jpg',
    width: 1280,
    height: 853,
  },
} as const satisfies Record<string, DemoImage>;

async function upsertVerifiedUser(
  email: string,
  name: string,
  password: string,
): Promise<UserDocument> {
  const passwordHash = await hashPassword(password);
  const user = await User.findOneAndUpdate(
    { email },
    { $set: { passwordHash, name, emailVerifiedAt: new Date(), status: 'ACTIVE' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  // upsert:true + new:true always returns the document; this narrows the
  // type for TypeScript rather than guarding a real runtime case.
  if (!user) throw new Error(`Failed to upsert user ${email}`);
  return user;
}

interface DemoListingSeed {
  sellerId: Types.ObjectId;
  title: string;
  description: string;
  category: Category;
  attributes: Record<string, string | number>;
  priceInPaise: number;
  condition: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR';
  imageKey: keyof typeof DEMO_IMAGES;
}

/**
 * Keyed by the DEMO_IMAGES entry name rather than the listing's own _id
 * (which a pre-existing listing being upgraded doesn't hand us ahead of
 * the update), so a brand-new listing and an existing one upgraded to the
 * current DEMO_IMAGES produce the exact same publicId either way. Not a
 * real Cloudinary asset — hotlinked from Wikimedia Commons (see
 * DEMO_IMAGES above) — which is harmless: DELETE /images already treats a
 * failed Cloudinary delete as best-effort, not fatal
 * (apps/api/src/routes/listings.ts).
 */
function buildDemoImageSubdoc(seed: DemoListingSeed): {
  publicId: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
} {
  const image = DEMO_IMAGES[seed.imageKey];
  return {
    publicId: `demo-wikimedia/${seed.imageKey}`,
    url: image.url,
    thumbUrl: image.thumbUrl,
    width: image.width,
    height: image.height,
  };
}

// All ACTIVE: apps/web has no "my listings" view and the browse feed only
// ever shows status: ACTIVE (apps/api/src/routes/listings.ts), so a DRAFT
// or SOLD demo listing would be unreachable through the UI — dead weight,
// not realism.
async function seedListings(seeds: DemoListingSeed[]): Promise<void> {
  const docs = seeds.map((seed) => {
    const validated = createListingSchema.parse({
      title: seed.title,
      description: seed.description,
      category: seed.category,
      attributes: seed.attributes,
      priceInPaise: seed.priceInPaise,
      condition: seed.condition,
    });
    return {
      ...validated,
      sellerId: seed.sellerId,
      status: 'ACTIVE' as const,
      images: [buildDemoImageSubdoc(seed)],
      reservedBy: null,
      reservedAt: null,
      reservationExpiresAt: null,
      soldTo: null,
      soldAt: null,
      version: 1,
      reportCount: 0,
    };
  });
  await Listing.insertMany(docs);
}

function imageMatches(
  current:
    | { publicId: string; url: string; thumbUrl?: string | null; width: number; height: number }
    | undefined,
  desired: { publicId: string; url: string; thumbUrl: string; width: number; height: number },
): boolean {
  return (
    current !== undefined &&
    current.publicId === desired.publicId &&
    current.url === desired.url &&
    current.thumbUrl === desired.thumbUrl &&
    current.width === desired.width &&
    current.height === desired.height
  );
}

/**
 * Safe to run against a database seeded before DEMO_IMAGES existed (or any
 * later change to those URLs): for each of the 8 known demo listings
 * (matched by sellerId + exact title — a "(Demo Listing)" title is a
 * marker only this script ever creates), sets *only* `images` to the
 * current DEMO_IMAGES value. Never touches any other field, never inserts
 * (no upsert — a listing that doesn't exist yet is left for the create
 * path above, not conjured here), so it can't duplicate or recreate
 * anything and can't clobber a legitimate edit to price/title/description/
 * etc. Returns how many listings were actually changed.
 *
 * Compares the current image against the desired one itself, rather than
 * trusting `updateOne`'s modifiedCount: Mongoose's query-level casting of
 * an embedded-subdocument array `$set` was observed to report
 * modifiedCount: 1 even when the resulting document is byte-identical to
 * what was already stored, which would otherwise make this "upgrade" step
 * report (and needlessly re-write) all 8 listings on every single run.
 */
async function upgradeListingImages(seeds: DemoListingSeed[]): Promise<number> {
  let upgradedCount = 0;
  for (const seed of seeds) {
    const existing = await Listing.findOne(
      { sellerId: seed.sellerId, title: seed.title },
      { images: 1 },
    ).lean();
    if (!existing) continue; // Doesn't exist yet — left for the create path, not upserted here.

    const desired = buildDemoImageSubdoc(seed);
    if (imageMatches(existing.images[0], desired)) continue;

    await Listing.updateOne({ _id: existing._id }, { $set: { images: [desired] } });
    upgradedCount += 1;
  }
  return upgradedCount;
}

async function seedConversation(
  listingId: Types.ObjectId,
  buyerId: Types.ObjectId,
  sellerId: Types.ObjectId,
  messages: { senderId: Types.ObjectId; body: string }[],
): Promise<void> {
  const sorted = [buyerId.toString(), sellerId.toString()].sort();
  const conversation = await Conversation.create({
    listingId,
    participants: [new Types.ObjectId(sorted[0]), new Types.ObjectId(sorted[1])],
    participantsKey: `${sorted[0]}_${sorted[1]}`,
    lastSeq: messages.length,
    lastMessageAt: new Date(),
    lastMessagePreview: messages[messages.length - 1]?.body.slice(0, 80) ?? '',
    reads: { [buyerId.toString()]: messages.length, [sellerId.toString()]: messages.length },
  });

  await Message.insertMany(
    messages.map((m, i) => ({
      conversationId: conversation._id,
      seq: i + 1,
      senderId: m.senderId,
      clientMsgId: randomUUID(),
      body: m.body,
    })),
  );
}

function buildDemoListingSeeds(
  demoUser: UserDocument,
  seller1: UserDocument,
  seller2: UserDocument,
): DemoListingSeed[] {
  return [
    // Owned by the demo user — findable via GET /api/listings?seller=<id>.
    {
      sellerId: demoUser._id,
      title: 'MacBook Air M1 (Demo Listing)',
      description:
        'Barely used MacBook Air M1, 8GB/256GB. Great for coursework. This is sample data for the CampusKart demo account.',
      category: 'ELECTRONICS',
      attributes: { brand: 'Apple', model: 'MacBook Air M1', warrantyMonths: 6 },
      priceInPaise: 5_500_000,
      condition: 'LIKE_NEW',
      imageKey: 'macbookAirM1',
    },
    {
      sellerId: demoUser._id,
      title: 'GATE CS Made Easy Book Set (Demo Listing)',
      description:
        'Complete Made Easy book set for GATE CS preparation, lightly highlighted. Sample data for the CampusKart demo account.',
      category: 'BOOKS',
      attributes: { author: 'Made Easy Publications', edition: '2024 Edition' },
      priceInPaise: 180_000,
      condition: 'GOOD',
      imageKey: 'bookStack',
    },
    // Owned by the flavor sellers — gives the demo user a feed to browse,
    // filter, and reserve/message from as a buyer.
    {
      sellerId: seller1._id,
      title: 'Digital Storage Oscilloscope (Demo Listing)',
      description:
        '2-channel digital oscilloscope, works perfectly, used for one lab course. Sample data for the CampusKart demo account.',
      category: 'LAB',
      attributes: { equipmentType: 'Oscilloscope', brand: 'Rigol' },
      priceInPaise: 850_000,
      condition: 'GOOD',
      imageKey: 'oscilloscope',
    },
    {
      sellerId: seller1._id,
      title: 'Mountain Bike 21-Speed (Demo Listing)',
      description:
        'Well-maintained 21-speed mountain bike, great for getting around campus. Sample data for the CampusKart demo account.',
      category: 'CYCLE',
      attributes: { gearCount: 21, brand: 'Hercules' },
      priceInPaise: 600_000,
      condition: 'GOOD',
      imageKey: 'mountainBike',
    },
    {
      sellerId: seller1._id,
      title: 'Wooden Bookshelf, 5 Tiers (Demo Listing)',
      description:
        '5-tier wooden bookshelf, sturdy and spacious. Sample data for the CampusKart demo account.',
      category: 'FURNITURE',
      attributes: { material: 'Wood', dimensions: '80x180cm' },
      priceInPaise: 320_000,
      condition: 'GOOD',
      imageKey: 'woodenBookshelf',
    },
    {
      sellerId: seller2._id,
      title: 'Casio fx-991ES Scientific Calculator (Demo Listing)',
      description:
        'Standard engineering scientific calculator, all functions working. Sample data for the CampusKart demo account.',
      category: 'ELECTRONICS',
      attributes: { brand: 'Casio', model: 'fx-991ES' },
      priceInPaise: 90_000,
      condition: 'GOOD',
      imageKey: 'casioCalculator',
    },
    {
      sellerId: seller2._id,
      title: 'Engineering Mathematics Textbook (Demo Listing)',
      description:
        'B.S. Grewal Engineering Mathematics, minor cover wear, all pages intact. Sample data for the CampusKart demo account.',
      category: 'BOOKS',
      attributes: { author: 'B.S. Grewal' },
      priceInPaise: 40_000,
      condition: 'FAIR',
      imageKey: 'libraryBooks',
    },
    {
      sellerId: seller2._id,
      title: 'Soldering Iron Kit (Demo Listing)',
      description:
        'Complete soldering iron kit with stand and extra tips. Sample data for the CampusKart demo account.',
      category: 'LAB',
      attributes: { equipmentType: 'Soldering Iron' },
      priceInPaise: 60_000,
      condition: 'NEW',
      imageKey: 'solderingIronKit',
    },
  ];
}

async function main(): Promise<void> {
  console.log(`Seeding demo account: ${DEMO_ACCOUNT_EMAIL}`);
  await connectMongo();

  const demoUser = await upsertVerifiedUser(DEMO_ACCOUNT_EMAIL, 'Demo User', DEMO_ACCOUNT_PASSWORD);
  const sellers = await Promise.all(
    FLAVOR_SELLERS.map((s) => upsertVerifiedUser(s.email, s.name, FLAVOR_PASSWORD)),
  );
  console.log('Demo user and flavor sellers ready.');

  const [seller1, seller2] = sellers;
  if (!seller1 || !seller2) throw new Error('Expected two flavor sellers');
  const seeds = buildDemoListingSeeds(demoUser, seller1, seller2);

  const alreadySeeded = await Listing.exists({ sellerId: demoUser._id });
  if (!alreadySeeded) {
    console.log('Creating sample listings and a conversation...');
    await seedListings(seeds);

    const oscilloscope = await Listing.findOne({
      sellerId: seller1._id,
      title: 'Digital Storage Oscilloscope (Demo Listing)',
    });
    if (oscilloscope) {
      await seedConversation(oscilloscope._id, demoUser._id, seller1._id, [
        { senderId: demoUser._id, body: 'Hi! Is the oscilloscope still available?' },
        { senderId: seller1._id, body: 'Yes it is! Works great, happy to demo it in person.' },
        { senderId: demoUser._id, body: 'Awesome, I might reserve it — thanks!' },
      ]);
    }

    console.log('Sample listings and conversation created.');
  } else {
    console.log('Sample listings already exist for the demo account.');
  }

  // Runs every time, independent of the branch above: upgrades any of the
  // 8 known demo listings still carrying stale/empty images (e.g. a
  // database seeded before DEMO_IMAGES existed) to the current photos,
  // without touching anything else.
  console.log('Checking demo listing images are up to date...');
  const upgradedCount = await upgradeListingImages(seeds);
  if (upgradedCount > 0) {
    console.log(
      `Upgraded images on ${String(upgradedCount)} existing demo listing(s) to the current DEMO_IMAGES.`,
    );
  } else {
    console.log('Demo listing images already up to date.');
  }

  console.log('Done. Log in with the "Try Demo" button, or:');
  console.log(`  email: ${DEMO_ACCOUNT_EMAIL}`);
  console.log(`  password: (see packages/shared/src/auth.ts DEMO_ACCOUNT_PASSWORD)`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Demo seed failed:', err);
  process.exit(1);
});
