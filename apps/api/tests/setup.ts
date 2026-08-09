import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { redis } from '../src/lib/redis.js';
import { sentOtps } from './mailerSpy.js';

vi.mock('../src/lib/mailer.js', () => ({
  sendOtpEmail: (email: string, otp: string) => {
    sentOtps.set(email, otp);
  },
}));

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  sentOtps.clear();
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
  // No blanket Redis flush here: `otp:*` lives on the one real Redis
  // instance shared by every test *file*, which vitest runs concurrently in
  // separate workers. A `KEYS otp:*` + `DEL` sweep from this file would
  // race with another file's in-flight OTP keys. Per-test unique emails
  // already give each test its own namespaced key, and the 10-minute TTL
  // cleans up the rest.
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  redis.disconnect();
});
