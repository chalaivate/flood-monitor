import { createHash } from 'node:crypto'
import { haversineKm } from '../geo'
import type { Camera, Station, StationKind } from '../types'

// Camera ↔ station join, computed when a catalogue is saved: a camera "belongs" to the sensors
// at the same spot. Road-flood sensors share the pole with BMA flood-watch cameras (≤ 50 m);
// canal and river gauges get a wider radius (≤ 150 m). Cameras never affect station status.

export const ROAD_JOIN_M = 50
export const WATER_JOIN_M = 150
/** At most this many station ids per camera (nearest first). */
export const MAX_NEAR_STATIONS = 6

const JOIN_RADIUS_M: Partial<Record<StationKind, number>> = {
  roadflood: ROAD_JOIN_M,
  canal: WATER_JOIN_M,
  river: WATER_JOIN_M,
}

/** ~150 m in degrees with margin, for a cheap pre-filter before haversine. */
const PREFILTER_DEG = 0.002

type JoinStation = Pick<Station, 'id' | 'kind' | 'lat' | 'lng'>

function joinable(stations: readonly JoinStation[]): JoinStation[] {
  return stations.filter((s) => JOIN_RADIUS_M[s.kind] !== undefined && Number.isFinite(s.lat) && Number.isFinite(s.lng))
}

/** Station ids near a point (road ≤ 50 m, canal/river ≤ 150 m), nearest first, ties by id. */
export function nearStationIds(lat: number, lng: number, stations: readonly JoinStation[]): string[] {
  const hits: { id: string; m: number }[] = []
  for (const s of stations) {
    const radius = JOIN_RADIUS_M[s.kind]
    if (radius === undefined) continue
    if (Math.abs(s.lat - lat) > PREFILTER_DEG || Math.abs(s.lng - lng) > PREFILTER_DEG) continue
    const m = haversineKm(lat, lng, s.lat, s.lng) * 1000
    if (m <= radius) hits.push({ id: s.id, m })
  }
  hits.sort((a, b) => a.m - b.m || a.id.localeCompare(b.id))
  return hits.slice(0, MAX_NEAR_STATIONS).map((h) => h.id)
}

/** New camera objects with `nearStationIds` computed against `stations`. */
export function joinNearStations(cameras: readonly Camera[], stations: readonly JoinStation[]): Camera[] {
  const candidates = joinable(stations)
  return cameras.map((c) => ({ ...c, nearStationIds: nearStationIds(c.lat, c.lng, candidates) }))
}

/** Fingerprint of the joinable stations; a change means the stored join should be redone. */
export function stationJoinKey(stations: readonly JoinStation[]): string {
  const parts = joinable(stations)
    .map((s) => `${s.id}@${s.kind}@${s.lat.toFixed(5)},${s.lng.toFixed(5)}`)
    .sort()
  return createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 16)
}
