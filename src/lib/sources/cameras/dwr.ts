import type { Camera, CameraCatalogResult, CameraRef } from '../../types'
import { BROWSER_UA, HttpError } from '../http'
import type { SourceContext } from '../types'
import type { CameraCatalogAdapter } from './types'
import { cleanName, fetchCatalogJson, inBox, pointIn, siteIdFor, type BBox } from './common'

// River cameras at DWR telemetry stations (กรมทรัพยากรน้ำ, telemetry.dwr.go.th). The list has no
// coordinates, so each station is looked up by code (~200 ms apart). List rows embed camera
// links with user:pass@… credentials: rows are read through an allowlist, never spread, stored
// or logged. Scope: the central plains (Chao Phraya main stem, Pasak, Tha Chin, Bang Pakong).

export const DWR_ORIGIN = 'https://telemetry.dwr.go.th'
export const DWR_LIST_URL = `${DWR_ORIGIN}/api/public/reportCctv/listPaginate`
export const DWR_PAGE = `${DWR_ORIGIN}/reportCctv`
export const DWR_OWNER = 'กรมทรัพยากรน้ำ'
export const dwrStationUrl = (code: string) => `${DWR_ORIGIN}/api/public/station/getByCode/${encodeURIComponent(code)}`

export const DWR_PAGE_SIZE = 200
const DWR_MAX_PAGES = 5
/** Spacing between station lookups. */
export const DWR_LOOKUP_SPACING_MS = 200
/** Stills arrive about every 15 minutes. */
const DWR_CADENCE_MIN = 15

/**
 * Central-plains provinces (codes 10–19, 24, 60, 61, 72–74): Bangkok and its neighbours, the
 * Chao Phraya main stem upstream to Nakhon Sawan, the Pasak, Tha Chin and Bang Pakong.
 */
export const DWR_PROVINCES: ReadonlySet<string> = new Set([
  'กรุงเทพมหานคร', // 10
  'สมุทรปราการ', // 11
  'นนทบุรี', // 12
  'ปทุมธานี', // 13
  'พระนครศรีอยุธยา', // 14
  'อ่างทอง', // 15
  'ลพบุรี', // 16
  'สิงห์บุรี', // 17
  'ชัยนาท', // 18
  'สระบุรี', // 19
  'ฉะเชิงเทรา', // 24
  'นครสวรรค์', // 60
  'อุทัยธานี', // 61
  'สุพรรณบุรี', // 72
  'นครปฐม', // 73
  'สมุทรสาคร', // 74
])

/** Used only for rows without a province name. */
export const DWR_SCOPE_BBOX: BBox = { minLat: 13.4, maxLat: 16.1, minLng: 99.5, maxLng: 101.3 }

const THAILAND_BBOX: BBox = { minLat: 5.5, maxLat: 20.6, minLng: 97.2, maxLng: 105.8 }
const STATION_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/
const SNAPSHOT_ID_RE = /^[A-Za-z0-9-]{1,64}$/

export interface DwrListItem {
  /** Snapshot id (uuid) used by /api/public/reportCctv/snapshot/{id}. */
  snapshotId: string
  stationCode: string
  nameTh: string | null
  nameEn: string | null
  province: string | null
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** "จ.ปทุมธานี" / "จังหวัด ปทุมธานี" / "กรุงเทพฯ" → canonical province name. */
export function normalizeProvince(v: unknown): string | null {
  const s = cleanName(v)
  if (!s) return null
  const p = s.replace(/^(จังหวัด|จ\.)\s*/, '').trim()
  return /^กรุงเทพ/.test(p) ? 'กรุงเทพมหานคร' : p
}

/** One list row → allowlisted fields only (null when malformed). */
export function parseDwrListItem(row: unknown): DwrListItem | null {
  const r = obj(row)
  const e = obj(r?.entity)
  if (!r || !e) return null
  const snapshotId = typeof e.id === 'string' ? e.id.trim() : ''
  const stationCode = typeof e.stationCode === 'string' ? e.stationCode.trim().toUpperCase() : ''
  if (!SNAPSHOT_ID_RE.test(snapshotId) || !STATION_CODE_RE.test(stationCode)) return null
  return {
    snapshotId,
    stationCode,
    nameTh: cleanName(e.stnNameTh),
    nameEn: cleanName(e.stnNameEn),
    province: normalizeProvince(r.provinceNameTh ?? e.provinceNameTh),
  }
}

/** `{value: {totalCount, results: [...]}}` → items (null entries for malformed rows). */
export function parseDwrListPage(body: unknown): { totalCount: number | null; items: (DwrListItem | null)[] } {
  const value = obj(obj(body)?.value)
  const results = value?.results
  if (!value || !Array.isArray(results)) throw new Error('DWR listPaginate: expected {value: {results: [...]}}')
  const total = typeof value.totalCount === 'number' && Number.isFinite(value.totalCount) ? value.totalCount : null
  return { totalCount: total, items: results.map(parseDwrListItem) }
}

/** getByCode → `value.fullCon.entity.point` ({lat, lon} or GeoJSON), inside Thailand. */
export function parseDwrStationPoint(body: unknown): { lat: number; lng: number } | null {
  const point = obj(obj(obj(obj(obj(body)?.value)?.fullCon)?.entity)?.point)
  if (!point) return null
  if (Array.isArray(point.coordinates)) return pointIn(point.coordinates[1], point.coordinates[0], THAILAND_BBOX)
  return pointIn(point.lat, point.lon ?? point.lng ?? point.long, THAILAND_BBOX)
}

/** true/false by province name; null when the row has none (decided by coordinates). */
export function inDwrScope(item: DwrListItem): boolean | null {
  return item.province ? DWR_PROVINCES.has(item.province) : null
}

const JSON_HEADERS = { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json' }
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Fetch the list (paginated), keep the central plains, look up coordinates one by one. */
export async function fetchDwrCatalog(ctx: SourceContext): Promise<CameraCatalogResult> {
  const sleep = ctx.sleep ?? defaultSleep
  const items: DwrListItem[] = []
  let malformed = 0
  let total: number | null = null
  let rowsSeen = 0
  for (let page = 1; page <= DWR_MAX_PAGES; page++) {
    if (page > 1) await sleep(DWR_LOOKUP_SPACING_MS)
    // `orders` is required: without it the API answers 400.
    const body = await fetchCatalogJson(ctx, DWR_LIST_URL, {
      method: 'POST',
      body: JSON.stringify({ paginate: { page, pageSize: DWR_PAGE_SIZE, orders: [] }, search: {} }),
      headers: JSON_HEADERS,
    })
    const parsed = parseDwrListPage(body)
    total = parsed.totalCount ?? total
    rowsSeen += parsed.items.length
    for (const it of parsed.items) {
      if (it) items.push(it)
      else malformed++
    }
    if (parsed.items.length < DWR_PAGE_SIZE || (total !== null && rowsSeen >= total)) break
  }

  const cameras: Camera[] = []
  const refs: CameraRef[] = []
  const seen = new Map<string, number>()
  let outOfScope = 0
  let noCoords = 0
  let lookupFailed = 0
  let lookups = 0
  for (const item of items) {
    const scope = inDwrScope(item)
    if (scope === false) {
      outOfScope++
      continue
    }
    if (lookups++ > 0) await sleep(DWR_LOOKUP_SPACING_MS)
    let pos: { lat: number; lng: number } | null
    try {
      pos = parseDwrStationPoint(await fetchCatalogJson(ctx, dwrStationUrl(item.stationCode), { headers: { 'User-Agent': BROWSER_UA } }))
    } catch (err) {
      // A refusal means "stop hitting this host"; the last good list stays in use.
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) throw err
      if (ctx.signal?.aborted) throw err
      lookupFailed++
      continue
    }
    if (!pos) {
      noCoords++
      continue
    }
    if (scope === null && !inBox(pos.lat, pos.lng, DWR_SCOPE_BBOX)) {
      outOfScope++
      continue
    }
    const n = (seen.get(item.stationCode) ?? 0) + 1
    seen.set(item.stationCode, n)
    const nativeId = n === 1 ? item.stationCode : `${item.stationCode}-${n}`
    const id = `dwr-cctv:${nativeId}`
    cameras.push({
      id,
      source: 'dwr-cctv',
      nativeId,
      siteId: siteIdFor('dwr-cctv', pos.lat, pos.lng),
      name: item.nameTh ?? item.nameEn ?? `สถานี ${item.stationCode}`,
      code: item.stationCode,
      angle: null,
      owner: DWR_OWNER,
      lat: pos.lat,
      lng: pos.lng,
      facing: 'water',
      nearStationIds: [],
      officialUrl: DWR_PAGE,
      cadenceMin: DWR_CADENCE_MIN,
    })
    refs.push({ cameraId: id, ref: item.snapshotId })
  }
  if (cameras.length === 0) {
    throw new Error(`DWR camera list: no usable camera (${items.length} listed, ${outOfScope} out of scope, ${lookupFailed} lookups failed)`)
  }
  const warnings: string[] = []
  if (malformed) warnings.push(`skipped ${malformed} malformed camera row(s)`)
  if (lookupFailed) warnings.push(`station lookup failed for ${lookupFailed} camera(s)`)
  if (noCoords) warnings.push(`skipped ${noCoords} camera(s) without coordinates`)
  if (total !== null && rowsSeen < total) warnings.push(`list truncated: ${rowsSeen} of ${total} row(s) read`)
  return { source: 'dwr-cctv', fetchedAt: ctx.now.toISOString(), cameras, refs, warnings }
}

export const dwrCctvSource: CameraCatalogAdapter = {
  id: 'dwr-cctv',
  label: DWR_OWNER,
  // Reachability from cloud hosts is unverified (not known to be Thai-only).
  thaiIpOnly: false,
  refreshHours: 24 * 7,
  fetchCatalog: fetchDwrCatalog,
}
