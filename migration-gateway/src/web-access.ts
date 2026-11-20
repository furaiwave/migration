import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export interface WebAccess {
  readonly user: string;
  readonly password: string;
}

export function webAccess(credentials: WebAccess) {
  // Fixed-length digests avoid leaking which part of the credentials failed.
  const expected = createHash('sha256')
    .update(credentials.user + ':' + credentials.password)
    .digest();
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      req.path === '/healthz'
    ) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ status: 'ok' });
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (/^Basic [A-Za-z0-9+/]+=*$/i.test(auth) && auth.length <= 16384) {
      const received = createHash('sha256')
        .update(Buffer.from(auth.slice(6), 'base64'))
        .digest();
      if (timingSafeEqual(expected, received)) {
        if (req.path === '/dbf' || req.path.startsWith('/dbf/'))
          res.setHeader('Cache-Control', 'no-store');
        next();
        return;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'WWW-Authenticate',
      'Basic realm="Data Migrator", charset="UTF-8"',
    );
    res
      .status(401)
      .json({ statusCode: 401, message: 'Authentication required' });
  };
}
