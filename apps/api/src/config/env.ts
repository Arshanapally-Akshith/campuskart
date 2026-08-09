function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  logLevel: optional('LOG_LEVEL', 'info'),
  corsOrigins: required('CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim()),
  mongoUri: required('MONGO_URI'),
  redisUrl: required('REDIS_URL'),
  jwtSecret: required('JWT_SECRET'),
} as const;

export const isProduction = env.nodeEnv === 'production';
