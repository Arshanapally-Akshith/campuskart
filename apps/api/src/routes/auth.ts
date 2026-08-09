import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { ErrorCode, type AuthUser, type LoginResponse, type MeResponse } from '@campuskart/shared';
import type { RefreshResponse, SignupResponse, VerifyOtpResponse } from '@campuskart/shared';
import { asyncHandler } from '../lib/asyncHandler.js';
import { signAccessToken } from '../lib/jwt.js';
import { sendOtpEmail } from '../lib/mailer.js';
import { generateOtp, storeOtp, verifyOtp as verifyStoredOtp } from '../lib/otp.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { loginRateLimiter, otpRateLimiter, rateLimitMiddleware } from '../lib/rateLimit.js';
import {
  generateFamilyId,
  generateOpaqueToken,
  hashOpaqueToken,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
} from '../lib/tokens.js';
import { AppError } from '../middleware/errorHandler.js';
import { getAuthUser, requireAuth } from '../middleware/requireAuth.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { User, type UserDocument } from '../models/User.js';
import {
  assertNameLength,
  assertNitwEmail,
  assertOtpFormat,
  assertPasswordStrength,
  requireString,
} from '../lib/validate.js';

export const authRouter: RouterType = Router();

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/api/auth',
};

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

function readRefreshCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toPublicUser(user: UserDocument): AuthUser {
  return { id: user._id.toString(), email: user.email, name: user.name };
}

async function issueRefreshToken(
  userId: UserDocument['_id'],
  familyId: string,
  req: Request,
): Promise<string> {
  const token = generateOpaqueToken();
  await RefreshToken.create({
    userId,
    familyId,
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip ?? null,
  });
  return token;
}

// Lazily-computed decoy hash so a login attempt for a non-existent email
// takes roughly the same time as one for a real email — avoids leaking
// which emails are registered via response timing.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('correct horse battery staple decoy');
  return dummyHashPromise;
}

function normalizedEmailKey(req: Request): string {
  const body = req.body as Record<string, unknown> | undefined;
  const email = body?.['email'];
  return typeof email === 'string' ? email.trim().toLowerCase() : 'unknown';
}

authRouter.post(
  '/signup',
  // BUILD.md Phase 7: OTP 3/hour/email — signup is the only place an OTP is
  // sent (BUILD.md Phase 1 has no separate "resend" endpoint), so the limit
  // belongs here.
  rateLimitMiddleware(otpRateLimiter, normalizedEmailKey),
  asyncHandler(async (req, res) => {
    const email = requireString(req.body, 'email').trim().toLowerCase();
    const password = requireString(req.body, 'password');
    const name = requireString(req.body, 'name').trim();

    assertNitwEmail(email);
    assertPasswordStrength(password);
    assertNameLength(name);

    const existing = await User.findOne({ email });
    if (existing?.emailVerifiedAt) {
      throw new AppError(409, ErrorCode.CONFLICT, 'An account with this email already exists');
    }

    const passwordHash = await hashPassword(password);
    if (existing) {
      existing.passwordHash = passwordHash;
      existing.name = name;
      await existing.save();
    } else {
      await User.create({ email, passwordHash, name });
    }

    const otp = generateOtp();
    await storeOtp(email, otp);
    sendOtpEmail(email, otp);

    const body: SignupResponse = { email, otpSent: true };
    res.status(201).json(body);
  }),
);

authRouter.post(
  '/verify-otp',
  asyncHandler(async (req, res) => {
    const email = requireString(req.body, 'email').trim().toLowerCase();
    const otp = requireString(req.body, 'otp').trim();
    assertOtpFormat(otp);

    const result = await verifyStoredOtp(email, otp);
    if (result === 'ATTEMPTS_EXCEEDED') {
      throw new AppError(
        429,
        ErrorCode.OTP_ATTEMPTS_EXCEEDED,
        'Too many incorrect attempts. Sign up again to request a new code.',
      );
    }
    if (result !== 'OK') {
      throw new AppError(400, ErrorCode.INVALID_OTP, 'Incorrect or expired code');
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: { emailVerifiedAt: new Date() } },
      { new: true },
    );
    if (!user) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, 'No signup in progress for this email');
    }

    const body: VerifyOtpResponse = { verified: true };
    res.status(200).json(body);
  }),
);

authRouter.post(
  '/login',
  // BUILD.md Phase 7: login 5/15min/IP. Keyed on `req.ip`, which resolves
  // via the `trust proxy` setting in app.ts.
  rateLimitMiddleware(loginRateLimiter, (req) => req.ip ?? 'unknown'),
  asyncHandler(async (req, res) => {
    const email = requireString(req.body, 'email').trim().toLowerCase();
    const password = requireString(req.body, 'password');

    const user = await User.findOne({ email });
    const candidateHash = user?.passwordHash ?? (await getDummyHash());
    const passwordOk = await verifyPassword(candidateHash, password);

    if (!user || !passwordOk) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Invalid email or password');
    }
    if (!user.emailVerifiedAt) {
      throw new AppError(403, ErrorCode.EMAIL_NOT_VERIFIED, 'Verify your email before logging in');
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'This account has been suspended');
    }

    const familyId = generateFamilyId();
    const refreshToken = await issueRefreshToken(user._id, familyId, req);
    setRefreshCookie(res, refreshToken);

    const accessToken = signAccessToken({ sub: user._id.toString(), email: user.email });
    const body: LoginResponse = { user: toPublicUser(user), accessToken };
    res.status(200).json(body);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req);
    if (!presented) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing refresh token');
    }

    const presentedHash = hashOpaqueToken(presented);
    const now = new Date();

    // Atomic rotate-and-revoke: this can only succeed for the request that
    // observes revokedAt: null first. A second, concurrent presentation of
    // the same token loses the race here and falls into the reuse branch
    // below — mirrors the reservation guard in ARCHITECTURE.md §4.
    const rotated = await RefreshToken.findOneAndUpdate(
      { tokenHash: presentedHash, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { revokedAt: now } },
      { new: false },
    );

    if (!rotated) {
      const existing = await RefreshToken.findOne({ tokenHash: presentedHash });
      if (existing?.revokedAt) {
        // Reuse of an already-rotated (or already-lost-the-race) token:
        // treat as compromised and burn every live token in the family.
        await RefreshToken.updateMany(
          { familyId: existing.familyId, revokedAt: null },
          { $set: { revokedAt: now } },
        );
      }
      clearRefreshCookie(res);
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
    }

    const user = await User.findById(rotated.userId);
    if (!user || user.status === 'SUSPENDED') {
      clearRefreshCookie(res);
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
    }

    const newToken = generateOpaqueToken();
    const replacement = await RefreshToken.create({
      userId: rotated.userId,
      familyId: rotated.familyId,
      tokenHash: hashOpaqueToken(newToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    });
    await RefreshToken.updateOne({ _id: rotated._id }, { $set: { replacedBy: replacement._id } });

    setRefreshCookie(res, newToken);
    const accessToken = signAccessToken({ sub: user._id.toString(), email: user.email });
    const body: RefreshResponse = { user: toPublicUser(user), accessToken };
    res.status(200).json(body);
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req);
    if (presented) {
      await RefreshToken.updateOne(
        { tokenHash: hashOpaqueToken(presented), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
    }
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { sub } = getAuthUser(req);
    const user = await User.findById(sub);
    if (!user) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'User no longer exists');
    }
    const body: MeResponse = { user: toPublicUser(user) };
    res.status(200).json(body);
  }),
);
