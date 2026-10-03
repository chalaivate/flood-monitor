// RainViewer public radar API (https://www.rainviewer.com/api.html). Fetched in the
// browser; tiles are only available up to zoom 7 on the free tier.

export const RAINVIEWER_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json'
export const RAINVIEWER_MAX_NATIVE_ZOOM = 7
export const RAINVIEWER_ATTRIBUTION = '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'

export interface RadarFrame {
  /** Epoch ms of the radar scan. */
  time: number
  /** Leaflet tile URL template. */
  url: string
  nowcast: boolean
}

interface RawFrame {
  time?: unknown
  path?: unknown
}

/**
 * Parse weather-maps.json into frames (oldest first). Colour scheme 2 (universal blue),
 * smoothing on, snow colours on: `{host}{path}/256/{z}/{x}/{y}/2/1_1.png`.
 */
export function parseRainViewer(json: unknown, opts: { includeNowcast?: boolean } = {}): RadarFrame[] {
  if (!json || typeof json !== 'object') return []
  const o = json as { host?: unknown; radar?: { past?: unknown; nowcast?: unknown } }
  const host = typeof o.host === 'string' && /^https:\/\//.test(o.host) ? o.host.replace(/\/$/, '') : null
  if (!host) return []
  const toFrames = (list: unknown, nowcast: boolean): RadarFrame[] =>
    (Array.isArray(list) ? (list as RawFrame[]) : [])
      .filter((f) => typeof f?.time === 'number' && typeof f?.path === 'string' && /^\/[\w/.-]+$/.test(f.path as string))
      .map((f) => ({ time: (f.time as number) * 1000, url: `${host}${f.path as string}/256/{z}/{x}/{y}/2/1_1.png`, nowcast }))
  const frames = [...toFrames(o.radar?.past, false), ...(opts.includeNowcast ? toFrames(o.radar?.nowcast, true) : [])]
  return frames.sort((a, b) => a.time - b.time)
}

let cache: { at: number; frames: RadarFrame[] } | null = null

/** Fetch frames, cached for 5 minutes per page. Throws when unreachable. */
export async function loadRadarFrames(signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<RadarFrame[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.frames
  const res = await fetchImpl(RAINVIEWER_INDEX_URL, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`RainViewer ${res.status}`)
  const frames = parseRainViewer(await res.json())
  if (frames.length === 0) throw new Error('RainViewer: no frames')
  cache = { at: Date.now(), frames }
  return frames
}
