// npm run demo [-- --live] [-- --build]
//
// Builds (when needed) and starts the production server with the poller inside, on any OS
// (no shell-specific env syntax) and in GitHub Codespaces. Default is DATA_MODE=fixture:
// simulated readings on real BMA stations, always labelled in the UI, in a local SQLite file.
// --live uses the real sources; outside Thailand only ThaiWater answers, so SOURCES defaults
// to thaiwater-* in Codespaces. PORT, DATA_DIR, SOURCES and PUBLIC_BASE_URL come from the
// environment, then .env, then the defaults below.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const isWindows = process.platform === 'win32'
const argv = process.argv.slice(2)
// `npm run demo --live` (without `--`) reaches us as npm_config_live, not as an argument.
const flag = (name) => argv.includes(`--${name}`) || process.env[`npm_config_${name}`] === 'true'
const live = flag('live')
const forceBuild = flag('build')
for (const a of argv) if (a !== '--live' && a !== '--build') console.warn(`[demo] ไม่รู้จักตัวเลือก ${a} (ใช้ได้: --live, --build)`)

const envFile = join(root, '.env')
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
const setting = (key) => process.env[key] || dotenv[key] || undefined

const port = Number(setting('PORT') ?? 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[demo] PORT=${setting('PORT')} ใช้ไม่ได้ (ต้องเป็น 1–65535)`)
  process.exit(1)
}
const inCodespaces = process.env.CODESPACES === 'true' && !!process.env.CODESPACE_NAME
const publicUrl = inCodespaces
  ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`
  : `http://localhost:${port}`

const env = {
  ...process.env,
  PORT: String(port),
  // Docker and Codespaces set HOSTNAME to the container name; the server must listen on all interfaces.
  HOSTNAME: process.env.DEMO_HOST || '0.0.0.0',
  DATA_MODE: live ? 'live' : 'fixture',
  EMBEDDED_WORKER: '1',
  NEXT_MANUAL_SIG_HANDLE: 'true',
  // Absolute, so config.ts never has to guess a base directory.
  DATA_DIR: resolve(root, setting('DATA_DIR') ?? 'data'),
}
// Simulated data must never reach a shared database (config refuses fixture + supabase).
if (!live) env.STORE = 'sqlite'
const publicBase = setting('PUBLIC_BASE_URL') ?? (inCodespaces ? publicUrl : undefined)
if (publicBase) env.PUBLIC_BASE_URL = publicBase
const sources = setting('SOURCES') ?? (live && inCodespaces ? 'thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road' : undefined)
if (sources) env.SOURCES = sources

/** Newest modification time under `dir`, including directory entries (catches deleted files). */
function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

const BUILD_INPUTS = ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs']

function needsBuild() {
  const buildId = join(root, '.next', 'BUILD_ID')
  if (forceBuild || !existsSync(join(root, '.next', 'standalone', 'server.js')) || !existsSync(buildId)) return true
  const built = statSync(buildId).mtimeMs
  const inputs = BUILD_INPUTS.map((p) => join(root, p)).filter(existsSync)
  return Math.max(...inputs.map((p) => (statSync(p).isDirectory() ? newestMtime(p) : statSync(p).mtimeMs))) > built
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

/** What answers on the port: 'ours' (Flood Monitor), 'other', or null (free). */
async function portOwner(p) {
  try {
    const res = await fetch(`http://localhost:${p}/api/health`, { signal: AbortSignal.timeout(3000) })
    const body = await res.json().catch(() => null)
    return body && typeof body === 'object' && 'dataMode' in body ? 'ours' : 'other'
  } catch {
    // Nothing answered HTTP; something may still hold the port.
    return new Promise((done) => {
      const probe = createServer()
        .once('error', () => done('other'))
        .once('listening', () => probe.close(() => done(null)))
        .listen(p, '0.0.0.0')
    })
  }
}

const owner = await portOwner(port)
if (owner === 'ours') {
  console.log(`\nFlood Monitor เปิดอยู่แล้วที่พอร์ต ${port} — ${publicUrl}\n`)
  process.exit(0)
}
if (owner === 'other') {
  console.error(
    `\n[demo] พอร์ต ${port} ถูกโปรแกรมอื่นใช้อยู่ — เลือกพอร์ตอื่น เช่น\n` +
      '  macOS/Linux:  PORT=3001 npm run demo\n' +
      '  Windows cmd:  set PORT=3001&& npm run demo\n' +
      '  PowerShell:   $env:PORT=3001; npm run demo\n' +
      '  หรือใส่ PORT=3001 ในไฟล์ .env\n',
  )
  process.exit(1)
}

if (needsBuild()) {
  console.log('\n[demo] กำลัง build (ครั้งแรกใช้เวลาประมาณ 1–2 นาที)…\n')
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
  else run('npm run build', [], { shell: true })
}
// The standalone server needs public/ and .next/static next to it. postbuild copies them, but
// npm skips it with ignore-scripts and `npx next build` never runs it: copy on every start.
run(process.execPath, [join(root, 'scripts', 'standalone-assets.mjs')])

console.log(
  `\n  Flood Monitor — ${live ? 'ข้อมูลจริง' : 'ข้อมูลสาธิต (ค่าจำลอง)'}\n` +
    `  เปิด: ${publicUrl}\n` +
    (inCodespaces ? `  (Codespaces: แท็บ PORTS → พอร์ต ${port} → เปิดในเบราว์เซอร์)\n` : '') +
    '  หยุด: Ctrl+C\n',
)

const nodeArgs = ['--disable-warning=ExperimentalWarning']
if (existsSync(envFile)) nodeArgs.push('--env-file=.env')
const child = spawn(process.execPath, [...nodeArgs, join('.next', 'standalone', 'server.js')], {
  cwd: root,
  env,
  // Codespaces counts terminal output as activity: the routine per-cycle lines are hidden there
  // so an idle codespace still times out instead of running to its 12-hour limit.
  stdio: inCodespaces ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  // Own process group on POSIX: Ctrl+C reaches only this script, which forwards it once.
  // On Windows the console delivers Ctrl+C to both processes, so it is not forwarded there.
  detached: !isWindows,
})

if (inCodespaces && child.stdout) {
  const routine = /\] (\[ingest\] [\w-]+: \d+ stations|cycle done in .* 0 alert\(s\))/
  let cycles = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (/\] cycle done in /.test(line) && ++cycles === 1) {
      console.log(line)
      console.log('[demo] ต่อจากนี้ซ่อน log รอบดึงข้อมูลปกติ เพื่อให้ Codespace หยุดเองเมื่อไม่มีการใช้งาน')
      return
    }
    if (cycles > 0 && routine.test(line)) return
    console.log(line)
  })
}

// A second signal within a second is the same keypress delivered twice (e.g. npm with a bash
// script shell): forward it once so the server can drain. A later one still forces the exit.
let lastSignalAt = 0
const forward = (sig) => {
  const now = Date.now()
  if (now - lastSignalAt < 1000) return
  lastSignalAt = now
  child.kill(sig)
}
process.on('SIGINT', () => {
  if (!isWindows) forward('SIGINT')
})
process.on('SIGTERM', () => forward('SIGTERM'))
// Closing the terminal (or a dropped SSH session) must not leave a server behind.
process.on('SIGHUP', () => forward('SIGTERM'))
process.on('exit', () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
})
child.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGINT' ? 130 : 143)))
