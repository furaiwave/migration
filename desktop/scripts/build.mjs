// Prepares desktop/app for Electron: the web client and the API server bundled into one file.
//   npm run build        (then npm start to run it, npm run dist to package it)
// The server is built by tsc (nest build) first: it emits the decorator metadata Nest's injection needs,
// which esbuild cannot; esbuild then only joins the compiled JavaScript with its dependencies.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '..')
const gateway = path.join(root, 'migration-gateway')
const client = path.join(root, 'client')
const out = path.join(desktop, 'app')

function run(command, cwd, env = {}) {
    console.log(`\n> ${command}   (${path.relative(root, cwd)})`)
    const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env } })
    if (result.status !== 0) {
        console.error(`\nКрок не вдався: ${command}`)
        process.exit(result.status ?? 1)
    }
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// 1. Client: the page calls the API on its own address ("/"), not on the dev port.
run('npx tsc -b', client)
run(`npx vite build --outDir "${path.join(out, 'client')}" --emptyOutDir`, client, { VITE_API_BASE: '/' })

// 2. Server.
run('npx nest build', gateway)

// 3. One CommonJS file exporting startApp (src/app-host.ts). Optional integrations that are not
//    installed stay external: Nest and the MongoDB driver load them in try/catch and work without them.
console.log('\n> esbuild migration-gateway/dist/app-host.js')
await esbuild.build({
    entryPoints: [path.join(gateway, 'dist', 'app-host.js')],
    outfile: path.join(out, 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    keepNames: true,
    legalComments: 'none',
    logLevel: 'warning',
    external: [
        'electron',
        '@nestjs/microservices', '@nestjs/microservices/*',
        '@nestjs/websockets', '@nestjs/websockets/*',
        'class-transformer/storage',
        // MongoDB driver: compression, Kerberos, AWS/GCP auth, client-side encryption, SOCKS proxy.
        'kerberos', 'snappy', '@mongodb-js/zstd', 'mongodb-client-encryption',
        '@aws-sdk/credential-providers', 'gcp-metadata', 'socks', 'aws4',
    ],
})

console.log(`\nГотово: ${path.relative(root, out)} (клієнт і server.cjs)`)
