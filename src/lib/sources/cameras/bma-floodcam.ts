import type { Camera, CameraCatalogResult, CameraRef } from '../../types'
import { BROWSER_UA } from '../http'
import type { CameraCatalogAdapter } from './types'
import { cameraNativeId, cleanName, fetchCatalogJson, labelAngles, pointIn, siteIdFor, type BBox } from './common'

// BMA flood-watch cameras (สำนักการระบายน้ำ กทม., floodbangkok.bangkok.go.th). The list is the
// Directus collection `camera_profile`; its shape is known only from other projects' code
// (UNVERIFIED), so parsing is tolerant: numbers or numeric strings, unknown fields ignored.
// `LiveStream` is an internal stream address that BMA's own /api/proxy turns into a JPEG. It is
// kept only as a server-side ref (never in the public catalogue, logs or relayed payloads).

export const BMA_FLOODCAM_ORIGIN = 'https://floodbangkok.bangkok.go.th'
export const BMA_FLOODCAM_LIST_URL =
  `${BMA_FLOODCAM_ORIGIN}/bkk/dds/services/api/floods/v1/items/camera_profile` +
  '?limit=-1&fields=id,CameraName,LiveStream,Lat,Long,camera_description'
/** No per-camera deep link is known; the site root shows the camera map. */
export const BMA_FLOODCAM_PAGE = `${BMA_FLOODCAM_ORIGIN}/`
export const BMA_FLOODCAM_OWNER = 'สำนักการระบายน้ำ กทม.'

/** Bangkok and its edges; rows outside are data errors. */
export const BANGKOK_BBOX: BBox = { minLat: 13.5, maxLat: 14.1, minLng: 100.2, maxLng: 100.95 }

const MAX_STREAM_LEN = 512
const STREAM_SCHEMES = new Set(['rtsp:', 'rtmp:', 'http:', 'https:'])

/** A LiveStream we would hand to BMA's proxy: bounded, no whitespace, known scheme. */
export function isValidLiveStream(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STREAM_LEN) return false
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return false
  try {
    const u = new URL(v)
    return STREAM_SCHEMES.has(u.protocol) && !!u.hostname
  } catch {
    return false
  }
}

/** Agency code at the start of a name, e.g. "CM3-JJ-70-C2" or "CM5-SL-202-1-C1"; group 2 is the angle. */
const CODE_RE = /^([A-Z]{1,4}\d{0,2}(?:-[A-Z0-9]{1,8}){1,5}?-C(\d{1,2}))(?![A-Za-z0-9])/
/** Trailing "-CAM2" / " - CAM2" / " CAM2". */
const CAM_SUFFIX_RE = /\s*[-–_]?\s*CAM\s*(\d{1,2})\s*$/i

export interface SplitName {
  code: string | null
  /** Display name without the code, the "-CAMn" suffix or list numbering ("1. "); null if nothing is left. */
  name: string | null
  /** Angle number from "-Cn" (or "CAMn" when there is no code). */
  angleNo: number | null
}

/**
 * Split `CameraName` + `camera_description` ("CM3-JJ-70-C2" + "ปากซอยงามวงศ์วาน 62-CAM2", or the
 * whole string in either field) into code, display name and angle number.
 */
export function splitCameraName(cameraName: string | null, description: string | null): SplitName {
  let full: string
  if (cameraName && description) {
    if (description.includes(cameraName)) full = description
    else if (cameraName.includes(description)) full = cameraName
    else full = `${cameraName} ${description}`
  } else {
    full = cameraName ?? description ?? ''
  }
  full = full.replace(/\s+/g, ' ').trim()
  let code: string | null = null
  let angleNo: number | null = null
  let rest = full
  const m = CODE_RE.exec(full)
  if (m) {
    code = m[1]!
    angleNo = Number(m[2])
    rest = full.slice(m[0].length)
  }
  const cam = CAM_SUFFIX_RE.exec(rest)
  if (cam) {
    if (angleNo === null) angleNo = Number(cam[1])
    rest = rest.slice(0, cam.index)
  }
  rest = rest
    .replace(/^[\s\-–_:.,]+/, '')
    .replace(/^\d{1,3}\s*\.\s*/, '') // list numbering "1. " / "41."
    .replace(/^CCTV\s+/i, '')
    .replace(/[\s\-–_:,]+$/, '')
    .trim()
  return { code, name: rest || null, angleNo }
}

// Water-facing words. Most "สะพาน" in this set are footbridges/flyovers over roads, so only
// bridges over a waterway count (they also contain คลอง/แม่น้ำ). Road names that merely contain
// "คลอง" (ถนนคลองเตย, แยกคลองตัน) do not count.
const WATER_RE = /(?<!ถนน|ถ\.|แยก|เขต|ซอย|ซ\.|ตลาด)คลอง|แม่น้ำ|บึง|สถานีสูบ|ประตูระบายน้ำ|ปตร\.|ท่าน้ำ/

/** Best-effort facing from the display name (cameras sit at road sensors unless named otherwise). */
export function facingFromName(name: string): 'water' | 'road' {
  return WATER_RE.test(name) ? 'water' : 'road'
}

/** Parse `{data: [...]}` (or a bare array) from camera_profile. Throws when nothing usable is left. */
export function parseBmaCameraProfile(body: unknown, now: Date): CameraCatalogResult {
  const rows = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) throw new Error('floodbangkok camera_profile: expected {data: [...]}')
  const cameras: Camera[] = []
  const refs: CameraRef[] = []
  const angleNo = new Map<string, number | null>()
  const skipped = { malformed: 0, noStream: 0, outside: 0, duplicate: 0 }
  const seen = new Set<string>()

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.malformed++
      continue
    }
    // Allowlist: read only these fields, never spread the upstream row.
    const r = raw as Record<string, unknown>
    const nativeId = cameraNativeId(r.id)
    if (!nativeId) {
      skipped.malformed++
      continue
    }
    if (!isValidLiveStream(r.LiveStream)) {
      skipped.noStream++
      continue
    }
    const pos = pointIn(r.Lat, r.Long, BANGKOK_BBOX)
    if (!pos) {
      skipped.outside++
      continue
    }
    const id = `bma-floodcam:${nativeId}`
    if (seen.has(id)) {
      skipped.duplicate++
      continue
    }
    seen.add(id)
    const split = splitCameraName(cleanName(r.CameraName), cleanName(r.camera_description))
    angleNo.set(id, split.angleNo)
    cameras.push({
      id,
      source: 'bma-floodcam',
      nativeId,
      siteId: siteIdFor('bma-floodcam', pos.lat, pos.lng),
      name: split.name ?? '',
      code: split.code,
      angle: null,
      owner: BMA_FLOODCAM_OWNER,
      lat: pos.lat,
      lng: pos.lng,
      facing: 'road',
      nearStationIds: [],
      officialUrl: BMA_FLOODCAM_PAGE,
      cadenceMin: null,
    })
    refs.push({ cameraId: id, ref: r.LiveStream })
  }

  // A camera listed by code only borrows the name of another angle at the same spot.
  const siteName = new Map<string, string>()
  for (const c of cameras) if (c.name && !siteName.has(c.siteId)) siteName.set(c.siteId, c.name)
  for (const c of cameras) {
    if (!c.name) c.name = siteName.get(c.siteId) ?? `กล้อง ${c.code ?? c.nativeId}`
    c.facing = facingFromName(c.name)
  }
  labelAngles(cameras, angleNo, (c) => (c.code ?? '').replace(/-C\d{1,2}$/, ''))

  if (cameras.length === 0) throw new Error(`floodbangkok camera_profile: no usable camera in ${rows.length} row(s)`)
  const warnings: string[] = []
  if (skipped.noStream) warnings.push(`skipped ${skipped.noStream} camera row(s) without a usable stream`)
  if (skipped.outside) warnings.push(`skipped ${skipped.outside} camera row(s) outside Bangkok or without coordinates`)
  if (skipped.malformed) warnings.push(`skipped ${skipped.malformed} malformed camera row(s)`)
  if (skipped.duplicate) warnings.push(`skipped ${skipped.duplicate} duplicate camera id(s)`)
  return { source: 'bma-floodcam', fetchedAt: now.toISOString(), cameras, refs, warnings }
}

export const bmaFloodcamSource: CameraCatalogAdapter = {
  id: 'bma-floodcam',
  label: BMA_FLOODCAM_OWNER,
  thaiIpOnly: true,
  refreshHours: 24,
  async fetchCatalog(ctx) {
    // No retries inside one refresh: a failed refresh is retried by the scheduler (backoff
    // from 1 h), and the last good list stays in use meanwhile. No Referer/Origin is sent.
    const body = await fetchCatalogJson(ctx, BMA_FLOODCAM_LIST_URL, { headers: { 'User-Agent': BROWSER_UA } })
    return parseBmaCameraProfile(body, ctx.now)
  },
}
