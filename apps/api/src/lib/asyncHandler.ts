import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps an async Express handler so rejected promises reach the error handler via `next`. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
