#!/usr/bin/env node
// Concurrent dev runner that avoids concurrently's Windows cmd.exe ENOENT.
// Spawns vite + peerjs directly from node_modules/.bin with shell: false,
// streams their output with colored prefixes, and forwards SIGINT so
// Ctrl+C cleanly stops both children.
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'

const isWin = platform() === 'win32'
const binExt = isWin ? '.cmd' : ''
const binDir = resolve(process.cwd(), 'node_modules', '.bin')

function bin(name) {
  const p = join(binDir, name + binExt)
  if (!existsSync(p)) throw new Error(`binary not found: ${p}`)
  return p
}

const procs = [
  { name: 'vite  ', color: '\x1b[36m', cmd: bin('vite'), args: [] },
  { name: 'signal', color: '\x1b[35m', cmd: bin('peerjs'), args: ['--port', '9000', '--path', '/signal', '--allow_discovery', 'true'] },
]

const children = []
const reset = '\x1b[0m'

function prefix(name, color, line) {
  return `${color}[${name}]${reset} ${line}`
}

function pipe(child, name, color) {
  child.stdout.on('data', (buf) => {
    buf.toString().split(/\r?\n/).forEach((line) => {
      if (line) process.stdout.write(prefix(name, color, line) + '\n')
    })
  })
  child.stderr.on('data', (buf) => {
    buf.toString().split(/\r?\n/).forEach((line) => {
      if (line) process.stderr.write(prefix(name, color, line) + '\n')
    })
  })
}

for (const p of procs) {
  // Windows requires shell:true to exec .cmd / .bat shims (Node 18+
  // hardening). Non-Windows runs the binary directly.
  const child = spawn(p.cmd, p.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: isWin,
    windowsHide: true,
  })
  pipe(child, p.name, p.color)
  child.on('exit', (code) => {
    process.stdout.write(prefix(p.name, p.color, `exited with code ${code}`) + '\n')
    for (const c of children) { if (c !== child && !c.killed) { try { c.kill() } catch {} } }
    process.exit(code ?? 0)
  })
  children.push(child)
}

function shutdown() {
  for (const c of children) { if (!c.killed) { try { c.kill() } catch {} } }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
