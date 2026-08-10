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
      images: [],
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

async function main(): Promise<void> {
  console.log(`Seeding demo account: ${DEMO_ACCOUNT_EMAIL}`);
  await connectMongo();

  const demoUser = await upsertVerifiedUser(DEMO_ACCOUNT_EMAIL, 'Demo User', DEMO_ACCOUNT_PASSWORD);
  const sellers = await Promise.all(
    FLAVOR_SELLERS.map((s) => upsertVerifiedUser(s.email, s.name, FLAVOR_PASSWORD)),
  );
  console.log('Demo user and flavor sellers ready.');

  const alreadySeeded = await Listing.exists({ sellerId: demoUser._id });
  if (alreadySeeded) {
    console.log('Sample listings already exist for the demo account — skipping.');
  } else {
    console.log('Creating sample listings and a conversation...');
    const [seller1, seller2] = sellers;
    if (!seller1 || !seller2) throw new Error('Expected two flavor sellers');

    await seedListings([
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
      },
    ]);

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
