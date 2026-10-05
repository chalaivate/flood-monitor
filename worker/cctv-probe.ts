// Diagnose why camera stills do not load, from the machine that runs the server:
//   npm run cctv:probe
// 1. Reads the BMA flood-camera list and prints the SHAPE of the stream addresses (host and a
//    path template with camera-specific parts masked — never a full address).
// 2. Asks BMA's frame proxy for a few cameras in a few request forms, and opens the stream
//    address itself, printing status, type, size, first bytes and time.
// 3. Reads the floodbangkok web app's own JavaScript and prints the code around "rtcUrl",
//    "api/proxy", "LiveStream" etc., so we can see how BMA's own page loads a camera.
// Paste the whole output when reporting a problem. Requests are sequential and bounded.
import { BMA_FLOODCAM_LIST_URL, BMA_FLOODCAM_ORIGIN, parseBmaCameraProfile } from '../src/lib/sources/cameras/bma-floodcam'
import { BROWSER_UA } from '../src/lib/sources/http'
import { BMA_FLOODCAM_PROXY } from '../src/lib/server/cctv-proxy'

const PROBE_VERSION = 2
const TIMEOUT_MS = 30_000
const UA = `${BROWSER_UA} (+https://github.com/chalaivate/flood-monitor)`
const MAX_SCRIPTS = 60
const MAX_SCRIPT_BYTES = 15 * 1024 * 1024
const KEYWORDS = ['rtcUrl', 'api/proxy', 'LiveStream', 'camera_profile', 'whep', 'webrtc', 'm3u8', 'snapshot', 'RTCPeerConnection', 'mjpeg']

const hex = (b: Uint8Array) => [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
function kind(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG'
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF') return 'RIFF/WebP'
  const text = new TextDecoder().decode(b.slice(0, 200)).trim()
  if (text.startsWith('#EXTM3U')) return `HLS playlist: ${JSON.stringify(text.slice(0, 120))}`
  if (text.startsWith('<')) return `HTML/markup: ${JSON.stringify(text.slice(0, 100))}`
  if (text.startsWith('{') || text.startsWith('[')) return `JSON: ${JSON.stringify(text.slice(0, 160))}`
  return 'unknown'
}

/** Host plus a path/query template with camera-specific parts masked. */
function shape(addr: string): string {
  try {
    const u = new URL(addr)
    const seg = (s: string) => (/^[a-z_-]{1,16}$/i.test(s) ? s : /^\d+$/.test(s) ? '{n}' : '{x}')
    const path = u.pathname.split('/').map((s) => (s ? seg(s) : s)).join('/')
    const query = [...u.searchParams.keys()].map((k) => `${k}={v}`).join('&')
    return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`
  } catch {
    return '(not a URL)'
  }
}

async function get(url: string, init: RequestInit = {}, maxBytes = 4096): Promise<{ res: Response; body: Uint8Array; ms: number }> {
  const started = Date.now()
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers: { 'User-Agent': UA, ...(init.headers as Record<string, string>) } })
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  }
  const body = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    body.set(c, off)
    off += c.byteLength
  }
  return { res, body, ms: Date.now() - started }
}

function describe(label: string, r: { res: Response; body: Uint8Array; ms: number }): string {
  const loc = r.res.headers.get('location')
  const where = loc ? ` · redirect to ${(() => { try { return shape(new URL(loc, BMA_FLOODCAM_ORIGIN).href) } catch { return '?' } })()}` : ''
  return `  ${label}: HTTP ${r.res.status} · ${r.res.headers.get('content-type') ?? '-'} · ${r.body.byteLength}${r.body.byteLength >= 4096 ? '+' : ''} bytes · ${r.ms} ms · first bytes ${hex(r.body)} (${kind(r.body)})${where}`
}

async function attempt(label: string, url: string, init: RequestInit = {}) {
  try {
    console.log(describe(label, await get(url, init)))
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    console.log(`  ${label}: FAILED: ${e.name} ${e.cause?.code ?? ''} ${e.message}`)
  }
}

async function cameras() {
  const listRes = await fetch(BMA_FLOODCAM_LIST_URL, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  console.log(`[probe] camera list: HTTP ${listRes.status} ${listRes.headers.get('content-type') ?? ''}`)
  if (!listRes.ok) return
  const catalog = parseBmaCameraProfile(await listRes.json(), new Date())
  const refs = new Map(catalog.refs.map((r) => [r.cameraId, r.ref]))
  console.log(`[probe] ${catalog.cameras.length} cameras parsed, ${catalog.warnings.length} warning(s)`)
  const shapes = new Map<string, number>()
  for (const r of catalog.refs) shapes.set(shape(r.ref), (shapes.get(shape(r.ref)) ?? 0) + 1)
  console.log(`[probe] stream address shapes (masked):`)
  for (const [s, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ×${n}  ${s}`)

  for (const cam of catalog.cameras.slice(0, 2)) {
    const ref = refs.get(cam.id)
    if (!ref) continue
    console.log(`\n[probe] camera ${cam.nativeId} "${cam.name}" (${shape(ref)})`)
    const accept = { Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' }
    await attempt('proxy, encoded (what the server sends)', `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}`, { headers: accept })
    await attempt('proxy, not encoded', `${BMA_FLOODCAM_PROXY}?rtcUrl=${ref}`, { headers: accept })
    await attempt('proxy, with floodbangkok Referer (diagnostic only)', `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}`, {
      headers: { ...accept, Referer: `${BMA_FLOODCAM_ORIGIN}/`, Origin: BMA_FLOODCAM_ORIGIN },
    })
    await attempt('stream address itself', ref, { headers: { Accept: '*/*' } })
  }
}

/** Script URLs referenced by a page or a script (same origin only). */
function scriptUrls(text: string, base: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) out.add(m[1]!)
  for (const m of text.matchAll(/["'`](\/?(?:_next|_nuxt|assets|static|js|build)\/[^"'`\s]+?\.js)["'`]/g)) out.add(m[1]!)
  return [...out]
    .map((s) => {
      try {
        return new URL(s, base).href
      } catch {
        return null
      }
    })
    .filter((u): u is string => !!u && new URL(u).origin === BMA_FLOODCAM_ORIGIN)
}

async function webApp() {
  console.log(`\n[probe] floodbangkok web app code (how BMA's own page loads a camera):`)
  const pages = [`${BMA_FLOODCAM_ORIGIN}/`, `${BMA_FLOODCAM_ORIGIN}/cctv`, `${BMA_FLOODCAM_ORIGIN}/camera`]
  const queue: string[] = []
  const seen = new Set<string>()
  const enqueue = (urls: string[]) => {
    for (const u of urls) {
      if (seen.has(u)) continue
      seen.add(u)
      queue.push(u)
    }
  }
  for (const p of pages) {
    try {
      const { res, body } = await get(p, { headers: { Accept: 'text/html' } }, 2 * 1024 * 1024)
      console.log(`  page ${new URL(p).pathname}: HTTP ${res.status} ${res.headers.get('content-type') ?? ''} ${body.byteLength} bytes`)
      if (res.ok) enqueue(scriptUrls(new TextDecoder().decode(body), p))
    } catch (err) {
      console.log(`  page ${new URL(p).pathname}: FAILED ${(err as Error).message}`)
    }
  }
  let bytes = 0
  let files = 0
  const snippets = new Set<string>()
  while (queue.length && files < MAX_SCRIPTS && bytes < MAX_SCRIPT_BYTES) {
    const url = queue.shift()!
    try {
      const { res, body } = await get(url, { headers: { Accept: '*/*' } }, 3 * 1024 * 1024)
      files++
      bytes += body.byteLength
      if (!res.ok) continue
      const text = new TextDecoder().decode(body)
      enqueue(scriptUrls(text, url))
      for (const k of KEYWORDS) {
        let i = text.indexOf(k)
        let hits = 0
        while (i >= 0 && hits < 3) {
          const s = text.slice(Math.max(0, i - 220), i + 260).replace(/\s+/g, ' ')
          snippets.add(`[${new URL(url).pathname.split('/').pop()} · ${k}] …${s}…`)
          hits++
          i = text.indexOf(k, i + k.length)
        }
      }
    } catch {
      // skip unreadable script
    }
  }
  console.log(`  read ${files} script file(s), ${Math.round(bytes / 1024)} KB, ${queue.length} not read`)
  const list = [...snippets].slice(0, 25)
  if (!list.length) console.log('  no camera-related code found in the scripts read')
  for (const s of list) console.log(`\n${s}`)
}

async function main() {
  console.log(`[probe v${PROBE_VERSION}] ${new Date().toISOString()} Node ${process.version}`)
  await cameras()
  await webApp()
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
