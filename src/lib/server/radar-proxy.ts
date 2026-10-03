import { BMA_RADAR_SOURCES, isBmaRadarSite, type BmaRadarSite } from '../radar'

// Server-side proxy for the BMA weather radar stills. weather.bangkok.go.th only
// answers Thai IPs, so the image is fetched by our (Thai-hosted) server and cached
// briefly; foreign viewers then still see it. Kept gentle: one upstream request per
// site per 4 minutes, shared by all viewers, and failures are cached for a minute.

export type { BmaRadarSite }

export const RADAR_TTL_MS = 4 * 60_000
export const RADAR_FAIL_TTL_MS = 60_000
/** A cached image older than this is not served even when the upstream is down. */
export const RADAR_STALE_MAX_MS = 30 * 60_000
export const RADAR_TIMEOUT_MS = 15_000
const MAX_BYTES = 8 * 1024 * 1024

export const isRadarSite = isBmaRadarSite

/** JPEG files start with FF D8 FF. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

export interface RadarImageData {
  bytes: Uint8Array
  fetchedAt: number
  /** Upstream Last-Modified when present. */
  lastModified: string | null
}

interface Entry {
  image: RadarImageData | null
  error: string | null
  checkedAt: number
  inflight: Promise<void> | null
}

const g = globalThis as typeof globalThis & { __floodRadarCache?: Map<BmaRadarSite, Entry> }
const cache = (g.__floodRadarCache ??= new Map<BmaRadarSite, Entry>())

export function clearRadarCache(): void {
  cache.clear()
}

async function download(site: BmaRadarSite, fetchImpl: typeof fetch): Promise<RadarImageData> {
  const res = await fetchImpl(BMA_RADAR_SOURCES[site], {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; flood-monitor/0.1; +radar proxy)',
      Accept: 'image/jpeg,image/*;q=0.8',
      Referer: 'https://weather.bangkok.go.th/radar/',
    },
    signal: AbortSignal.timeout(RADAR_TIMEOUT_MS),
  })
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined)
    throw new Error(`HTTP ${res.status}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MAX_BYTES) throw new Error('image too large')
  // Cloudflare challenges come back as 200/403 HTML: never pass those through.
  if (!isJpeg(buf)) throw new Error('not a JPEG image')
  return { bytes: buf, fetchedAt: Date.now(), lastModified: res.headers.get('last-modified') }
}

export type RadarResult =
  | { ok: true; image: RadarImageData; stale: boolean }
  | { ok: false; error: string }

/** Latest image for a site, from cache when fresh. */
export async function getRadarImage(site: BmaRadarSite, fetchImpl: typeof fetch, now: () => number = Date.now): Promise<RadarResult> {
  let entry = cache.get(site)
  if (!entry) {
    entry = { image: null, error: null, checkedAt: 0, inflight: null }
    cache.set(site, entry)
  }
  const t = now()
  const fresh = entry.image && t - entry.image.fetchedAt < RADAR_TTL_MS
  const recentlyFailed = entry.error !== null && t - entry.checkedAt < RADAR_FAIL_TTL_MS
  if (!fresh && !recentlyFailed) {
    const e = entry
    e.inflight ??= download(site, fetchImpl)
      .then((image) => {
        e.image = { ...image, fetchedAt: now() }
        e.error = null
      })
      .catch((err: unknown) => {
        e.error = err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.message) : String(err)
      })
      .finally(() => {
        e.checkedAt = now()
        e.inflight = null
      })
    await e.inflight
  }
  const img = entry.image
  if (img && now() - img.fetchedAt < RADAR_TTL_MS) return { ok: true, image: img, stale: false }
  if (img && now() - img.fetchedAt < RADAR_STALE_MAX_MS) return { ok: true, image: img, stale: true }
  return { ok: false, error: entry.error ?? 'unavailable' }
}
