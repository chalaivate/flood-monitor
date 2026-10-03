import type { DashboardSnapshot } from '../types'
import { distanceTh } from '../engine/format'
import { RADIUS_MAX_KM } from './place'

// "Nothing nearby" on the dashboard has three different causes, each with its own advice:
// the radius is too small (expanding helps), the place is outside the area the sources
// cover (expanding cannot help), or no station has recent data at all (an outage).

export type Coverage =
  /** Stations were found; nothing to explain. */
  | { kind: 'ok' }
  /** Server did not report coverage (older API): keep the generic advice. */
  | { kind: 'unknown' }
  /** No station of this kind has recent data anywhere. */
  | { kind: 'no-data' }
  /** Nearest station is reachable with the maximum radius: suggest `radiusKm`. */
  | { kind: 'expand'; nearestKm: number; radiusKm: number }
  /** Nearest station is beyond the maximum radius. */
  | { kind: 'outside'; nearestKm: number }

/** Classify a missing station kind from the nearest distance and the radius already searched. */
export function classifyCoverage(nearestKm: number | null | undefined, searchedKm: number, maxKm = RADIUS_MAX_KM): Coverage {
  if (nearestKm === undefined) return { kind: 'unknown' }
  if (nearestKm === null || !Number.isFinite(nearestKm)) return { kind: 'no-data' }
  if (nearestKm > maxKm) return { kind: 'outside', nearestKm }
  // Round up so the station is inside the new radius, and always grow by at least 1 km.
  const radiusKm = Math.min(maxKm, Math.max(Math.ceil(nearestKm), Math.floor(searchedKm) + 1))
  return { kind: 'expand', nearestKm, radiusKm }
}

/** Water-level coverage of the dashboard place. */
export function waterCoverage(snapshot: Pick<DashboardSnapshot, 'water' | 'coverage' | 'place'>): Coverage {
  if (snapshot.water.length > 0) return { kind: 'ok' }
  return classifyCoverage(snapshot.coverage ? snapshot.coverage.nearestWaterKm : undefined, snapshot.place.radiusKm)
}

/** Rain coverage: rain gauges are searched within max(radius, 15 km) (engine RAIN_MAX_KM). */
export function rainCoverage(snapshot: Pick<DashboardSnapshot, 'rain' | 'coverage' | 'place'>, rainSearchKm = 15): Coverage {
  if (snapshot.rain.length > 0) return { kind: 'ok' }
  return classifyCoverage(snapshot.coverage ? snapshot.coverage.nearestRainKm : undefined, Math.max(snapshot.place.radiusKm, rainSearchKm))
}

/** Distance for coverage messages: whole kilometres once it is far away. */
export function farDistanceTh(km: number): string {
  return km >= 100 ? `${Math.round(km).toLocaleString('th-TH')} กม.` : distanceTh(km)
}

/** One-line Thai explanation for an empty water-level section (chart, gauges). */
export function coverageHintTh(c: Coverage): string {
  switch (c.kind) {
    case 'outside':
      return `สถานีวัดน้ำที่ใกล้ที่สุดอยู่ห่าง ${farDistanceTh(c.nearestKm)} — อยู่นอกพื้นที่ครอบคลุม`
    case 'no-data':
      return 'ขณะนี้ยังไม่มีข้อมูลล่าสุดจากจุดวัดระดับน้ำ ระบบจะแสดงเมื่อแหล่งข้อมูลกลับมา'
    case 'expand':
      return `จุดวัดที่ใกล้ที่สุดอยู่ห่าง ${farDistanceTh(c.nearestKm)} ขยายรัศมีค้นหาเป็น ${c.radiusKm} กม. เพื่อดูกราฟย้อนหลัง`
    default:
      return 'ขยายรัศมีค้นหาเพื่อดูกราฟย้อนหลัง'
  }
}
