// Diagnose why camera stills do not load, from the machine that runs the server:
//   npm run cctv:probe
// 1. Reads the BMA flood-camera list and prints the SHAPE of the stream addresses (host and a
//    path template with camera-specific parts masked — never a full address).
// 2. Asks BMA's frame proxy for a few cameras in a few request forms, and opens the stream
//    address itself, printing status, type, size, first bytes and time.
// 3. Checks the DWR river cameras and the DDS canal cameras through the app's own proxy code.
// 4. With --web: reads the floodbangkok web app's own JavaScript and prints the code around
//    "rtcUrl", "api/proxy", "LiveStream" etc. (how BMA's own page loads a camera).
// Paste the whole output when reporting a problem. Requests are sequential and bounded.
import { BMA_FLOODCAM_LIST_URL, BMA_FLOODCAM_ORIGIN, parseBmaCameraProfile } from '../src/lib/sources/cameras/bma-floodcam'
import { BROWSER_UA } from '../src/lib/sources/http'
import { BMA_FLOODCAM_PROXY, cctvImageStats, getCctvImage, type UpstreamCameraSource } from '../src/lib/server/cctv-proxy'
import { DWR_LIST_URL } from '../src/lib/sources/cameras/dwr'

const PROBE_VERSION = 3
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

  // A browser session on BMA's own site (cookies), to see whether the proxy needs one.
  let cookie = ''
  try {
    const home = await fetch(`${BMA_FLOODCAM_ORIGIN}/`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    await home.arrayBuffer()
    cookie = home.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    console.log(`[probe] floodbangkok home: HTTP ${home.status}, ${cookie ? `${cookie.split(';').length} cookie(s)` : 'no cookies'}`)
  } catch (err) {
    console.log(`[probe] floodbangkok home: FAILED ${(err as Error).message}`)
  }

  for (const cam of catalog.cameras.slice(0, 2)) {
    const ref = refs.get(cam.id)
    if (!ref) continue
    console.log(`\n[probe] camera ${cam.nativeId} "${cam.name}" (${shape(ref)})`)
    const img = { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
    const url = `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}&timestamp=${Date.now()}`
    await attempt('proxy exactly like BMA\'s page, no session', url, { headers: img })
    if (cookie) {
      await attempt('proxy exactly like BMA\'s page, with its session + Referer (diagnostic only)', url, {
        headers: { ...img, Cookie: cookie, Referer: `${BMA_FLOODCAM_ORIGIN}/` },
      })
    }
    await appPath('bma-floodcam', cam.id, ref)
  }
}

/** What the app's own image proxy gets for a camera (same code the server runs). */
async function appPath(source: UpstreamCameraSource, cameraId: string, ref: string) {
  const out = await getCctvImage(source, cameraId, ref, { fetch })
  if (out.ok) {
    const f = out.frame
    console.log(`  app proxy: OK · ${f.type} · ${f.width ?? '?'}×${f.height ?? '?'} px · ${Math.round(f.bytes.byteLength / 1024)} KB${f.capturedAt ? ` · captured ${f.capturedAt}` : ''}`)
  } else {
    console.log(`  app proxy: ${out.failure} · last failure: ${cctvImageStats(source).lastFailure?.reason ?? '-'}`)
  }
}

/** DWR river cameras: list, then the app's own proxy for two stations. */
async function dwr() {
  console.log(`\n[probe] DWR river cameras (telemetry.dwr.go.th):`)
  try {
    const res = await fetch(DWR_LIST_URL, {
      method: 'POST',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paginate: { page: 1, pageSize: 30, orders: [] }, search: {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    console.log(`  list: HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`)
    if (!res.ok) return
    const body = (await res.json()) as { value?: { results?: { entity?: { id?: unknown; stationCode?: unknown; cctvOnline?: unknown } }[] } }
    const rows = (body.value?.results ?? []).map((r) => r.entity ?? {}).filter((e) => typeof e.id === 'string' && typeof e.stationCode === 'string')
    console.log(`  ${rows.length} camera rows on page 1, ${rows.filter((e) => e.cctvOnline).length} marked online`)
    for (const e of rows.filter((x) => x.cctvOnline).slice(0, 2)) {
      console.log(`  station ${String(e.stationCode)}:`)
      await appPath('dwr-cctv', `dwr-cctv:${String(e.stationCode)}`, String(e.id))
    }
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`)
  }
}

/** The 6 DDS canal water-level cameras (dds.bangkok.go.th/cctv.php), image path unverified. */
async function dds() {
  console.log(`\n[probe] DDS canal water-level cameras (dds.bangkok.go.th):`)
  for (const n of [1, 2]) await attempt(`cctv${n}.jpg`, `https://dds.bangkok.go.th/cctv-image/cctv${n}.jpg?t=${Date.now()}`, { headers: { Accept: 'image/*' } })
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
  await dwr()
  await dds()
  if (process.argv.includes('--web')) await webApp()
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
