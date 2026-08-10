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

type CookieSameSite = 'lax' | 'none' | 'strict';

// Local dev has web (localhost:5173) and api (localhost:4000) on the same
// site per browser SameSite rules (scheme + registrable domain, port
// ignored), so 'lax' works there. A split-domain prod deploy (Vercel web +
// Render/Fly api) is cross-site, and a cross-site fetch never attaches a
// Lax cookie — the refresh endpoint would silently never receive it. Set
// COOKIE_SAME_SITE=none in that environment; Secure is already unconditional
// above, which 'none' requires.
function cookieSameSite(): CookieSameSite {
  const value = optional('COOKIE_SAME_SITE', 'lax');
  if (value !== 'lax' && value !== 'none' && value !== 'strict') {
    throw new Error(`Invalid COOKIE_SAME_SITE: ${value} (expected lax, none, or strict)`);
  }
  return value;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),
  logLevel: optional('LOG_LEVEL', 'info'),
  corsOrigins: required('CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim()),
  cookieSameSite: cookieSameSite(),
  mongoUri: required('MONGO_URI'),
  redisUrl: required('REDIS_URL'),
  jwtSecret: required('JWT_SECRET'),
  // Optional: Cloudinary is only needed for the image pipeline. Leaving
  // these unset lets the API/worker start normally; anything that actually
  // needs Cloudinary fails with a clear 503 at the point of use instead —
  // see isCloudinaryConfigured and lib/cloudinary.ts.
  cloudinaryCloudName: optional('CLOUDINARY_CLOUD_NAME', ''),
  cloudinaryApiKey: optional('CLOUDINARY_API_KEY', ''),
  cloudinaryApiSecret: optional('CLOUDINARY_API_SECRET', ''),
} as const;

export const isProduction = env.nodeEnv === 'production';

export const isCloudinaryConfigured =
  env.cloudinaryCloudName !== '' && env.cloudinaryApiKey !== '' && env.cloudinaryApiSecret !== '';
