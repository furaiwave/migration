import { webAccess, type WebAccess } from './web-access';
import { NestFactory } from '@nestjs/core';
<<<<<<< HEAD
import type { Server } from 'node:http';
import {
  ValidationPipe,
  type LogLevel,
  type INestApplication,
} from '@nestjs/common';
=======
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import { json } from 'express';
<<<<<<< Updated upstream
=======
>>>>>>> 7320e4d9f774b75e8b0b3cbc1df9cf1ec0650822
>>>>>>> Stashed changes
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

/** Serves the built web client by URL path; undefined when there is no such file. */
export type ClientFiles = (urlPath: string) => Buffer | undefined;

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  /** Pages allowed to call the API (the Origin header of their requests). */
  readonly origins: readonly string[];
  /** When set, the client is served from the same address as the API. */
  readonly client?: ClientFiles;
  readonly access?: WebAccess;
  readonly logger?: LogLevel[];
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function serveClient(files: ClientFiles) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // The API lives under /dbf; everything else may be a client file.
    if (req.path === '/dbf' || req.path.startsWith('/dbf/')) return next();
    const urlPath = req.path === '/' ? '/index.html' : req.path;
    const body = files(urlPath);
    if (!body) return next();
    const ext = urlPath.slice(urlPath.lastIndexOf('.')).toLowerCase();
    res.setHeader(
      'Content-Type',
      CONTENT_TYPES[ext] ?? 'application/octet-stream',
    );
    // Built assets carry a content hash in their name; the page itself must be fetched fresh.
    res.setHeader(
      'Cache-Control',
      urlPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

export async function startServer(options: ServerOptions) {
<<<<<<< Updated upstream
  const app = await NestFactory.create(
=======
<<<<<<< HEAD
  const app = await NestFactory.create<INestApplication<Server>>(
=======
  const app = await NestFactory.create(
>>>>>>> 7320e4d9f774b75e8b0b3cbc1df9cf1ec0650822
>>>>>>> Stashed changes
    AppModule,
    options.logger ? { logger: options.logger } : {},
  );
  app.enableShutdownHooks();
  if (options.access) app.use(webAccess(options.access));
  const origins = options.origins;

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Origin checks prevent cross-site browser actions; web mode also requires authentication.
  // CORS only hides responses; a plain form POST from another site would still run. Refuse it outright.
  // Requests without an Origin header (curl, scripts on this machine) are not from a web page and pass.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      // The client still gets to read why, instead of a bare network error.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.status(403).json({
        statusCode: 403,
        message: `The backend does not accept requests from ${origin}. Open the application at ${origins[0]} or add this address to CLIENT_ORIGINS and restart the backend.`,
      });
      return;
    }
    next();
  });
  app.enableCors({ origin: [...origins] });

  if (options.client) app.use(serveClient(options.client));

<<<<<<< Updated upstream
=======
<<<<<<< HEAD
=======
>>>>>>> Stashed changes
  // SQL scripts have a separate, bounded request budget. Other routes keep their default limit.
  const sqlBodyParser = json({ limit: '512kb' });
  app.use(
    '/dbf/native/query',
    (req: Request, res: Response, next: NextFunction) =>
      sqlBodyParser(req, res, next),
  );

<<<<<<< Updated upstream
=======
>>>>>>> 7320e4d9f774b75e8b0b3cbc1df9cf1ec0650822
>>>>>>> Stashed changes
  await app.listen(options.port, options.host);
  return app;
}
