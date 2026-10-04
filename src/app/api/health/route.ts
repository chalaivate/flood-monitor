import { getConfig } from '@/lib/config'
import { META_LAST_ALERTS, META_LAST_INGEST } from '@/lib/pipeline'
import { json } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health → { ok, dataMode, lastIngestAt, lastAlertsAt, sources, ingestStale }
 * HTTP 503 only when the store itself is unusable (Docker HEALTHCHECK uses the status).
 * `ingestStale` = no ingest within 3 × POLL_MINUTES (the UI shows a banner for that).
 */
export async function GET(): Promise<Response> {
  const config = getConfig()
  try {
    const store = await getStore()
    const [lastIngestAt, lastAlertsAt, sources] = await Promise.all([
      store.getMeta(META_LAST_INGEST),
      store.getMeta(META_LAST_ALERTS),
      store.listSourceHealth(),
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
    })
  } catch (err) {
    log(`[api] health: store unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return json(
      { ok: false, dataMode: config.DATA_MODE, store: config.STORE, lastIngestAt: null, lastAlertsAt: null, ingestStale: true, sources: [], error: 'ฐานข้อมูลไม่พร้อมใช้งาน' },
      { status: 503 },
    )
  }
}
