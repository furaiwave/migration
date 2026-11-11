import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

/** Serves the built web client by URL path; undefined when there is no such file. */
export type ClientFiles = (urlPath: string) => Buffer | undefined

export interface ServerOptions {
  readonly host: string
  readonly port: number
  /** Pages allowed to call the API (the Origin header of their requests). */
  readonly origins: readonly string[]
  /** When set, the client is served from the same address as the API. */
  readonly client?: ClientFiles
  readonly logger?: LogLevel[]
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
}

function serveClient(files: ClientFiles) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    // The API lives under /dbf; everything else may be a client file.
    if (req.path === '/dbf' || req.path.startsWith('/dbf/')) return next()
    const urlPath = req.path === '/' ? '/index.html' : req.path
    const body = files(urlPath)
    if (!body) return next()
    const ext = urlPath.slice(urlPath.lastIndexOf('.')).toLowerCase()
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
    // Built assets carry a content hash in their name; the page itself must be fetched fresh.
    res.setHeader('Cache-Control', urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

export async function startServer(options: ServerOptions) {
  const app = await NestFactory.create(AppModule, options.logger ? { logger: options.logger } : {});
  const origins = options.origins

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  )

  // The API takes database passwords and connects wherever it is told, so only the known pages may call it.
  // CORS only hides responses; a plain form POST from another site would still run. Refuse it outright.
  // Requests without an Origin header (curl, scripts on this machine) are not from a web page and pass.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (origin && !origins.includes(origin)) {
      // The client still gets to read why, instead of a bare network error.
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.status(403).json({
        statusCode: 403,
        message: `Бекенд не приймає запити зі сторінки ${origin}. Відкрийте застосунок за адресою ${origins[0]} або додайте цю адресу в CLIENT_ORIGINS і перезапустіть бекенд.`,
      })
      return
    }
    next()
  })
  app.enableCors({ origin: [...origins] })

  if (options.client) app.use(serveClient(options.client))

  await app.listen(options.port, options.host)
  return app
}
