// npm start: runs the app from desktop/app (build it first with npm run build).
// ELECTRON_RUN_AS_NODE, which VS Code and other Electron-based tools pass to child processes,
// would start Electron as plain Node without a window, so it is dropped here.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!fs.existsSync(path.join(desktop, 'app', 'server.cjs'))) {
    console.error('Немає зібраного застосунку: спершу виконайте npm run build.')
    process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [desktop, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
