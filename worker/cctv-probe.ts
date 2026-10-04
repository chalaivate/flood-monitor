// Diagnose why camera stills do not load, from the machine that runs the server:
//   npm run cctv:probe
// Reads the BMA flood-camera list, then asks BMA's frame proxy for a few cameras with
// different User-Agents and prints what came back (status, type, size, first bytes, time).
// Stream addresses are never printed: only their scheme and length. Paste the output when
// reporting a problem. Makes at most 1 list request and 3 × 3 frame requests.
import { BMA_FLOODCAM_LIST_URL, parseBmaCameraProfile } from '../src/lib/sources/cameras/bma-floodcam'
import { BROWSER_UA } from '../src/lib/sources/http'
import { BMA_FLOODCAM_PROXY } from '../src/lib/server/cctv-proxy'

const TIMEOUT_MS = 30_000
const VARIANTS: [label: string, ua: string][] = [
  ['browser+flood-monitor (what the server sends)', `${BROWSER_UA} (+https://github.com/chalaivate/flood-monitor)`],
  ['plain browser', BROWSER_UA.replace(/ flood-monitor\/[\d.]+$/, '')],
  ['tool only', 'flood-monitor/0.1'],
]

const hex = (b: Uint8Array) => [...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
function kind(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG'
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF') return 'RIFF/WebP'
  const text = new TextDecoder().decode(b.slice(0, 200)).trim().toLowerCase()
  if (text.startsWith('<')) return `HTML/markup: ${JSON.stringify(text.slice(0, 80))}`
  if (text.startsWith('{') || text.startsWith('[')) return `JSON: ${JSON.stringify(text.slice(0, 120))}`
  return 'unknown'
}

async function main() {
  console.log(`[probe] ${new Date().toISOString()} Node ${process.version}`)
  const t0 = Date.now()
  const listRes = await fetch(BMA_FLOODCAM_LIST_URL, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  console.log(`[probe] camera list: HTTP ${listRes.status} ${listRes.headers.get('content-type') ?? ''} in ${Date.now() - t0} ms`)
  if (!listRes.ok) return
  const catalog = parseBmaCameraProfile(await listRes.json(), new Date())
  const refs = new Map(catalog.refs.map((r) => [r.cameraId, r.ref]))
  console.log(`[probe] ${catalog.cameras.length} cameras parsed, ${catalog.warnings.length} warning(s)`)
  const schemes = new Map<string, number>()
  for (const r of catalog.refs) {
    const s = /^([a-z][a-z0-9+.-]*):/i.exec(r.ref)?.[1]?.toLowerCase() ?? '?'
    schemes.set(s, (schemes.get(s) ?? 0) + 1)
  }
  console.log(`[probe] stream address schemes: ${[...schemes].map(([s, n]) => `${s}:// ×${n}`).join(', ')}`)
  for (const cam of catalog.cameras.slice(0, 3)) {
    const ref = refs.get(cam.id)
    if (!ref) continue
    console.log(`\n[probe] camera ${cam.nativeId} "${cam.name}" (stream: ${ref.split(':')[0]}://…, ${ref.length} chars, credentials: ${/\/\/[^/]*@/.test(ref) ? 'yes' : 'no'})`)
    for (const [label, ua] of VARIANTS) {
      const started = Date.now()
      try {
        const res = await fetch(`${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(ref)}`, {
          headers: { 'User-Agent': ua, Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        const body = new Uint8Array(await res.arrayBuffer())
        const loc = res.headers.get('location')
        console.log(
          `  ${label}: HTTP ${res.status} · ${res.headers.get('content-type') ?? '-'} · ${body.byteLength} bytes · ${Date.now() - started} ms` +
            ` · first bytes ${hex(body)} (${kind(body)})` +
            (loc ? ` · redirect to ${(() => { try { return new URL(loc, BMA_FLOODCAM_PROXY).host } catch { return '?' } })()}` : '') +
            ` · server ${res.headers.get('server') ?? '-'}${res.headers.get('cf-ray') ? ' (Cloudflare)' : ''}`,
        )
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } }
        console.log(`  ${label}: FAILED after ${Date.now() - started} ms: ${e.name} ${e.cause?.code ?? ''} ${e.message}`)
      }
    }
  }
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
