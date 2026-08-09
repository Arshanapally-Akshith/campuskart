import type { NextFunction, Request, Response } from 'express';
import { ErrorCode, type ErrorPayload } from '@campuskart/shared';
import mongoose from 'mongoose';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, ErrorCode.NOT_FOUND, `Route not found: ${req.method} ${req.originalUrl}`));
}

function fromZodError(err: ZodError): AppError {
  const details = err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return new AppError(400, ErrorCode.BAD_REQUEST, 'Validation failed', details);
}

// Express only treats a handler as error middleware if it declares exactly 4 parameters.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError =
    err instanceof AppError
      ? err
      : err instanceof ZodError
        ? fromZodError(err)
        : err instanceof mongoose.Error.CastError
          ? new AppError(400, ErrorCode.BAD_REQUEST, `Invalid ${err.path}: ${String(err.value)}`)
          : new AppError(500, ErrorCode.INTERNAL_ERROR, 'Internal server error');

  const logFields = { err, code: appError.code };
  if (appError.statusCode >= 500) {
    req.log.error(logFields, appError.message);
  } else {
    req.log.warn(logFields, appError.message);
  }

  const payload: ErrorPayload = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
    },
  };
  res.status(appError.statusCode).json(payload);
}
