import { faker } from '@faker-js/faker';
import { createListingSchema, type Category } from '@campuskart/shared';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectMongo } from '../src/lib/mongo.js';
import { hashPassword } from '../src/lib/password.js';
import { Listing } from '../src/models/Listing.js';
import { User } from '../src/models/User.js';

const USER_COUNT = Number(process.env['SEED_USER_COUNT'] ?? 200);
const LISTING_COUNT = Number(process.env['SEED_LISTING_COUNT'] ?? 5000);
const SEED_PASSWORD = 'CampusKart@Seed2026';

const CATEGORIES: Category[] = ['ELECTRONICS', 'BOOKS', 'CYCLE', 'FURNITURE', 'LAB', 'OTHER'];
const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as const;
const HOSTELS = ['Vindhya', 'Godavari', 'Kaveri', 'Krishna', 'Tapti', 'Mahanadi', null, null];

function randomAttributes(category: Category): Record<string, string | number> {
  switch (category) {
    case 'ELECTRONICS':
      return {
        brand: faker.company.name(),
        ...(faker.datatype.boolean() && { model: faker.commerce.productName() }),
        ...(faker.datatype.boolean() && { warrantyMonths: faker.number.int({ min: 0, max: 24 }) }),
      };
    case 'BOOKS':
      return {
        author: faker.person.fullName(),
        ...(faker.datatype.boolean() && {
          edition: `${String(faker.number.int({ min: 1, max: 5 }))}th Edition`,
        }),
        ...(faker.datatype.boolean() && { isbn: faker.string.numeric(13) }),
      };
    case 'CYCLE':
      return {
        gearCount: faker.number.int({ min: 0, max: 21 }),
        ...(faker.datatype.boolean() && { brand: faker.company.name() }),
        ...(faker.datatype.boolean() && {
          frameSize: faker.helpers.arrayElement(['S', 'M', 'L', 'XL']),
        }),
      };
    case 'FURNITURE':
      return {
        material: faker.helpers.arrayElement(['Wood', 'Metal', 'Plastic', 'Engineered Wood']),
        ...(faker.datatype.boolean() && {
          dimensions: `${String(faker.number.int({ min: 30, max: 200 }))}x${String(faker.number.int({ min: 30, max: 200 }))}cm`,
        }),
      };
    case 'LAB':
      return {
        equipmentType: faker.helpers.arrayElement([
          'Multimeter',
          'Oscilloscope',
          'Breadboard Kit',
          'Soldering Iron',
          'Lab Coat',
        ]),
        ...(faker.datatype.boolean() && { brand: faker.company.name() }),
      };
    case 'OTHER':
      return {};
  }
}

function randomStatus(): 'DRAFT' | 'ACTIVE' | 'SOLD' | 'REMOVED' {
  const r = Math.random();
  if (r < 0.1) return 'DRAFT';
  if (r < 0.85) return 'ACTIVE';
  if (r < 0.95) return 'SOLD';
  return 'REMOVED';
}

async function seedUsers(): Promise<mongoose.Types.ObjectId[]> {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const users = Array.from({ length: USER_COUNT }, (_, i) => ({
    email: `seed.user${String(i)}.${faker.string.alphanumeric(6).toLowerCase()}@student.nitw.ac.in`,
    emailVerifiedAt: new Date(),
    passwordHash,
    name: faker.person.fullName(),
    hostel: faker.helpers.arrayElement(HOSTELS),
    phone: faker.datatype.boolean() ? `9${faker.string.numeric(9)}` : null,
    avatarUrl: null,
    ratingAvg: faker.datatype.boolean({ probability: 0.3 })
      ? Number(faker.number.float({ min: 3, max: 5, fractionDigits: 1 }))
      : 0,
    ratingCount: 0,
    strikes: 0,
    status: 'ACTIVE' as const,
  }));

  const inserted = await User.insertMany(users);
  return inserted.map((u) => u._id);
}

async function seedListings(userIds: mongoose.Types.ObjectId[]): Promise<void> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const inputs = Array.from({ length: LISTING_COUNT }, () => {
    const category = faker.helpers.arrayElement(CATEGORIES);
    const status = randomStatus();
    const createdAt = faker.date.past({ years: 1 });
    const sellerId = faker.helpers.arrayElement(userIds);

    // Validated through the exact schema the API validates POST /listings
    // against — catches generator bugs the same way a bad client request
    // would be caught.
    const validated = createListingSchema.parse({
      title: faker.commerce.productName().slice(0, 100),
      description: faker.lorem.paragraphs({ min: 1, max: 3 }).slice(0, 2000),
      category,
      attributes: randomAttributes(category),
      priceInPaise: faker.number.int({ min: 5_000, max: 5_000_000 }),
      condition: faker.helpers.arrayElement(CONDITIONS),
    });

    let soldTo: mongoose.Types.ObjectId | null = null;
    let soldAt: Date | null = null;
    if (status === 'SOLD') {
      const buyerCandidates = userIds.filter((id) => !id.equals(sellerId));
      soldTo = faker.helpers.arrayElement(buyerCandidates);
      const maxSoldOffsetDays = Math.max(1, Math.floor((now - createdAt.getTime()) / dayMs));
      soldAt = new Date(
        Math.min(
          now,
          createdAt.getTime() + faker.number.int({ min: 1, max: maxSoldOffsetDays }) * dayMs,
        ),
      );
    }

    return {
      ...validated,
      sellerId,
      status,
      images: [],
      reservedBy: null,
      reservedAt: null,
      reservationExpiresAt: null,
      soldTo,
      soldAt,
      version: status === 'DRAFT' ? 0 : 1,
      reportCount: faker.datatype.boolean({ probability: 0.05 })
        ? faker.number.int({ min: 1, max: 3 })
        : 0,
      // Mongoose respects an explicit createdAt/updatedAt at document
      // *creation* time (it only forces `updatedAt` on later saves) — this
      // is what gives the "realistic date spread" BUILD.md asks for. Note
      // this only works pre-insert: `timestamps: true` makes `createdAt`
      // immutable, so a later `$set` via update/bulkWrite is silently
      // dropped even though the write reports success.
      createdAt,
      updatedAt: createdAt,
    };
  });

  await Listing.insertMany(inputs, { ordered: false });
}

async function main(): Promise<void> {
  if (env.nodeEnv === 'production') {
    console.error('Refusing to run the seed script with NODE_ENV=production.');
    process.exit(1);
  }

  console.log(`Seeding ${String(USER_COUNT)} users and ${String(LISTING_COUNT)} listings...`);
  const startedAt = Date.now();

  await connectMongo();
  console.log('Clearing existing users and listings...');
  await Promise.all([User.deleteMany({}), Listing.deleteMany({})]);

  console.log('Creating users...');
  const userIds = await seedUsers();

  console.log('Creating listings...');
  await seedListings(userIds);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done in ${seconds}s.`);
  console.log(`Log in as any seeded user with password: ${SEED_PASSWORD}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
