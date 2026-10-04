import { getConfig } from '@/lib/config'
import { META_LAST_INGEST, runAlerts, storeSourceResult } from '@/lib/pipeline'
import { hasBearerSecret } from '@/lib/server/auth'
import { runAfterResponse } from '@/lib/server/background'
import { serverDeps } from '@/lib/server/context'
import { handler, json, jsonError, readJson } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { pruneOldReadings } from '@/lib/server/poller'
import { IngestPayloadSchema } from '@/lib/server/validation'
import type { SourceFetchResult } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Alerts and pruning run after the response (Next.js after()), inside this same budget. */
export const maxDuration = 300

const MAX_BODY = 25 * 1024 * 1024

/**
 * POST /api/ingest (Authorization: Bearer INGEST_TOKEN) body { results, failures? } → { inserted }
 * Used by `npm run worker -- --relay <url>` on a machine in Thailand. The relay gets its
 * answer as soon as the readings are stored; alert evaluation and delivery (which can
 * take a while with many channels) run after the response so the relay never times out
 * and re-posts. `alerts` in the response is 'scheduled' or null (RUN_ALERTS=0 / no results).
 * Readings older than HISTORY_HOURS are pruned after every accepted ingest, so a server
 * that only receives relayed data (no poller, no cron) stays bounded too.
 */
export const POST = handler('ingest', async (req: Request) => {
  const config = getConfig()
  if (!config.INGEST_TOKEN) return jsonError(503, 'ยังไม่ได้ตั้งค่า INGEST_TOKEN')
  if (!hasBearerSecret(req, config.INGEST_TOKEN)) {
    return jsonError(401, 'ไม่มีสิทธิ์เข้าถึง', { 'WWW-Authenticate': 'Bearer' })
  }
  const payload = IngestPayloadSchema.parse(await readJson(req, MAX_BODY))
  const deps = await serverDeps()
  const { store } = deps
  const now = new Date().toISOString()
  const prevHealth = new Map((await store.listSourceHealth()).map((h) => [h.source, h]))

  let inserted = 0
  const perSource: { source: string; stations: number; readings: number; inserted: number }[] = []
  for (const result of payload.results) {
    const n = await storeSourceResult(store, result as SourceFetchResult)
    inserted += n
    perSource.push({ source: result.source, stations: result.stations.length, readings: result.readings.length, inserted: n })
    let latestObservationAt: string | null = null
    for (const r of result.readings) {
      const t = new Date(r.observedAt).toISOString()
      if (!latestObservationAt || t > latestObservationAt) latestObservationAt = t
    }
    await store.setSourceHealth({
      source: result.source,
      ok: true,
      lastAttemptAt: result.fetchedAt,
      lastSuccessAt: result.fetchedAt,
      error: null,
      stationCount: result.stations.length,
      latestObservationAt,
    })
  }
  for (const f of payload.failures) {
    const prev = prevHealth.get(f.source)
    await store.setSourceHealth({
      source: f.source,
      ok: false,
      lastAttemptAt: f.attemptedAt ?? now,
      lastSuccessAt: prev?.lastSuccessAt ?? null,
      error: f.error,
      stationCount: prev?.stationCount ?? 0,
      latestObservationAt: prev?.latestObservationAt ?? null,
    })
  }
  if (payload.results.length > 0) await store.setMeta(META_LAST_INGEST, now)
  log(`[ingest] relay: ${payload.results.length} result(s), ${payload.failures.length} failure(s), ${inserted} new readings`)

  const runAlertsNow = config.RUN_ALERTS === '1' && payload.results.length > 0
  runAfterResponse('ingest', async () => {
    try {
      if (runAlertsNow) {
        const report = await runAlerts(deps)
        log(`[ingest] alerts: ${report.events.length} event(s) for ${report.places} place(s)`)
      }
    } finally {
      // Even when alerts failed: pruning must not depend on them.
      const pruned = await pruneOldReadings(deps)
      if (pruned > 0) log(`[ingest] pruned ${pruned} reading(s) older than ${config.HISTORY_HOURS} h`)
    }
  })
  return json({ ok: true, inserted, sources: perSource, alerts: runAlertsNow ? 'scheduled' : null })
})
