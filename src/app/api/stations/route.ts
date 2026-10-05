import { getConfig } from '@/lib/config'
import { stationStatus } from '@/lib/engine/status'
import { handler, json } from '@/lib/server/http'
import type { MapStation } from '@/lib/server/public'
import { getStore } from '@/lib/store'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'
import { ensureFreshData } from '@/lib/server/on-demand'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/stations → { generatedAt, stations: MapStation[] } (levels use default thresholds). */
export const GET = handler('stations', async () => {
  const config = getConfig()
  await ensureFreshData()
  const store = await getStore()
  const now = new Date()
  const opts = { now, staleMinutes: config.STALE_MINUTES, freeboard: DEFAULT_FREEBOARD, rain: DEFAULT_RAIN }
  const stations: MapStation[] = (await store.latest()).map(({ station, reading }) => {
    const s = stationStatus(station, reading, opts)
    return {
      id: station.id,
      kind: station.kind,
      source: station.source,
      name: station.name,
      shortName: station.shortName ?? null,
      district: station.district ?? null,
      lat: station.lat,
      lng: station.lng,
      level: s.level,
      stale: s.stale,
      observedAt: reading?.observedAt ?? null,
      waterLevel: reading?.waterLevel ?? null,
      bankLevel: station.bankLevel ?? null,
      freeboard: reading?.freeboard ?? null,
      rain24h: reading?.rain24h ?? null,
      rain1h: reading?.rain1h ?? null,
      roadFloodCm: reading?.roadFloodCm ?? null,
      officialStatus: reading?.officialStatus ?? null,
    }
  })
  return json(
    { generatedAt: now.toISOString(), stations },
    { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' } },
  )
})
