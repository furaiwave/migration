import { startServer } from './server';

// Development entry: the API alone, the client runs under Vite. app-host.ts is the desktop app (desktop/).
// HOST / CLIENT_ORIGINS widen access on purpose, e.g. HOST=0.0.0.0 CLIENT_ORIGINS=http://10.0.0.5:5173
const HOST = process.env.HOST ?? '127.0.0.1'
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:4173,http://127.0.0.1:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

async function bootstrap() {
  const port = Number(process.env.PORT ?? 3000)
  await startServer({ host: HOST, port, origins: CLIENT_ORIGINS })
  console.log(`DBF migration API listening on http://${HOST}:${port} (clients: ${CLIENT_ORIGINS.join(', ')})`)
}
bootstrap();
