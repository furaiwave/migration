import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { startServer, type ClientFiles } from './server'

/**
 * Entry for the desktop app (see desktop/): the API and the built web client on one local address,
 * which the app's window then opens. Bundled into desktop/app/server.cjs.
 */

export interface AppHostOptions {
  /** Folder with the client build (vite build with VITE_API_BASE=/). */
  readonly clientDir: string
  /** Kept stable so the page's address, and with it the remembered session, survives restarts. */
  readonly preferredPort: number
  readonly host?: string
}

export interface AppHost {
  readonly url: string
  close(): Promise<void>
}

function clientFromDir(dir: string): ClientFiles {
  const root = path.resolve(dir)
  return (urlPath) => {
    const file = path.resolve(root, '.' + decodeURIComponent(urlPath))
    if (!file.startsWith(root + path.sep)) return undefined
    try {
      return fs.readFileSync(file)
    } catch {
      return undefined
    }
  }
}

/** The port bound by a probe: the given one, a free one for 0, or null when it is taken. */
function probePort(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(null))
    probe.listen(port, host, () => {
      const address = probe.address()
      const bound = typeof address === 'object' && address ? address.port : port
      probe.close(() => resolve(bound))
    })
  })
}

export async function startApp(options: AppHostOptions): Promise<AppHost> {
  const host = options.host ?? '127.0.0.1'
  const port = (await probePort(options.preferredPort, host)) ?? (await probePort(0, host))
  if (port === null) throw new Error('Не вдалося знайти вільний порт.')

  const url = `http://${host}:${port}`
  // The page and the API share one address; localhost is the same server under its other name.
  const origins = [url, `http://localhost:${port}`]
  const app = await startServer({ host, port, origins, client: clientFromDir(options.clientDir), logger: ['error', 'warn'] })
  return { url, close: () => app.close() }
}
