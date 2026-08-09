/**
 * BUILD.md Phase 9: "Seed 50k listings, 200k messages." Separate from
 * scripts/seed.ts (Phase 2's 200-user/5,000-listing dev dataset) because
 * this is purpose-built for k6 load tests, not day-to-day dev browsing: it
 * also mints ready-to-use JWTs and writes a fixtures file the k6 scripts
 * read directly, so a load-test run never has to pay for real signup/login
 * round trips it isn't trying to measure.
 *
 * Usage: pnpm --filter @campuskart/api run seed:load
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { faker } from '@faker-js/faker';
import { createListingSchema, type Category } from '@campuskart/shared';
import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { connectMongo } from '../src/lib/mongo.js';
import { hashPassword } from '../src/lib/password.js';
import { Conversation } from '../src/models/Conversation.js';
import { Listing } from '../src/models/Listing.js';
import { Message } from '../src/models/Message.js';
import { User } from '../src/models/User.js';

const USER_COUNT = Number(process.env['LOAD_USER_COUNT'] ?? 3000);
const LISTING_COUNT = Number(process.env['LOAD_LISTING_COUNT'] ?? 50_000);
const CONVERSATION_COUNT = Number(process.env['LOAD_CONVERSATION_COUNT'] ?? 5_000);
const TARGET_MESSAGE_COUNT = Number(process.env['LOAD_MESSAGE_COUNT'] ?? 200_000);
const BATCH_SIZE = 5_000;
const SEED_PASSWORD = 'CampusKart@Load2026';

const CATEGORIES: Category[] = ['ELECTRONICS', 'BOOKS', 'CYCLE', 'FURNITURE', 'LAB', 'OTHER'];
const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as const;

function randomAttributes(category: Category): Record<string, string | number> {
  switch (category) {
    case 'ELECTRONICS':
      return { brand: faker.company.name() };
    case 'BOOKS':
      return { author: faker.person.fullName() };
    case 'CYCLE':
      return { gearCount: faker.number.int({ min: 0, max: 21 }) };
    case 'FURNITURE':
      return { material: faker.helpers.arrayElement(['Wood', 'Metal', 'Plastic']) };
    case 'LAB':
      return { equipmentType: faker.helpers.arrayElement(['Multimeter', 'Oscilloscope']) };
    case 'OTHER':
      return {};
  }
}

// Mostly ACTIVE: this dataset exists to be paged/searched/reserved through
// at scale (BUILD.md Phase 9's k6 scenarios), not to model realistic
// listing-status distribution the way Phase 2's seed.ts does.
function randomStatus(): 'DRAFT' | 'ACTIVE' | 'RESERVED' | 'SOLD' | 'REMOVED' {
  const r = Math.random();
  if (r < 0.02) return 'DRAFT';
  if (r < 0.9) return 'ACTIVE';
  if (r < 0.94) return 'RESERVED';
  if (r < 0.98) return 'SOLD';
  return 'REMOVED';
}

async function insertInBatches<T>(
  label: string,
  total: number,
  batchSize: number,
  buildBatch: (start: number, count: number) => T[],
  insert: (docs: T[]) => Promise<unknown>,
): Promise<void> {
  let done = 0;
  while (done < total) {
    const count = Math.min(batchSize, total - done);
    const batch = buildBatch(done, count);
    await insert(batch);
    done += count;
    process.stdout.write(`\r  ${label}: ${String(done)}/${String(total)}`);
  }
  process.stdout.write('\n');
}

async function seedUsers(): Promise<Types.ObjectId[]> {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const ids: Types.ObjectId[] = [];

  await insertInBatches(
    'users',
    USER_COUNT,
    BATCH_SIZE,
    (start, count) =>
      Array.from({ length: count }, (_, i) => ({
        email: `load.user${String(start + i)}.${faker.string.alphanumeric(6).toLowerCase()}@student.nitw.ac.in`,
        emailVerifiedAt: new Date(),
        passwordHash,
        name: faker.person.fullName(),
        hostel: null,
        phone: null,
        avatarUrl: null,
        ratingAvg: 0,
        ratingCount: 0,
        strikes: 0,
        status: 'ACTIVE' as const,
      })),
    async (docs) => {
      const inserted = await User.insertMany(docs);
      ids.push(...inserted.map((u) => u._id));
    },
  );

  return ids;
}

async function seedListings(userIds: Types.ObjectId[]): Promise<Types.ObjectId[]> {
  const now = Date.now();
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  const activeIds: Types.ObjectId[] = [];

  await insertInBatches(
    'listings',
    LISTING_COUNT,
    BATCH_SIZE,
    (_start, count) =>
      Array.from({ length: count }, () => {
        const category = faker.helpers.arrayElement(CATEGORIES);
        const status = randomStatus();
        const createdAt = new Date(now - Math.floor(Math.random() * yearMs));
        const sellerId = faker.helpers.arrayElement(userIds);

        const validated = createListingSchema.parse({
          title: faker.commerce.productName().slice(0, 100),
          description: faker.lorem.paragraphs({ min: 1, max: 3 }).slice(0, 2000),
          category,
          attributes: randomAttributes(category),
          priceInPaise: faker.number.int({ min: 5_000, max: 5_000_000 }),
          condition: faker.helpers.arrayElement(CONDITIONS),
        });

        const isReserved = status === 'RESERVED';
        const isSold = status === 'SOLD';
        const buyerId = isReserved || isSold ? faker.helpers.arrayElement(userIds) : null;

        return {
          _id: new Types.ObjectId(),
          ...validated,
          sellerId,
          status,
          images: [],
          reservedBy: isReserved ? buyerId : null,
          reservedAt: isReserved ? new Date(now - 5 * 60 * 1000) : null,
          reservationExpiresAt: isReserved ? new Date(now + 25 * 60 * 1000) : null,
          soldTo: isSold ? buyerId : null,
          soldAt: isSold ? new Date(createdAt.getTime() + 60 * 60 * 1000) : null,
          version: status === 'DRAFT' ? 0 : 1,
          reportCount: 0,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    async (docs) => {
      const inserted = (await Listing.insertMany(docs, { ordered: false })) as {
        _id: Types.ObjectId;
        status: string;
      }[];
      for (const doc of inserted) {
        if (doc.status === 'ACTIVE') activeIds.push(doc._id);
      }
    },
  );

  return activeIds;
}

interface ConversationSeed {
  _id: Types.ObjectId;
  listingId: Types.ObjectId;
  participants: [Types.ObjectId, Types.ObjectId];
  participantsKey: string;
}

async function seedConversationsAndMessages(
  userIds: Types.ObjectId[],
  listingIds: Types.ObjectId[],
): Promise<{ conversationId: string; participantAId: string; participantBId: string }[]> {
  const conversationSeeds: ConversationSeed[] = Array.from({ length: CONVERSATION_COUNT }, () => {
    const listingId = faker.helpers.arrayElement(listingIds);
    const a = faker.helpers.arrayElement(userIds);
    let b = faker.helpers.arrayElement(userIds);
    while (b.equals(a)) b = faker.helpers.arrayElement(userIds);
    const sorted = [a.toString(), b.toString()].sort();
    return {
      _id: new Types.ObjectId(),
      listingId,
      participants: [new Types.ObjectId(sorted[0]), new Types.ObjectId(sorted[1])],
      participantsKey: `${sorted[0]}_${sorted[1]}`,
    };
  });

  // Average ~40 messages/conversation (200k / 5k) with variance, so message
  // volume per conversation looks like real chat activity rather than a
  // uniform stamp.
  const avgPerConversation = Math.max(1, Math.round(TARGET_MESSAGE_COUNT / CONVERSATION_COUNT));
  const now = Date.now();

  const conversationDocs = conversationSeeds.map((c) => {
    const messageCount = Math.max(1, Math.round(avgPerConversation * (0.4 + Math.random() * 1.2)));
    const lastMessageAt = new Date(now - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000));
    return {
      ...c,
      lastSeq: messageCount,
      lastMessageAt,
      lastMessagePreview: faker.lorem.sentence().slice(0, 80),
      reads: {
        [c.participants[0].toString()]: messageCount,
        [c.participants[1].toString()]: Math.max(
          0,
          messageCount - faker.number.int({ min: 0, max: 5 }),
        ),
      },
      createdAt: new Date(lastMessageAt.getTime() - messageCount * 60_000),
      _messageCount: messageCount,
    };
  });

  process.stdout.write(`  conversations: inserting ${String(conversationDocs.length)}\n`);
  await Conversation.insertMany(
    conversationDocs.map(({ _messageCount, ...doc }) => doc),
    { ordered: false },
  );

  let totalMessages = 0;
  let batch: Record<string, unknown>[] = [];
  for (const conv of conversationDocs) {
    const start = new Date(conv.createdAt);
    for (let seq = 1; seq <= conv._messageCount; seq += 1) {
      const sender = conv.participants[seq % 2];
      batch.push({
        conversationId: conv._id,
        seq,
        senderId: sender,
        clientMsgId: randomUUID(),
        body: faker.lorem.sentence().slice(0, 200),
        createdAt: new Date(start.getTime() + seq * 60_000),
      });
      totalMessages += 1;
      if (batch.length >= BATCH_SIZE) {
        await Message.insertMany(batch, { ordered: false });
        process.stdout.write(`\r  messages: ${String(totalMessages)}`);
        batch = [];
      }
    }
  }
  if (batch.length > 0) {
    await Message.insertMany(batch, { ordered: false });
  }
  process.stdout.write(`\r  messages: ${String(totalMessages)}\n`);

  // Fixture pairs for the k6 chat-throughput scenario: pick a spread of
  // conversations and hand back both participants' ids so the script can
  // sign tokens for a sender who is actually a member of that conversation.
  return conversationDocs.slice(0, 200).map((c) => ({
    conversationId: c._id.toString(),
    participantAId: c.participants[0].toString(),
    participantBId: c.participants[1].toString(),
  }));
}

interface Fixtures {
  apiUrl: string;
  generatedAt: string;
  userTokens: string[];
  listingIdsForDetail: string[];
  reserveContentionListingIds: string[];
  chatConversations: { conversationId: string; tokenA: string; tokenB: string }[];
}

function writeFixtures(fixtures: Fixtures): void {
  const dir = fileURLToPath(new URL('../../../k6', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const path = fileURLToPath(new URL('../../../k6/fixtures.json', import.meta.url));
  writeFileSync(path, JSON.stringify(fixtures, null, 2));
  console.log(`Wrote k6 fixtures to ${path}`);
}

async function main(): Promise<void> {
  if (env.nodeEnv === 'production') {
    console.error('Refusing to run the load-seed script with NODE_ENV=production.');
    process.exit(1);
  }

  console.log(
    `Load-seeding ${String(USER_COUNT)} users, ${String(LISTING_COUNT)} listings, ` +
      `${String(CONVERSATION_COUNT)} conversations (~${String(TARGET_MESSAGE_COUNT)} messages)...`,
  );
  const startedAt = Date.now();

  await connectMongo();
  console.log('Clearing existing users/listings/conversations/messages...');
  await Promise.all([
    User.deleteMany({}),
    Listing.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
  ]);

  console.log('Seeding users...');
  const userIds = await seedUsers();

  console.log('Seeding listings...');
  const activeListingIds = await seedListings(userIds);
  console.log(`  ${String(activeListingIds.length)} listings are ACTIVE`);

  console.log('Seeding conversations + messages...');
  const chatFixturePairs = await seedConversationsAndMessages(userIds, activeListingIds);

  console.log('Minting fixture JWTs for k6 (no login round trips during the load test)...');
  const userTokens = userIds
    .slice(0, 500)
    .map((id) =>
      signAccessToken({ sub: id.toString(), email: `load-${id.toString()}@student.nitw.ac.in` }),
    );

  const shuffledActive = [...activeListingIds].sort(() => Math.random() - 0.5);
  const fixtures: Fixtures = {
    apiUrl: `http://localhost:${String(env.port)}`,
    generatedAt: new Date().toISOString(),
    userTokens,
    listingIdsForDetail: shuffledActive.slice(0, 1000).map((id) => id.toString()),
    reserveContentionListingIds: shuffledActive.slice(1000, 1010).map((id) => id.toString()),
    chatConversations: chatFixturePairs.map((c) => ({
      conversationId: c.conversationId,
      tokenA: signAccessToken({
        sub: c.participantAId,
        email: `load-${c.participantAId}@student.nitw.ac.in`,
      }),
      tokenB: signAccessToken({
        sub: c.participantBId,
        email: `load-${c.participantBId}@student.nitw.ac.in`,
      }),
    })),
  };
  writeFixtures(fixtures);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done in ${seconds}s.`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Load seed failed:', err);
  process.exit(1);
});
