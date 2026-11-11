// npm run icons: regenerates the app icons from assets/icon.svg and assets/icon-small.svg.
// ELECTRON_RUN_AS_NODE (set by VS Code for its child processes) would stop Electron from drawing, so it is dropped.
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-icons.cjs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
spawn(electron, [script], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0))
