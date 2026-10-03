import { getConfig } from '@/lib/config'
import { isValidLatLng } from '@/lib/geo'
import { placeToSnapshotPlace } from '@/lib/pipeline'
import { lateFetch } from '@/lib/server/context'
import { handler, HttpError, json, MSG } from '@/lib/server/http'
import { isPlaceId } from '@/lib/server/places'
import { adHocPlace, loadSnapshot } from '@/lib/server/snapshot'
import { clamp, queryNumber } from '@/lib/server/validation'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/snapshot?lat=&lng=&label=&r=&n=  |  ?place=<id> → DashboardSnapshot */
export const GET = handler('snapshot', async (req: Request) => {
  const config = getConfig()
  const store = await getStore()
  const q = new URL(req.url).searchParams

  const placeId = q.get('place')
  let place
  if (placeId) {
    const stored = isPlaceId(placeId) ? await store.getPlace(placeId) : null
    if (!stored) throw new HttpError(404, MSG.placeNotFound)
    place = placeToSnapshotPlace(stored)
  } else {
    const lat = queryNumber(q, 'lat')
    const lng = queryNumber(q, 'lng')
    if ((lat === undefined) !== (lng === undefined)) throw new HttpError(400, 'กรุณาระบุทั้งละติจูดและลองจิจูด')
    if (lat !== undefined && lng !== undefined && !isValidLatLng(lat, lng)) throw new HttpError(400, 'พิกัดไม่ถูกต้อง')
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
  }

  const snapshot = await loadSnapshot(store, config, place, { fetch: lateFetch })
  return json(snapshot, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } })
})
