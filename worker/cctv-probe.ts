// Diagnose why camera stills do not load, from the machine that runs the server:
//   npm run cctv:probe            (options after --, e.g. npm run cctv:probe -- --quick)
// 1. BMA floodcam: reads the camera list and prints the SHAPE of the stream addresses (host and
//    a path template with camera-specific parts masked — never a full address) and the rows
//    named "CCTV …"; then asks BMA's frame proxy and the app's own proxy for one camera on each
//    stream host (at most 10 hosts; two cameras per host with --bma). On 2026-10-06 the proxy
//    answered HTTP 500 for both cameras tested, which were on one stream host.
// 2. DWR river cameras: the list, then the app's own proxy for two stations.
// 3. DDS water-level cameras: reads dds.bangkok.go.th/cctv.php and prints its map markers
//    (`L.marker([lat, lon]).bindPopup('CCTV <label> … <img src=…>')`: label, position, image path
//    and distance to the app's row for the same image), every cctv-image/ or cctv/ reference with
//    the text around it, or says that the page no longer lists cameras; reads cctv1..8.jpg under
//    both /cctv-image/ and /cctv/ in full (size, pixels, cache headers, age, hash); asks the app's
//    own proxy for each camera in its table; then, unless --quick or no image came back, waits
//    65 s and reads them again to see which images changed (their refresh cadence).
// 4. now.bangkok.go.th/cctv-flood-data.json: its structure only (keys, value types, URL shapes).
// 5. With --web: reads the floodbangkok web app's own JavaScript and prints the code around
//    "rtcUrl", "api/proxy", "LiveStream" etc. (how BMA's own page loads a camera).
// Ends with one summary line per source. Paste the whole output when reporting a problem.
// Requests are sequential and bounded. Cookies, credentials, full stream addresses, IP hosts and
// query string values are never printed; long tokens in page code are masked.
import { createHash } from 'node:crypto'
import { BMA_FLOODCAM_LIST_URL, BMA_FLOODCAM_ORIGIN, parseBmaCameraProfile } from '../src/lib/sources/cameras/bma-floodcam'
import { DDS_CAMERAS, DDS_CCTV_PAGE, DDS_ORIGIN, ddsCameraRow, ddsCamSource, type DdsCameraRow } from '../src/lib/sources/cameras/dds'
import { BROWSER_UA } from '../src/lib/sources/http'
import { haversineKm } from '../src/lib/geo'
import { BMA_FLOODCAM_PROXY, cctvImageStats, getCctvImage, jpegSize, trimJpeg, type UpstreamCameraSource } from '../src/lib/server/cctv-proxy'
import { DWR_LIST_URL } from '../src/lib/sources/cameras/dwr'
import type { Camera } from '../src/lib/types'

const PROBE_VERSION = 4
const TIMEOUT_MS = 30_000
const UA = `${BROWSER_UA} (+https://github.com/chalaivate/flood-monitor)`
const MAX_SCRIPTS = 60
const MAX_SCRIPT_BYTES = 15 * 1024 * 1024
const KEYWORDS = ['rtcUrl', 'api/proxy', 'LiveStream', 'camera_profile', 'whep', 'webrtc', 'm3u8', 'snapshot', 'RTCPeerConnection', 'mjpeg']
const IMG_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'

/** BMA stream hosts tried (one camera each, two with --bma), the hosts with the most cameras first. */
const BMA_MAX_HOSTS = 10
/** camera_profile rows named "CCTV …" printed. */
const MAX_CCTV_ROWS = 20

/** DDS image numbers tried: the six published cameras and two more, to notice new ones. */
const DDS_TRY_MAX = 8
/** Directories DDS keeps stills in: its own map linked camera 3 under /cctv/, the others under /cctv-image/ (2026-09-28). */
const DDS_IMAGE_DIRS = ['/cctv-image/', '/cctv/'] as const
const DDS_PAGE_MAX_BYTES = 2 * 1024 * 1024
const DDS_IMAGE_MAX_BYTES = 3 * 1024 * 1024
/** Wait before reading the DDS images again (their refresh cadence is unknown). */
const DDS_RECHECK_MS = 65_000
/** Raw HTML read on each side of an image reference when looking for its label. */
const CONTEXT_WINDOW = 1_500
/** Visible text printed on each side of a reference (about 200 characters in all). */
const CONTEXT_CHARS = 100
const MAX_REFS = 24
const MAX_MARKERS = 24
const NOW_CCTV_JSON = 'https://now.bangkok.go.th/cctv-flood-data.json'
const NOW_JSON_MAX_BYTES = 8 * 1024 * 1024
const DAY_MS = 86_400_000

const args = new Set(process.argv.slice(2))
/** One line per source, printed at the end. */
const summary = new Map<string, string>()

const hex = (b: Uint8Array) => [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
function kind(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG'
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF') return 'RIFF/WebP'
  // Error bodies may echo the stream address the proxy was given: mask before printing.
  const text = maskSecrets(new TextDecoder().decode(b.slice(0, 200)).trim())
  if (text.startsWith('#EXTM3U')) return `HLS playlist: ${JSON.stringify(text.slice(0, 120))}`
  if (text.startsWith('<')) return `HTML/markup: ${JSON.stringify(text.slice(0, 100))}`
  if (text.startsWith('{') || text.startsWith('[')) return `JSON: ${JSON.stringify(text.slice(0, 160))}`
  return 'unknown'
}

/** An IPv4 address or a bracketed IPv6 address (a URL's hostname). */
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[\da-f:.]+\])$/i

/** Host plus a path/query template with camera-specific parts masked. */
function shape(addr: string): string {
  try {
    const u = new URL(addr)
    const seg = (s: string) => (/^[a-z_-]{1,16}$/i.test(s) ? s : /^\d+$/.test(s) ? '{n}' : '{x}')
    const path = u.pathname.split('/').map((s) => (s ? seg(s) : s)).join('/')
    const query = [...u.searchParams.keys()].map((k) => `${k}={v}`).join('&')
    // A camera's own IP address is as specific as the full address: mask it too.
    const host = IP_HOST.test(u.hostname) ? `{ip}${u.port ? `:${u.port}` : ''}` : u.host
    return `${u.protocol}//${host}${path}${query ? `?${query}` : ''}`
  } catch {
    return '(not a URL)'
  }
}

/** Query string values replaced by {v} (keys are kept). */
const maskQueries = (s: string) => s.replace(/([?&][\w.%-]+=)[^&#\s"'`<>]+/g, '$1{v}')
/** A run of letters, digits, _ and - that looks like a key or an id (has a digit, or mixed case). */
const looksLikeToken = (t: string) => /\d/.test(t) || (/[a-z]/.test(t) && /[A-Z]/.test(t))

/**
 * Text taken from a page (references, the code around them, labels) made safe to print: query
 * values masked, `user:password@` dropped, IP hosts masked (as in shape()), token-like runs of
 * 12+ characters inside quoted literals masked (keys, stream ids), runs of 16+ with letters and
 * digits masked anywhere (not dates), and any run of 24+ masked. Thai text, dates and short
 * paths such as `cctv-image/cctv1.jpg` are kept.
 */
function maskSecrets(s: string): string {
  // Stream addresses (rtsp, rtmp, srt, ws) are reduced to their shape, like the BMA list.
  return maskQueries(s.replace(/\b(?:rtsps?|rtmps?|srt|wss?):\/\/[^\s"'`<>]+/gi, (u) => shape(u)))
    .replace(/(\/\/)[^\s"'`<>/@]*@/g, '$1')
    .replace(/(\/\/)(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])/gi, '$1{ip}')
    .replace(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g, '{ip}')
    .replace(/(["'`])([^"'`\n]*)\1/g, (_m, q: string, body: string) => `${q}${body.replace(/[\w-]{12,}/g, (t) => (looksLikeToken(t) ? '{token}' : t))}${q}`)
    .replace(/[\w-]{16,}/g, (t) => (/\d/.test(t) && /[a-z]/i.test(t) && !/^\d{4}-\d\d-\d\d/.test(t) ? '{token}' : t))
    .replace(/[\w-]{24,}/g, '{token}')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Got {
  /** The URL asked for (base of a relative Location). */
  url: string
  res: Response
  body: Uint8Array
  ms: number
  /** Reading stopped at the byte cap. */
  truncated: boolean
}

async function get(url: string, init: RequestInit = {}, maxBytes = 4096): Promise<Got> {
  const started = Date.now()
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers: { 'User-Agent': UA, ...(init.headers as Record<string, string>) } })
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) {
        truncated = true
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
  return { url, res, body, ms: Date.now() - started, truncated }
}

function failed(err: unknown): string {
  const e = err as Error & { cause?: { code?: string } }
  return `FAILED: ${e.name} ${e.cause?.code ?? ''} ${e.message}`.replace(/\s+/g, ' ').trim()
}

function redirectNote(r: Got): string {
  const loc = r.res.headers.get('location')
  if (!loc) return ''
  try {
    return ` · redirect to ${shape(new URL(loc, r.url).href)}`
  } catch {
    return ' · redirect to ?'
  }
}

const bytesNote = (r: Got) => `${r.body.byteLength}${r.truncated ? '+' : ''} bytes`

function describe(label: string, r: Got): string {
  return `  ${label}: HTTP ${r.res.status} · ${r.res.headers.get('content-type') ?? '-'} · ${bytesNote(r)} · ${r.ms} ms · first bytes ${hex(r.body)} (${kind(r.body)})${redirectNote(r)}`
}

/** One request, printed; returns a short outcome for the summary. */
async function attempt(label: string, url: string, init: RequestInit = {}): Promise<string> {
  try {
    const r = await get(url, init)
    console.log(describe(label, r))
    return `HTTP ${r.res.status}`
  } catch (err) {
    console.log(`  ${label}: ${failed(err)}`)
    return 'no answer'
  }
}

/** Nearest row of the app's DDS table to a point, with its distance in km. */
function nearestDdsRow(lat: number, lng: number): { row: DdsCameraRow; km: number } | null {
  let best: { row: DdsCameraRow; km: number } | null = null
  for (const row of DDS_CAMERAS) {
    const km = haversineKm(lat, lng, row.lat, row.lng)
    if (!best || km < best.km) best = { row, km }
  }
  return best
}

/**
 * camera_profile rows whose name starts with "CCTV " (DDS's camera 1 is listed there too, at
 * DDS's own pin): id, name, position, and the nearest row of the app's DDS table.
 */
function cctvNamedRows(body: unknown, parsedIds: Set<string>): void {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : []
  const named = (v: unknown): v is string => typeof v === 'string' && /^\s*CCTV\s/i.test(v)
  const hits = rows.filter(isRecord).filter((r) => named(r.CameraName) || named(r.camera_description))
  console.log(`[probe] rows named "CCTV …": ${hits.length}`)
  for (const r of hits.slice(0, MAX_CCTV_ROWS)) {
    const names = [r.CameraName, r.camera_description].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    const name = [...new Set(names.map((v) => clip(maskSecrets(v.replace(/\s+/g, ' ').trim()), 80)))].join(' / ')
    const id = typeof r.id === 'number' || (typeof r.id === 'string' && /^[\w-]{1,32}$/.test(r.id)) ? String(r.id) : '?'
    const lat = Number(r.Lat)
    const lng = Number(r.Long)
    const placed = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
    const near = placed ? nearestDdsRow(lat, lng) : null
    const pos = placed ? ` · ${lat},${lng}${near ? ` · ${near.km.toFixed(1)} km from the app's DDS row ${near.row.n} "${near.row.place}"` : ''}` : ' · no position'
    const listed = parsedIds.has(`bma-floodcam:${id}`) ? '' : " · not in the app's list (no usable stream or outside Bangkok)"
    console.log(`  id ${id}: "${name}"${pos}${listed}`)
  }
  if (hits.length > MAX_CCTV_ROWS) console.log(`  … ${hits.length - MAX_CCTV_ROWS} more`)
}

interface StreamHost {
  /** As printed: the host name, or {ip #k} for an IP address (as specific as a full address). */
  label: string
  cams: { cam: Camera; ref: string }[]
}

/** The listed cameras grouped by the host of their stream address, most cameras first. */
function streamHosts(cameras: Camera[], refs: Map<string, string>): StreamHost[] {
  const hosts = new Map<string, StreamHost>()
  let ips = 0
  for (const cam of cameras) {
    const ref = refs.get(cam.id)
    if (!ref) continue
    let u: URL
    try {
      u = new URL(ref)
    } catch {
      continue
    }
    let h = hosts.get(u.host)
    if (!h) {
      h = { label: IP_HOST.test(u.hostname) ? `{ip #${++ips}}` : u.host, cams: [] }
      hosts.set(u.host, h)
    }
    h.cams.push({ cam, ref })
  }
  return [...hosts.values()].sort((a, b) => b.cams.length - a.cams.length)
}

/**
 * BMA flood cameras: the list, then BMA's proxy and the app's own proxy for one camera on each
 * stream host (two with --bma): a broken host says nothing about the others.
 */
async function bma() {
  const listRes = await fetch(BMA_FLOODCAM_LIST_URL, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  console.log(`[probe] camera list: HTTP ${listRes.status} ${listRes.headers.get('content-type') ?? ''}`)
  if (!listRes.ok) {
    await listRes.body?.cancel().catch(() => undefined)
    summary.set('bma-floodcam', `list HTTP ${listRes.status}`)
    return
  }
  const body: unknown = await listRes.json()
  const catalog = parseBmaCameraProfile(body, new Date())
  const refs = new Map(catalog.refs.map((r) => [r.cameraId, r.ref]))
  console.log(`[probe] ${catalog.cameras.length} cameras parsed, ${catalog.warnings.length} warning(s)`)
  const shapes = new Map<string, number>()
  for (const r of catalog.refs) shapes.set(shape(r.ref), (shapes.get(shape(r.ref)) ?? 0) + 1)
  console.log(`[probe] stream address shapes (masked):`)
  for (const [s, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ×${n}  ${s}`)
  if (shapes.size > 8) console.log(`  … ${shapes.size - 8} more shape(s)`)
  cctvNamedRows(body, new Set(catalog.cameras.map((c) => c.id)))

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

  // On 2026-10-06 BMA's proxy answered HTTP 500 for both cameras tested, both on one stream
  // host: one camera per host shows whether other hosts answer.
  const hosts = streamHosts(catalog.cameras, refs)
  const tested = hosts.slice(0, BMA_MAX_HOSTS)
  const perHost = args.has('--bma') ? 2 : 1
  console.log(
    `[probe] ${hosts.length} stream host(s); asking for ${perHost === 2 ? 'two cameras' : 'one camera'} on ${tested.length < hosts.length ? `each of the ${tested.length} with the most cameras` : 'each'}${perHost === 2 ? '' : ' (--bma: two per host)'}`,
  )
  const statuses = new Map<string, number>()
  const byHost: string[] = []
  let tried = 0
  let appOk = 0
  for (const h of tested) {
    console.log(`\n[probe] stream host ${h.label} (${h.cams.length} camera(s) listed):`)
    const seen: string[] = []
    for (const { cam, ref } of h.cams.slice(0, perHost)) {
      tried++
      console.log(`  camera ${cam.nativeId} "${cam.name}" (${shape(ref)})`)
      const img = { Accept: IMG_ACCEPT }
      const url = `${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}&timestamp=${Date.now()}`
      const st = await attempt('proxy exactly like BMA\'s page, no session', url, { headers: img })
      statuses.set(st, (statuses.get(st) ?? 0) + 1)
      if (cookie) {
        await attempt('proxy exactly like BMA\'s page, with its session + Referer (diagnostic only)', url, {
          headers: { ...img, Cookie: cookie, Referer: `${BMA_FLOODCAM_ORIGIN}/` },
        })
      }
      const ok = await appPath('bma-floodcam', cam.id, ref)
      if (ok) appOk++
      seen.push(`camera ${cam.nativeId}: BMA proxy ${st}, app proxy ${ok ? 'OK' : 'no image'}`)
    }
    byHost.push(`${h.label}: ${seen.join('; ')}`)
  }
  if (byHost.length) {
    console.log(`\n[probe] BMA proxy by stream host (only the cameras asked above; the others were not tried):`)
    for (const line of byHost) console.log(`  ${line}`)
  }
  const observed = [...statuses].map(([s, n]) => `${s} ×${n}`).join(', ') || '-'
  summary.set(
    'bma-floodcam',
    `list HTTP ${listRes.status}, ${catalog.cameras.length} cameras on ${hosts.length} stream host(s) · BMA proxy, ${tried} camera(s) asked on ${tested.length} host(s): ${observed} · app proxy OK ${appOk}/${tried}`,
  )
}

/** What the app's own image proxy gets for a camera (same code the server runs). */
async function appPath(source: UpstreamCameraSource, cameraId: string, ref: string): Promise<boolean> {
  const out = await getCctvImage(source, cameraId, ref, { fetch })
  if (out.ok) {
    const f = out.frame
    console.log(`  app proxy: OK · ${f.type} · ${f.width ?? '?'}×${f.height ?? '?'} px · ${Math.round(f.bytes.byteLength / 1024)} KB${f.capturedAt ? ` · captured ${f.capturedAt}` : ''}`)
    return true
  }
  // After repeated failures the proxy rests the source (as the server would) and sends nothing.
  const resting = out.failure === 'unavailable' ? ' (the proxy is resting this source after repeated failures: no request sent)' : ''
  console.log(`  app proxy: ${out.failure}${resting} · last failure: ${cctvImageStats(source).lastFailure?.reason ?? '-'}`)
  return false
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
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      summary.set('dwr-cctv', `list HTTP ${res.status}`)
      return
    }
    const body = (await res.json()) as { value?: { results?: { entity?: { id?: unknown; stationCode?: unknown; cctvOnline?: unknown } }[] } }
    const rows = (body.value?.results ?? []).map((r) => r.entity ?? {}).filter((e) => typeof e.id === 'string' && typeof e.stationCode === 'string')
    const online = rows.filter((e) => e.cctvOnline)
    console.log(`  ${rows.length} camera rows on page 1, ${online.length} marked online`)
    let ok = 0
    for (const e of online.slice(0, 2)) {
      console.log(`  station ${String(e.stationCode)}:`)
      if (await appPath('dwr-cctv', `dwr-cctv:${String(e.stationCode)}`, String(e.id))) ok++
    }
    summary.set('dwr-cctv', `list HTTP ${res.status}, ${rows.length} rows, ${online.length} online · app proxy OK ${ok}/${Math.min(2, online.length)}`)
  } catch (err) {
    console.log(`  ${failed(err)}`)
    summary.set('dwr-cctv', failed(err))
  }
}

// --- DDS water-level cameras ----------------------------------------------------------------------

/** Charset from the Content-Type header, else from a <meta> tag (older Thai pages use TIS-620). */
function charsetOf(contentType: string | null, body: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader) return fromHeader
  const head = new TextDecoder('latin1').decode(body.subarray(0, 4096))
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
}

/**
 * The WHATWG name of a Thai charset label. TextDecoder knows "tis-620" and "windows-874" but
 * not MySQL's "tis620", "windows874", "x-windows-874" or "cp874", which Thai PHP pages send.
 */
function charsetLabel(charset: string): string {
  return /^(?:tis-?620|windows-?874|x-windows-874|cp-?874)$/i.test(charset) ? 'windows-874' : charset
}

function decodeText(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charsetLabel(charset)).decode(body)
  } catch {
    console.log(`  (charset "${charset}" not supported here, read as UTF-8)`)
    return new TextDecoder().decode(body)
  }
}

/**
 * The page with JSON/JS escapes undone, so PHP json_encode output (`cctv-image\/cctv1.jpg`,
 * `บ…`) is found and printed like plain markup. Only `\/` and non-ASCII `\uXXXX` are
 * decoded: escaped quotes stay escaped, so string literals keep their bounds.
 */
function unescapeJs(s: string): string {
  return s.replace(/\\\//g, '/').replace(/\\u([0-9a-fA-F]{4})/g, (m, h: string) => {
    const code = Number.parseInt(h, 16)
    return code >= 0x80 ? String.fromCharCode(code) : m
  })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntity(m: string, e: string): string {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
  const hexForm = e[1] === 'x' || e[1] === 'X'
  const code = Number.parseInt(e.slice(hexForm ? 2 : 1), hexForm ? 16 : 10)
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
}

/** What a reader sees: no comments, scripts, styles or tags; entities decoded; whitespace collapsed. */
function visible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Drop a tag (or script/style block) cut open at the start of a slice of HTML. */
function cutHead(s: string): string {
  const gt = s.indexOf('>')
  const lt = s.indexOf('<')
  let out = gt >= 0 && (lt < 0 || gt < lt) ? s.slice(gt + 1) : s
  const close = out.search(/<\/(script|style)\s*>/i)
  const open = out.search(/<(script|style)\b/i)
  if (close >= 0 && (open < 0 || close < open)) out = out.slice(close)
  return out
}

/** Drop a tag (or script/style block) cut open at the end of a slice of HTML. */
function cutTail(s: string): string {
  const lt = s.lastIndexOf('<')
  const gt = s.lastIndexOf('>')
  let out = lt > gt ? s.slice(0, lt) : s
  const open = out.search(/<(script|style)\b(?![\s\S]*<\/\1\s*>)/i)
  if (open >= 0) out = out.slice(0, open)
  return out
}

/** Visible text on each side of html[i, end), masked. */
function textAround(html: string, i: number, end: number, chars: number = CONTEXT_CHARS): { before: string; after: string } {
  return {
    before: maskSecrets(visible(cutTail(cutHead(html.slice(Math.max(0, i - CONTEXT_WINDOW), i)))).slice(-chars)),
    after: maskSecrets(visible(cutHead(cutTail(html.slice(end, end + CONTEXT_WINDOW)))).slice(0, chars)),
  }
}

interface ImageRef {
  /** The reference with its URL prefix, masked (maskSecrets). */
  ref: string
  /** Where it sits: "img src", "script", "text"…, and whether it is inside an HTML comment. */
  where: string
  before: string
  after: string
  /** Headings, captions, alt= and title= text near it. */
  near: string[]
}

/**
 * Headings, figure captions and alt/title attributes closest to a reference (↑ before it,
 * ↓ after it), nearest first.
 */
function nearLabels(html: string, i: number, end: number): string[] {
  const from = Math.max(0, i - CONTEXT_WINDOW)
  const raw = html.slice(from, end + CONTEXT_WINDOW)
  const found = new Map<string, number>()
  const add = (pos: number, label: string) => {
    const at = from + pos
    const text = `${at < i ? '↑' : '↓'} ${label}`
    const d = at < i ? i - at : Math.max(0, at - end)
    if (!found.has(text) || found.get(text)! > d) found.set(text, d)
  }
  for (const m of raw.matchAll(/<(h[1-4]|figcaption)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const t = clip(visible(m[2] ?? ''), 120)
    if (t) add(m.index ?? 0, `${m[1]!.toLowerCase()} "${maskSecrets(t)}"`)
  }
  for (const m of raw.matchAll(/\b(alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const t = clip(visible(m[2] ?? m[3] ?? ''), 120)
    if (t) add(m.index ?? 0, `${m[1]!.toLowerCase()}="${maskSecrets(t)}"`)
  }
  return [...found].sort((a, b) => a[1] - b[1]).slice(0, 5).map(([text]) => text)
}

interface Range {
  start: number
  end: number
}

const within = (ranges: Range[], i: number) => ranges.findIndex((r) => i >= r.start && i < r.end)

/**
 * Every `cctv-image/…` or `cctv/…` reference in the page (img src, data-src, JS strings), with
 * its context. References inside an HTML comment are kept but labelled: the page does not show
 * them.
 */
function imageRefs(html: string): { total: number; list: ImageRef[]; scripts: Set<number> } {
  const scriptRanges: Range[] = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => {
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1
    return { start, end: start + (m[1] ?? '').length }
  })
  // Comments outside scripts only: old pages wrap whole scripts in <!-- … --> and still run them.
  const commentRanges: Range[] = [...html.matchAll(/<!--[\s\S]*?(?:-->|$)/g)]
    .map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((r) => within(scriptRanges, r.start) < 0)
  const list: ImageRef[] = []
  const seen = new Set<string>()
  /** Indexes of the script blocks that hold a reference. */
  const scripts = new Set<number>()
  let total = 0
  for (const m of html.matchAll(/\bcctv(?:-image)?\/(?:&amp;|[^"'`\s<>()\\,;])*/gi)) {
    total++
    const i = m.index ?? 0
    const end = i + m[0].length
    const lead = html.slice(Math.max(0, i - 200), i)
    const prefix = /(?:(?:https?:)?\/\/[^\s"'`<>()]*|[\w./-]*)$/.exec(lead)?.[0] ?? ''
    /** Where the reference starts, URL prefix included. */
    const refStart = i - prefix.length
    const ref = maskSecrets(clip(prefix, 80) + m[0].replaceAll('&amp;', '&'))
    const inScript = within(scriptRanges, i)
    let where: string
    let before: string
    let after: string
    if (inScript >= 0) {
      // Code, not visible text: the label may sit in the same JS object or call. The code is
      // masked with a marker in the reference's place, from the start of its line, so quoted
      // literals pair up as they do in the script.
      scripts.add(inScript)
      const r = scriptRanges[inScript]!
      const from = Math.max(r.start, html.lastIndexOf('\n', Math.max(0, refStart - 400)) + 1, refStart - 20_000)
      const code = maskSecrets(`${html.slice(from, refStart)}\u0000${html.slice(end, Math.min(r.end, end + 400))}`)
      const k = code.indexOf('\u0000')
      where = 'script'
      before = code.slice(0, k).replace(/\s+/g, ' ').slice(-CONTEXT_CHARS - 50)
      after = code.slice(k + 1).replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS + 50)
    } else {
      const attr = /([\w:-]+)\s*=\s*["']?[^"'\s<>]*$/.exec(lead)
      const tagOpen = lead.lastIndexOf('<') > lead.lastIndexOf('>')
      const tag = /<([\w-]+)[^<]*$/.exec(lead)?.[1]
      where = tagOpen && attr ? `${tag?.toLowerCase() ?? '?'} ${attr[1]!.toLowerCase()}` : /url\(\s*["']?[^"')]*$/.test(lead) ? 'css url()' : 'text'
      ;({ before, after } = textAround(html, refStart, end))
    }
    if (within(commentRanges, i) >= 0) where += ', inside an HTML comment (not shown on the page)'
    const near = nearLabels(html, i, end)
    const key = `${ref}|${where}|${before}|${after}`
    if (seen.has(key) || list.length >= MAX_REFS) continue
    seen.add(key)
    list.push({ ref, where, before, after, near })
  }
  return { total, list, scripts: new Set([...scripts].map((k) => scriptRanges[k]!.start)) }
}

/** Thai string literals in a script block (camera labels kept in a JS list). */
function thaiStrings(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/["'`]([^"'`\n]{0,80}[฀-๿][^"'`\n]{0,80})["'`]/g)) out.add(clip(maskSecrets(m[1]!.trim()), 80))
  return [...out].slice(0, 16)
}

/**
 * When the page has no cctv-image/ or cctv/ reference: the images, frames and videos it does
 * show, each with the headings, captions and alt/title text nearest it and the text around it.
 */
function otherMedia(html: string, base: string): void {
  const groups = new Map<string, { n: number; at: string[] }>()
  for (const m of html.matchAll(/<(img|iframe|video|source)\b[^>]*?\b(?:data-)?src\s*=\s*["']([^"']+)["']/gi)) {
    let s: string
    try {
      s = `${m[1]!.toLowerCase()} ${shape(new URL(m[2]!, base).href)}`
    } catch {
      continue
    }
    const g = groups.get(s) ?? { n: 0, at: [] }
    g.n++
    if (g.at.length < 6) {
      const i = m.index ?? 0
      const close = html.indexOf('>', i + m[0].length)
      const end = close >= 0 ? close + 1 : i + m[0].length
      const near = nearLabels(html, i, end).slice(0, 3)
      const { before, after } = textAround(html, i, end, 60)
      g.at.push(`text «…${before} [HERE] ${after}…»${near.length ? ` · near: ${near.join(' · ')}` : ''}`)
    }
    groups.set(s, g)
  }
  console.log(`  its images, frames and videos (masked), each with the text and labels around it:${groups.size ? '' : ' none'}`)
  for (const [s, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`    ×${g.n}  ${s}`)
    for (const line of g.at) console.log(`      ${line}`)
  }
}

/** Same-origin scripts a page loads (shapes only), to tell whether a camera list moved into one. */
function pageScripts(html: string, base: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1]!, base)
      if (u.origin === new URL(base).origin) out.add(shape(u.href))
    } catch {
      // not a URL
    }
  }
  return [...out].slice(0, 10)
}

/** A JS string literal starting at code[i] (its quote), escapes undone; null when there is none or it never ends. */
function stringLiteral(code: string, i: number): string | null {
  const q = code[i]
  if (q !== '"' && q !== "'" && q !== '`') return null
  let out = ''
  for (let k = i + 1; k < Math.min(code.length, i + 4_000); k++) {
    const c = code[k]!
    if (c === q) return out
    if (c !== '\\') {
      out += c
      continue
    }
    const e = code[++k] ?? ''
    const hex4 = code.slice(k + 1, k + 5)
    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex4)) {
      out += String.fromCharCode(Number.parseInt(hex4, 16))
      k += 4
    } else {
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e
    }
  }
  return null
}

interface DdsMarker {
  lat: number
  lng: number
  /** The popup's visible text (DDS: "CCTV <label>"), masked; null when the popup is not a plain string. */
  label: string | null
  /** The popup's <img src> as printed (masked); null when it has none. */
  image: string | null
  /** Its path on DDS's host (compared with the app's table, never printed raw); null when elsewhere. */
  imagePath: string | null
  /** Image number from `cctv<N>.jpg`. */
  n: number | null
}

/**
 * DDS's map markers in the form its page used on 2026-09-28:
 * `L.marker([lat, lon], …).addTo(map).bindPopup('CCTV <label><br><br><img src="<path>" …>')`.
 * A marker's popup is the first `.bindPopup(` after it and before the next `L.marker(`.
 */
function leafletMarkers(page: string): { total: number; markers: DdsMarker[] } {
  const starts = [...page.matchAll(/\bL\.marker\s*\(/g)].map((m) => m.index ?? 0)
  const markers: DdsMarker[] = []
  for (const [k, start] of starts.entries()) {
    const seg = page.slice(start, Math.min(starts[k + 1] ?? page.length, start + 8_000))
    const pos = /^L\.marker\s*\(\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/.exec(seg)
    if (!pos) continue
    const popup = /\.bindPopup\s*\(\s*/.exec(seg)
    const lit = popup ? stringLiteral(seg, popup.index + popup[0].length) : null
    const src = lit === null ? null : (/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(lit)?.[1] ?? null)
    let imagePath: string | null = null
    if (src) {
      try {
        const u = new URL(src, DDS_CCTV_PAGE)
        // By host name: an http:// src on the same host is the same image path.
        if (u.hostname === new URL(DDS_ORIGIN).hostname) imagePath = u.pathname
      } catch {
        // not a URL
      }
    }
    const n = src ? Number(/cctv(\d{1,2})\.jpe?g/i.exec(src)?.[1] ?? Number.NaN) : Number.NaN
    markers.push({
      lat: Number(pos[1]),
      lng: Number(pos[2]),
      label: lit === null ? null : clip(maskSecrets(visible(lit)), 120),
      image: src ? clip(maskSecrets(src), 120) : null,
      imagePath,
      n: Number.isFinite(n) ? n : null,
    })
  }
  return { total: starts.length, markers }
}

/** Each marker against the app's table row with the same image number. */
function printMarkers(found: { total: number; markers: DdsMarker[] }): void {
  const other = found.total - found.markers.length
  console.log(`  map markers: ${found.total} L.marker(…), ${found.markers.length} read as L.marker([lat, lon])${other ? `, ${other} in another form (not read)` : ''}`)
  for (const [k, mk] of found.markers.slice(0, MAX_MARKERS).entries()) {
    const row = mk.n === null ? undefined : ddsCameraRow(String(mk.n))
    let vs: string
    if (!mk.image) vs = 'no image in its popup'
    else if (!row) vs = `no row for image ${mk.n ?? '?'} in the app's table`
    else {
      const km = haversineKm(mk.lat, mk.lng, row.lat, row.lng)
      const path = mk.imagePath === row.imagePath ? 'same image path' : `the app's table uses ${row.imagePath}`
      vs = `${km.toFixed(1)} km from the app's row ${row.n} "${row.place}" (${row.lat},${row.lng}) · ${path}`
    }
    console.log(`  [m${k + 1}] "${mk.label ?? '(popup is not a plain string)'}" · ${mk.lat},${mk.lng} · image ${mk.image ?? '-'} · ${vs}`)
  }
  if (found.markers.length > MAX_MARKERS) console.log(`  … ${found.markers.length - MAX_MARKERS} more`)
}

/** cctv.php: where the cameras are published, with each one's label. Returns a summary fragment. */
async function ddsPage(): Promise<string> {
  let url = DDS_CCTV_PAGE
  let r: Got | null = null
  try {
    // Follow up to two redirects on the same host, printing each answer.
    for (let hop = 0; hop <= 2; hop++) {
      r = await get(url, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'th,en;q=0.8' } }, DDS_PAGE_MAX_BYTES)
      const cookies = r.res.headers.getSetCookie().length
      console.log(`  ${new URL(url).pathname}: HTTP ${r.res.status} · ${r.res.headers.get('content-type') ?? '-'} · ${bytesNote(r)} · ${r.ms} ms${cookies ? ` · sets ${cookies} cookie(s)` : ''}${redirectNote(r)}`)
      const loc = r.res.headers.get('location')
      if (r.res.status < 300 || r.res.status > 399 || !loc) break
      const next = new URL(loc, url)
      if (next.hostname !== new URL(url).hostname) break
      url = next.href
    }
  } catch (err) {
    console.log(`  cctv.php: ${failed(err)}`)
    return 'cctv.php no answer'
  }
  if (!r || !r.res.ok) return `cctv.php HTTP ${r?.res.status ?? '-'}`
  const charset = charsetOf(r.res.headers.get('content-type'), r.body)
  // Everything below reads the page with JSON/JS escapes undone (json_encode output).
  const html = unescapeJs(decodeText(r.body, charset))
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]
  const title = rawTitle ? clip(maskSecrets(visible(rawTitle)), 120) : null
  const label = charsetLabel(charset)
  console.log(`  page: charset ${charset}${label !== charset ? ` (read as ${label})` : ''}${title ? ` · title "${title}"` : ' · no title'}`)

  const count = (re: RegExp) => [...html.matchAll(re)].length
  const has: [string, number][] = [
    ['L.marker', count(/\bL\.marker\s*\(/g)],
    ['bindPopup', count(/\.bindPopup\s*\(/g)],
    ['cctv-image', count(/cctv-image/gi)],
    ['/cctv/', count(/\/cctv\//gi)],
  ]
  console.log(`  page contains: ${has.map(([k, n]) => `${k} ${n ? `yes (×${n})` : 'no'}`).join(' · ')}`)
  if (has.every(([, n]) => n === 0)) {
    console.log(`  cctv.php no longer lists cameras (serves another page): title ${title ? `"${title}"` : '(none)'}`)
    const scripts = pageScripts(html, url)
    if (scripts.length) console.log(`  same-origin scripts it loads (not read): ${scripts.join(' · ')}`)
    otherMedia(html, url)
    return `cctv.php HTTP ${r.res.status}, no camera list (title ${title ? `"${clip(title, 60)}"` : 'none'})`
  }

  const markers = leafletMarkers(html)
  if (markers.total) printMarkers(markers)
  const refs = imageRefs(html)
  console.log(`  image references (cctv-image/ or cctv/): ${refs.total}${refs.list.length ? `, ${refs.list.length} distinct shown` : ''} (text = what a reader sees around it; [HERE] = the reference)`)
  for (const [k, ref] of refs.list.entries()) {
    console.log(`  [${k + 1}] ${ref.where}: ${ref.ref}`)
    console.log(`      text: «…${ref.before} [HERE] ${ref.after}…»`)
    if (ref.near.length) console.log(`      near: ${ref.near.join(' · ')}`)
  }
  for (const start of refs.scripts) {
    const end = html.indexOf('</script', start)
    const strings = thaiStrings(html.slice(start, end < 0 ? undefined : end))
    if (strings.length) console.log(`  Thai strings in the script that holds references: ${strings.map((s) => `"${s}"`).join(' · ')}`)
  }
  if (!refs.total) {
    console.log('  no cctv-image/ or cctv/ reference on the page')
    otherMedia(html, url)
  }
  const rowOf = (m: (typeof markers.markers)[number]) => (m.n === null ? undefined : ddsCameraRow(String(m.n)))
  const mismatched = markers.markers.filter((m) => {
    const row = rowOf(m)
    return row !== undefined && m.imagePath !== row.imagePath
  }).length
  const notInTable = markers.markers.filter((m) => rowOf(m) === undefined).length
  const markerNotes = [
    mismatched ? `${mismatched} with another image path than the app's table` : '',
    notInTable ? `${notInTable} not in the app's table` : '',
  ].filter(Boolean)
  const markerNote = markers.total ? `, ${markers.markers.length} map marker(s)${markerNotes.length ? ` (${markerNotes.join(', ')})` : ''}` : ''
  return `cctv.php HTTP ${r.res.status}${markerNote}, ${refs.total} image reference(s)`
}

interface Shot {
  n: number
  /** Path on DDS_ORIGIN, e.g. /cctv-image/cctv1.jpg. */
  path: string
  got: Got | null
  error: string | null
  /** First 8 hex digits of the body's SHA-1. */
  sha1: string | null
  lastModified: string | null
}

type ImageShot = Shot & { got: Got; sha1: string }

const ddsPath = (dir: string, n: number) => `${dir}cctv${n}.jpg`
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

/** An image answer: HTTP 2xx with a complete JPEG (end marker present), or PNG / WebP bytes, read in full. */
function isImage(s: Shot): s is ImageShot {
  if (!s.got || !s.got.res.ok || s.got.truncated || s.sha1 === null) return false
  const k = kind(s.got.body)
  return k === 'JPEG' ? trimJpeg(s.got.body) !== null : k === 'PNG' || k === 'RIFF/WebP'
}

async function ddsShot(n: number, path: string): Promise<Shot> {
  try {
    const got = await get(`${DDS_ORIGIN}${path}?t=${Date.now()}`, { headers: { Accept: IMG_ACCEPT } }, DDS_IMAGE_MAX_BYTES)
    const sha1 = got.body.byteLength ? createHash('sha1').update(got.body).digest('hex').slice(0, 8) : null
    return { n, path, got, error: null, sha1, lastModified: got.res.headers.get('last-modified') }
  } catch (err) {
    return { n, path, got: null, error: failed(err), sha1: null, lastModified: null }
  }
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 120) return `${s} s`
  if (s < 7200) return `${Math.round(s / 60)} min`
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`
  return `${Math.round(s / 86_400)} d`
}

/** Age of a Last-Modified by the server's own clock (its Date header), else by ours, in ms. */
function ageMs(lastModified: string | null, serverDate: string | null): number | null {
  const t = lastModified ? Date.parse(lastModified) : Number.NaN
  if (!Number.isFinite(t)) return null
  const server = serverDate ? Date.parse(serverDate) : Number.NaN
  return (Number.isFinite(server) ? server : Date.now()) - t
}

/** " (age 38.21 days)", " (age 0.01 days, 14 min)" or " (5 min in the future)". */
function ageNote(lastModified: string | null, serverDate: string | null): string {
  const d = ageMs(lastModified, serverDate)
  if (d === null) return ''
  if (d < 0) return ` (${duration(-d)} in the future)`
  return ` (age ${(d / DAY_MS).toFixed(2)} days${d < DAY_MS ? `, ${duration(d)}` : ''})`
}

function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (kind(b) === 'JPEG') return jpegSize(b)
  if (kind(b) === 'PNG' && b.byteLength > 24) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  return null
}

function printShot(s: Shot): void {
  if (!s.got) {
    console.log(`  ${s.path}: ${s.error}`)
    return
  }
  const { res, body, ms } = s.got
  const h = res.headers
  const k = kind(body)
  const size = imageSize(body)
  const cut = k === 'JPEG' && !s.got.truncated && !trimJpeg(body) ? ' without end marker (cut off?)' : ''
  console.log(
    `  ${s.path}: HTTP ${res.status} · ${h.get('content-type') ?? '-'} · ${bytesNote(s.got)} · ${ms} ms · ${k}${cut}${size ? ` · ${size.width}×${size.height} px` : ''}${s.sha1 ? ` · sha1 ${s.sha1}` : ''}${redirectNote(s.got)}`,
  )
  if (res.ok) {
    console.log(`    Last-Modified ${s.lastModified ?? '-'}${ageNote(s.lastModified, h.get('date'))} · ETag ${h.get('etag') ?? '-'} · Cache-Control ${h.get('cache-control') ?? '-'} · Age ${h.get('age') ?? '-'}`)
  }
}

/** Outcome of a shot that is not an image, for the summary. */
function outcome(s: Shot): string {
  if (!s.got) return 'no answer'
  if (!s.got.res.ok) return `HTTP ${s.got.res.status}`
  if (s.got.truncated) return 'over the size cap'
  const k = kind(s.got.body)
  return k === 'JPEG' ? 'JPEG without end marker' : `not an image (${k.split(':')[0]})`
}

/** "/cctv-image/ 1,2,4; /cctv/ 3" */
function byDir(shots: Shot[]): string {
  const dirs = new Map<string, number[]>()
  for (const s of shots) dirs.set(dirOf(s.path), [...(dirs.get(dirOf(s.path)) ?? []), s.n])
  return [...dirs].map(([d, ns]) => `${d} ${ns.join(',')}`).join('; ')
}

/** cctv1..8.jpg under each directory, read in full; then which path gives an image per number. */
async function ddsImages(): Promise<Shot[]> {
  console.log(`  images cctv1..${DDS_TRY_MAX}.jpg under ${DDS_IMAGE_DIRS.join(' and ')}, each read in full (up to ${DDS_IMAGE_MAX_BYTES / 1024 / 1024} MB):`)
  const shots: Shot[] = []
  let last = 0
  for (let n = 1; n <= DDS_TRY_MAX; n++) {
    for (const dir of DDS_IMAGE_DIRS) {
      const s = await ddsShot(n, ddsPath(dir, n))
      shots.push(s)
      printShot(s)
    }
    last = n
    if (n === 2 && shots.every((x) => !x.got)) {
      console.log('  no answer for cctv1–2 on either path: not trying the others')
      break
    }
  }
  const date = shots.find((s) => s.got?.res.headers.get('date'))?.got?.res.headers.get('date')
  const server = date ? Date.parse(date) : Number.NaN
  if (Number.isFinite(server)) {
    const skew = server - Date.now()
    console.log(`  server clock: ${Math.abs(skew) < 3000 ? 'same as this machine (±3 s)' : `${duration(Math.abs(skew))} ${skew > 0 ? 'ahead of' : 'behind'} this machine`}`)
  }
  const frames = shots.filter(isImage)
  console.log(`  ${frames.length} image(s), ${new Set(frames.map((s) => s.sha1)).size} distinct by hash. Path that gives an image, per number:`)
  for (let n = 1; n <= last; n++) {
    const ok = frames.filter((s) => s.n === n)
    const row = ddsCameraRow(String(n))
    const both = ok.length > 1 ? (new Set(ok.map((s) => s.sha1)).size === 1 ? ' (same image)' : ' (different images)') : ''
    let table = ''
    if (row) table = ok.some((s) => s.path === row.imagePath) ? " · the app's table uses it" : ` · the app's table uses ${row.imagePath}${ok.length ? ', which gave no image' : ''}`
    else if (ok.length) table = " · NOT in the app's table"
    console.log(`    cctv${n}: ${ok.length ? ok.map((s) => s.path).join(' and ') : 'no image on either path'}${both}${table}`)
  }
  return shots
}

function imagesSummary(shots: Shot[]): string {
  const frames = shots.filter(isImage)
  const others = new Map<string, Shot[]>()
  for (const s of shots.filter((x) => !isImage(x))) others.set(outcome(s), [...(others.get(outcome(s)) ?? []), s])
  const rest = [...others].map(([o, list]) => `; ${o}: ${byDir(list)}`).join('')
  const ages = frames.map((s) => ageMs(s.lastModified, s.got.res.headers.get('date'))).filter((a): a is number => a !== null)
  const newest = ages.length ? `, newest Last-Modified ${(Math.min(...ages) / DAY_MS).toFixed(1)} days old` : ''
  const ok = frames.length ? `images OK: ${byDir(frames)} (${new Set(frames.map((s) => s.sha1)).size} distinct${newest})` : 'no image'
  return `${ok}${rest}`
}

/** The app's own image proxy for every camera in its DDS table (the code the server runs, each row's own path). */
async function ddsApp(): Promise<string> {
  const catalog = await ddsCamSource.fetchCatalog({ fetch, now: new Date(), timeoutMs: TIMEOUT_MS })
  const refs = new Map(catalog.refs.map((r) => [r.cameraId, r.ref]))
  console.log(`  the app's table (${catalog.cameras.length} cameras) through the app's own proxy:`)
  let ok = 0
  for (const cam of catalog.cameras) {
    const ref = refs.get(cam.id)
    if (!ref) continue
    const near = cam.nearStationIds.length ? ` · ${cam.nearStationIds.join(', ')}` : ''
    console.log(`  camera ${cam.nativeId} "${cam.name}" (${cam.code} · ${ddsCameraRow(ref)?.imagePath ?? 'no image path'} · table position ${cam.lat},${cam.lng}${near}):`)
    if (await appPath('bma-ddscam', cam.id, ref)) ok++
  }
  return `app proxy OK ${ok}/${catalog.cameras.length}`
}

/**
 * Read the images again after a wait: which ones changed. Per number, the path that gave an
 * image in the first pass, else the table's path.
 */
async function ddsRecheck(first: Shot[]): Promise<string> {
  const targets = new Map<number, string>()
  for (const s of first.filter(isImage)) if (!targets.has(s.n)) targets.set(s.n, s.path)
  for (const r of DDS_CAMERAS) if (!targets.has(r.n)) targets.set(r.n, r.imagePath)
  const list = [...targets].sort((a, b) => a[0] - b[0])
  console.log(`  waiting ${DDS_RECHECK_MS / 1000} s, then reading ${list.map(([, p]) => p).join(', ')} again to see which images change (--quick skips this)…`)
  await new Promise((resolve) => setTimeout(resolve, DDS_RECHECK_MS))
  let changed = 0
  let compared = 0
  for (const [n, path] of list) {
    const before = first.find((s) => s.n === n && s.path === path)
    const after = await ddsShot(n, path)
    if (!isImage(after)) {
      console.log(`  ${path}: now ${outcome(after)}`)
      continue
    }
    if (!before || !isImage(before)) {
      console.log(`  ${path}: an image now (sha1 ${after.sha1}), none before`)
      continue
    }
    compared++
    const same = before.sha1 === after.sha1
    if (!same) changed++
    const lm = before.lastModified === after.lastModified ? `Last-Modified unchanged (${after.lastModified ?? '-'})` : `Last-Modified ${before.lastModified ?? '-'} → ${after.lastModified ?? '-'}`
    console.log(`  ${path}: ${same ? 'same image' : 'CHANGED'} (sha1 ${before.sha1}${same ? '' : ` → ${after.sha1}`}) · ${lm}`)
  }
  return `changed after ${DDS_RECHECK_MS / 1000} s: ${changed}/${compared}`
}

/** The DDS water-level cameras (dds.bangkok.go.th/cctv.php). */
async function dds() {
  console.log(`\n[probe] DDS water-level cameras (dds.bangkok.go.th):`)
  const page = await ddsPage()
  const first = await ddsImages()
  const parts = [page, imagesSummary(first)]
  if (first.every((s) => !s.got)) {
    console.log('  no image request was answered (dds.bangkok.go.th answers Thai IPs only): app proxy and re-check skipped')
  } else {
    parts.push(await ddsApp())
    if (args.has('--quick')) parts.push('re-check skipped (--quick)')
    else if (!first.some(isImage)) {
      console.log('  no image in the first pass: re-check skipped (nothing to compare)')
      parts.push('re-check skipped: no image')
    } else parts.push(await ddsRecheck(first))
  }
  summary.set('bma-ddscam', parts.join(' · '))
}

// --- now.bangkok.go.th camera feed ---------------------------------------------------------------

const isUrl = (v: string) => /^(?:[a-z][\w+.-]*:)?\/\/\S+$/i.test(v)

/** A value's type, never the value itself (URLs as masked shapes). */
function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `array(${v.length})${v.length ? ` of ${typeOf(v[0])}` : ''}`
  if (isRecord(v)) {
    const keys = Object.keys(v)
    return `object{${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}}`
  }
  if (typeof v === 'string') return isUrl(v) ? `url ${shape(v.startsWith('//') ? `https:${v}` : v)}` : 'string'
  return typeof v
}

function printFields(indent: string, obj: Record<string, unknown>): void {
  const entries = Object.entries(obj)
  for (const [k, v] of entries.slice(0, 40)) console.log(`${indent}${k}: ${typeOf(v)}`)
  if (entries.length > 40) console.log(`${indent}… ${entries.length - 40} more`)
}

/** The first item's keys and value types, and the URL shapes over all items. */
function describeItems(name: string, items: unknown[]): void {
  if (!items.length) return
  const first = items[0]
  if (!isRecord(first)) {
    console.log(`  ${name}[0]: ${typeOf(first)}`)
    return
  }
  console.log(`  ${name}[0] (of ${items.length}), keys and value types:`)
  printFields('    ', first)
  const shapes = new Map<string, number>()
  for (const it of items) {
    if (!isRecord(it)) continue
    for (const [k, v] of Object.entries(it)) {
      if (typeof v !== 'string' || !isUrl(v)) continue
      const s = `${k}: ${typeOf(v).slice(4)}`
      shapes.set(s, (shapes.get(s) ?? 0) + 1)
    }
  }
  if (!shapes.size) return
  console.log(`  URL shapes in ${name} (masked):`)
  for (const [s, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ×${n}  ${s}`)
}

/** Prints the structure; returns it in a few words for the summary. */
function describeJson(data: unknown): string {
  if (Array.isArray(data)) {
    console.log(`  top level: array of ${data.length}`)
    describeItems('item', data)
    return `array of ${data.length}`
  }
  if (isRecord(data)) {
    const keys = Object.keys(data)
    console.log(`  top level: object with ${keys.length} key(s):`)
    printFields('    ', data)
    for (const k of keys.filter((x) => Array.isArray(data[x])).slice(0, 3)) describeItems(k, data[k] as unknown[])
    return `object with ${keys.length} key(s)`
  }
  console.log(`  top level: ${typeOf(data)}`)
  return typeOf(data)
}

/** BMA's camera feed on now.bangkok.go.th: its structure only, never values or full URLs. */
async function nowFeed() {
  console.log(`\n[probe] now.bangkok.go.th camera feed (cctv-flood-data.json):`)
  let r: Got
  try {
    r = await get(NOW_CCTV_JSON, { headers: { Accept: 'application/json' } }, NOW_JSON_MAX_BYTES)
  } catch (err) {
    console.log(`  ${failed(err)}`)
    summary.set('now.bangkok.go.th', 'no answer')
    return
  }
  console.log(`  HTTP ${r.res.status} · ${r.res.headers.get('content-type') ?? '-'} · ${bytesNote(r)} · ${r.ms} ms${redirectNote(r)}`)
  if (!r.res.ok) console.log(`  body: ${kind(r.body)}`)
  if (!r.res.ok || r.truncated) {
    summary.set('now.bangkok.go.th', `HTTP ${r.res.status}${r.truncated ? ', over the size cap' : ''}`)
    return
  }
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(r.body).replace(/^﻿/, ''))
  } catch {
    console.log(`  not JSON: ${kind(r.body).split(':')[0]}`)
    summary.set('now.bangkok.go.th', `HTTP ${r.res.status}, not JSON`)
    return
  }
  summary.set('now.bangkok.go.th', `HTTP ${r.res.status}, JSON ${describeJson(data)}`)
}

// --- floodbangkok web app code (--web) ------------------------------------------------------------

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
          snippets.add(`[${new URL(url).pathname.split('/').pop()} · ${k}] …${maskSecrets(s)}…`)
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

/** Runs one section; a failure is printed and noted, and the next section still runs. */
async function section(name: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (err) {
    console.log(`[probe] ${name}: ${failed(err)}`)
    if (!summary.has(name)) summary.set(name, failed(err))
  }
}

async function main() {
  console.log(`[probe v${PROBE_VERSION}] ${new Date().toISOString()} Node ${process.version}`)
  await section('bma-floodcam', bma)
  await section('dwr-cctv', dwr)
  await section('bma-ddscam', dds)
  await section('now.bangkok.go.th', nowFeed)
  if (args.has('--web')) await section('floodbangkok web app', webApp)
  console.log(`\n[probe] summary:`)
  for (const [name, line] of summary) console.log(`  ${name}: ${line}`)
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
