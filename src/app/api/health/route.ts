import { cameraCatalogHealth } from '@/lib/cameras/catalog'
import { getConfig, type AppConfig } from '@/lib/config'
import { META_LAST_ALERTS, META_LAST_INGEST } from '@/lib/pipeline'
import { cctvImageAvailability, cctvImageStats, isUpstreamCameraSource, type CctvImagesOff, type CctvSourceStats } from '@/lib/server/cctv-proxy'
import { json } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { getStore, type Store } from '@/lib/store'
import type { CameraSourceId } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CameraHealth {
  source: CameraSourceId
  /** A catalogue is stored and its last refresh did not fail. */
  ok: boolean
  catalogAt: string | null
  count: number
  lastError: string | null
  /** This server serves stills for the source (else the UI links to the agency page). */
  images: boolean
  /**
   * Why not (null while images is true): 'disabled' (CCTV_IMAGES=0), 'link-only' (catalogue
   * without image references), 'host-unreachable' (this host never got a frame and was turned
   * away; retried later) or 'agency-backoff' (the agency answered 429 / kept refusing).
   */
  imagesReason: CctvImagesOff | null
  /** When the automatic fallback ends (host-unreachable / agency-backoff), ISO; else null. */
  imagesUntil: string | null
  /**
   * Aggregate image-proxy counters for agency sources this host fetches stills for, also while
   * a fallback is on. The remaining hourly budget is reported coarsely on purpose.
   */
  frames1h: (Omit<CctvSourceStats['frames1h'], 'budgetLeft'> & { budget: CctvSourceStats['budget'] }) | null
  lastFrame: CctvSourceStats['lastFrame']
  lastFailure: CctvSourceStats['lastFailure']
}

/** Upstream messages must never carry stream addresses or credentials into a public response. */
function scrubError(msg: string): string {
  return msg
    .split(/\s+/)
    .map((w) => (w.includes('@') || /^\W*(rtsps?|rtmp):/i.test(w) ? '[redacted]' : w))
    .join(' ')
    .slice(0, 200)
}

/** Camera catalogue and image-proxy health. Informational only: never changes `ok` or banners. */
async function cameraHealth(store: Store, config: AppConfig): Promise<CameraHealth[]> {
  const sources = config.enabledCameraSources
  if (sources.length === 0) return []
  try {
    const rows = await cameraCatalogHealth(store, sources)
    return await Promise.all(
      rows.map(async (row): Promise<CameraHealth> => {
        const a = await cctvImageAvailability(config, store, row.source)
        const fetching = a.images || a.reason === 'host-unreachable' || a.reason === 'agency-backoff'
        const stats = fetching && isUpstreamCameraSource(row.source) ? cctvImageStats(row.source) : null
        return {
          source: row.source,
          ok: row.catalogAt !== null && !row.lastError,
          catalogAt: row.catalogAt,
          count: row.count,
          lastError: row.lastError ? scrubError(row.lastError) : null,
          images: a.images,
          imagesReason: a.reason,
          imagesUntil: a.until !== null ? new Date(a.until).toISOString() : null,
          frames1h: stats ? { ok: stats.frames1h.ok, fail: stats.frames1h.fail, refused: stats.frames1h.refused, budget: stats.budget } : null,
          lastFrame: stats?.lastFrame ?? null,
          lastFailure: stats?.lastFailure ?? null,
        }
      }),
    )
  } catch (err) {
    log(`[api] health: camera status unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * GET /api/health → { ok, dataMode, lastIngestAt, lastAlertsAt, sources, ingestStale, cameras }
 * HTTP 503 only when the store itself is unusable (Docker HEALTHCHECK uses the status).
 * `ingestStale` = no ingest within 3 × POLL_MINUTES (the UI shows a banner for that).
 * `cameras` (CCTV catalogues and image-proxy counters) never affects `ok` or the banners.
 */
export async function GET(): Promise<Response> {
  const config = getConfig()
  try {
    const store = await getStore()
    const [lastIngestAt, lastAlertsAt, sources, cameras] = await Promise.all([
      store.getMeta(META_LAST_INGEST),
      store.getMeta(META_LAST_ALERTS),
      store.listSourceHealth(),
      cameraHealth(store, config),
    ])
    const ageMin = lastIngestAt ? (Date.now() - Date.parse(lastIngestAt)) / 60_000 : Number.POSITIVE_INFINITY
    return json({
      ok: true,
      dataMode: config.DATA_MODE,
      store: config.STORE,
      lastIngestAt,
      lastAlertsAt,
      ingestStale: !(ageMin <= config.POLL_MINUTES * 3),
      sources,
      cameras,
    })
  } catch (err) {
    log(`[api] health: store unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return json(
      { ok: false, dataMode: config.DATA_MODE, store: config.STORE, lastIngestAt: null, lastAlertsAt: null, ingestStale: true, sources: [], cameras: [], error: 'ฐานข้อมูลไม่พร้อมใช้งาน' },
      { status: 503 },
    )
  }
}
