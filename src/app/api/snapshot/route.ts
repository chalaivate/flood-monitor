import { getConfig } from '@/lib/config'
import { isInThailand, isValidLatLng } from '@/lib/geo'
import { placeToSnapshotPlace } from '@/lib/pipeline'
import { lateFetch } from '@/lib/server/context'
import { clientIp, handler, HttpError, json, MSG } from '@/lib/server/http'
import { isPlaceId } from '@/lib/server/places'
import { enforceClientLimit, LIMITS } from '@/lib/server/rate-limit'
import { adHocPlace, loadSnapshot } from '@/lib/server/snapshot'
import { clamp, queryNumber } from '@/lib/server/validation'
import { weatherBudget } from '@/lib/server/weather-cache'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/snapshot?lat=&lng=&label=&r=&n=  |  ?place=<id> → DashboardSnapshot */
export const GET = handler('snapshot', async (req: Request) => {
  enforceClientLimit('snapshot', clientIp(req), LIMITS.snapshot)
  const config = getConfig()
  const store = await getStore()
  const q = new URL(req.url).searchParams

  const placeId = q.get('place')
  let place
  // Every upstream weather request counts against a server-wide budget; ad-hoc
  // coordinates (map browsing) also against their own smaller share of it.
  let budget = weatherBudget('place')
  if (placeId) {
    const stored = isPlaceId(placeId) ? await store.getPlace(placeId) : null
    if (!stored) throw new HttpError(404, MSG.placeNotFound)
    place = placeToSnapshotPlace(stored)
  } else {
    const lat = queryNumber(q, 'lat')
    const lng = queryNumber(q, 'lng')
    if ((lat === undefined) !== (lng === undefined)) throw new HttpError(400, 'กรุณาระบุทั้งละติจูดและลองจิจูด')
    if (lat !== undefined && lng !== undefined) {
      if (!isValidLatLng(lat, lng)) throw new HttpError(400, 'พิกัดไม่ถูกต้อง')
      // Data and alerts cover Thailand only; this also bounds the weather grid cells
      // (and so the upstream calls) a caller can make the server request.
      if (!isInThailand(lat, lng)) throw new HttpError(400, 'ตำแหน่งต้องอยู่ในประเทศไทย')
    }
    const r = queryNumber(q, 'r')
    const n = queryNumber(q, 'n')
    if ((r !== undefined && !Number.isFinite(r)) || (n !== undefined && !Number.isFinite(n))) {
      throw new HttpError(400, 'ค่ารัศมีหรือจำนวนจุดวัดไม่ถูกต้อง')
    }
    place = adHocPlace(config, {
      lat,
      lng,
      label: q.get('label')?.slice(0, 60),
      radiusKm: r === undefined ? undefined : clamp(r, 0.5, 20),
      maxStations: n === undefined ? undefined : Math.round(clamp(n, 1, 8)),
    })
    budget = weatherBudget('adhoc')
  }

  // Weather is looked up by 0.02° grid cell (cachedWeather snaps the coordinates).
  const snapshot = await loadSnapshot(store, config, place, { fetch: lateFetch, weatherBudget: budget })
  return json(snapshot, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } })
})
