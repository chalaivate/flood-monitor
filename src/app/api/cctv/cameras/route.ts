import { getConfig } from '@/lib/config'
import { loadCameraCatalogs } from '@/lib/cameras/catalog'
import { isInThailand, isValidLatLng } from '@/lib/geo'
import { buildCamerasResponse, canServeImages } from '@/lib/server/cctv-proxy'
import { clientIp, handler, HttpError, json } from '@/lib/server/http'
import { enforceClientLimit, LIMITS } from '@/lib/server/rate-limit'
import { clamp, queryNumber } from '@/lib/server/validation'
import { getStore } from '@/lib/store'
import type { CameraSourceId } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cctv/cameras?lat=&lng=&r=&n= → CamerasResponse
 * With lat/lng: cameras within r km (default 3, max 20), nearest first, at most n sites
 * (default 4, max 24; every angle of a chosen site is included) and `nearestOutsideKm`.
 * Without: every camera of the enabled sources (map layer), distanceKm null.
 * `media: 'image'` (with a same-origin imageUrl) only for sources this server fetches stills
 * for; everything else links to the agency page. Cameras never affect status or alerts.
 */
export const GET = handler('cctv cameras', async (req: Request) => {
  enforceClientLimit('cctvCameras', clientIp(req), LIMITS.cctvCameras)
  const config = getConfig()
  const store = await getStore()
  const q = new URL(req.url).searchParams

  const lat = queryNumber(q, 'lat')
  const lng = queryNumber(q, 'lng')
  if ((lat === undefined) !== (lng === undefined)) throw new HttpError(400, 'กรุณาระบุทั้งละติจูดและลองจิจูด')
  if (lat !== undefined && lng !== undefined) {
    if (!isValidLatLng(lat, lng)) throw new HttpError(400, 'พิกัดไม่ถูกต้อง')
    if (!isInThailand(lat, lng)) throw new HttpError(400, 'ตำแหน่งต้องอยู่ในประเทศไทย')
  }
  const r = queryNumber(q, 'r')
  const n = queryNumber(q, 'n')
  if ((r !== undefined && !Number.isFinite(r)) || (n !== undefined && !Number.isFinite(n))) {
    throw new HttpError(400, 'ค่ารัศมีหรือจำนวนกล้องไม่ถูกต้อง')
  }

  const sources = config.enabledCameraSources
  const [catalogs, imageFlags] = await Promise.all([
    sources.length ? loadCameraCatalogs(store, sources) : Promise.resolve([]),
    Promise.all(sources.map(async (s) => [s, await canServeImages(config, store, s)] as const)),
  ])
  const imageSources = new Set<CameraSourceId>(imageFlags.filter(([, ok]) => ok).map(([s]) => s))
  const body = buildCamerasResponse(
    catalogs,
    sources,
    imageSources,
    {
      lat,
      lng,
      radiusKm: r === undefined ? 3 : clamp(r, 0.5, 20),
      maxSites: n === undefined ? 4 : Math.round(clamp(n, 1, 24)),
    },
    new Date(),
  )
  // Short and without stale-while-revalidate: a source that turns link-only must reach the UI quickly.
  return json(body, { headers: { 'Cache-Control': 'public, max-age=30' } })
})
