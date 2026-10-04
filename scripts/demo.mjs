// npm run demo [-- --live] [-- --build]
//
// Builds (when needed) and starts the production server with the poller inside, on any OS
// (no shell-specific env syntax) and in GitHub Codespaces. Default is DATA_MODE=fixture:
// simulated readings on real BMA stations, always labelled in the UI. --live uses real
// sources; outside Thailand only ThaiWater answers, so SOURCES defaults to thaiwater-* in
// Codespaces. Values already in the environment win over .env (node --env-file semantics).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const live = args.has('--live')
const port = Number(process.env.PORT) || 3000
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
  DATA_DIR: process.env.DATA_DIR || join(root, 'data'),
}
if (inCodespaces) env.PUBLIC_BASE_URL ||= publicUrl
if (live && inCodespaces) env.SOURCES ||= 'thaiwater-canal,thaiwater-wl,thaiwater-rain,thaiwater-road'

/** Newest modification time under `dir` (skips node_modules and dot-directories). */
function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

function needsBuild() {
  const buildId = join(root, '.next', 'BUILD_ID')
  if (args.has('--build') || !existsSync(join(root, '.next', 'standalone', 'server.js')) || !existsSync(buildId)) return true
  const built = statSync(buildId).mtimeMs
  const inputs = ['src', 'public'].map((d) => join(root, d)).filter(existsSync)
  return Math.max(...inputs.map(newestMtime), statSync(join(root, 'package.json')).mtimeMs) > built
}

function portInUse(p) {
  return new Promise((done) => {
    const probe = createServer()
      .once('error', () => done(true))
      .once('listening', () => probe.close(() => done(false)))
      .listen(p, '0.0.0.0')
  })
}

if (await portInUse(port)) {
  console.log(`\nพอร์ต ${port} ถูกใช้อยู่แล้ว — ถ้าเป็น Flood Monitor ที่เปิดไว้ก่อนหน้า เปิดได้ที่ ${publicUrl}\n`)
  process.exit(0)
}

if (needsBuild()) {
  console.log('\n[demo] กำลัง build (ครั้งแรกใช้เวลาประมาณ 1–2 นาที)…\n')
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log(
  `\n  Flood Monitor — ${live ? 'ข้อมูลจริง' : 'ข้อมูลสาธิต (ค่าจำลอง)'}\n` +
    `  เปิด: ${publicUrl}\n` +
    (inCodespaces ? `  (Codespaces: แท็บ PORTS → พอร์ต ${port} → เปิดในเบราว์เซอร์)\n` : '') +
    '  หยุด: Ctrl+C\n',
)

const isWindows = process.platform === 'win32'
const child = spawn(process.execPath, ['--env-file-if-exists=.env', join('.next', 'standalone', 'server.js')], {
  cwd: root,
  env,
  stdio: 'inherit',
  // Own process group on POSIX: Ctrl+C reaches only this script, which forwards it once (a
  // second SIGINT would make the server skip its graceful drain). On Windows the console
  // delivers Ctrl+C to both processes, so it is not forwarded there.
  detached: !isWindows,
})
process.on('SIGINT', () => {
  if (!isWindows) child.kill('SIGINT')
})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGINT' ? 130 : 143)))
