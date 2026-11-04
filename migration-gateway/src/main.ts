import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

// The API takes MySQL passwords and connects wherever it is told, so only the local client may call it.
// HOST / CLIENT_ORIGINS widen that on purpose, e.g. HOST=0.0.0.0 CLIENT_ORIGINS=http://10.0.0.5:5173
const HOST = process.env.HOST ?? '127.0.0.1'
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  )

  // CORS only hides responses; a plain form POST from another site would still run. Refuse it outright.
  // Requests without an Origin header (curl, scripts on this machine) are not from a web page and pass.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (origin && !CLIENT_ORIGINS.includes(origin)) {
      res.status(403).json({ statusCode: 403, message: `Origin not allowed: ${origin}` })
      return
    }
    next()
  })
  app.enableCors({ origin: CLIENT_ORIGINS })

  const port = process.env.PORT ?? 3000
  await app.listen(port, HOST)

  console.log(`DBF migration API listening on http://${HOST}:${port} (clients: ${CLIENT_ORIGINS.join(', ')})`)
}
bootstrap();
