import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri);
  logger.info('Connected to MongoDB');
}

export function isMongoReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
