import type { StationKind } from '../types'
import { haversineKm } from '../geo'
import { apiFetch, type MapStation, type StationsResponse } from './api'
import { usePolled, type Polled } from './hooks'

// GET /api/stations, shared by the map page and the location picker.

let cache: { at: number; promise: Promise<StationsResponse> } | null = null

export function loadStations(signal?: AbortSignal, maxAgeMs = 60_000): Promise<StationsResponse> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.promise
  const promise = apiFetch<StationsResponse>('/api/stations', { signal }).then((r) => ({
    generatedAt: r?.generatedAt ?? new Date().toISOString(),
    stations: Array.isArray(r?.stations) ? r.stations : [],
  }))
  cache = { at: Date.now(), promise }
  promise.catch(() => {
    if (cache?.promise === promise) cache = null
  })
  return promise
}

export function useStations(enabled = true): Polled<StationsResponse> {
  return usePolled<StationsResponse>(enabled ? '/api/stations' : null, () => loadStations(undefined, 30_000), 5 * 60_000)
}

/** Map filter groups (chips on /map). */
export type KindFilter = 'water' | 'rain' | 'roadflood' | 'pump'

export const KIND_FILTERS: { id: KindFilter; label: string; kinds: StationKind[] }[] = [
  { id: 'water', label: 'คลอง/แม่น้ำ', kinds: ['canal', 'river'] },
  { id: 'rain', label: 'ฝน', kinds: ['rain'] },
  { id: 'roadflood', label: 'น้ำท่วมถนน', kinds: ['roadflood'] },
  { id: 'pump', label: 'สถานีสูบ', kinds: ['pump'] },
]

export const DEFAULT_KIND_FILTERS: KindFilter[] = ['water', 'rain', 'roadflood']

export function filterStations(stations: MapStation[], active: KindFilter[]): MapStation[] {
  const kinds = new Set(KIND_FILTERS.filter((f) => active.includes(f.id)).flatMap((f) => f.kinds))
  return stations.filter((s) => kinds.has(s.kind) && Number.isFinite(s.lat) && Number.isFinite(s.lng))
}

/** Count per filter group (shown on the chips). */
export function countByFilter(stations: MapStation[]): Record<KindFilter, number> {
  const out: Record<KindFilter, number> = { water: 0, rain: 0, roadflood: 0, pump: 0 }
  for (const s of stations) {
    const f = KIND_FILTERS.find((k) => k.kinds.includes(s.kind))
    if (f) out[f.id]++
  }
  return out
}

/** Water-level stations within `radiusKm` of a point, nearest first. */
export function waterStationsWithin(stations: MapStation[], lat: number, lng: number, radiusKm: number): (MapStation & { distanceKm: number })[] {
  return stations
    .filter((s) => s.kind === 'canal' || s.kind === 'river')
    .map((s) => ({ ...s, distanceKm: haversineKm(lat, lng, s.lat, s.lng) }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
}

/** Distance (km) to the nearest water-level station, or null when there are none. */
export function nearestWaterKm(stations: MapStation[], lat: number, lng: number): number | null {
  let best: number | null = null
  for (const s of stations) {
    if (s.kind !== 'canal' && s.kind !== 'river') continue
    const d = haversineKm(lat, lng, s.lat, s.lng)
    if (best === null || d < best) best = d
  }
  return best
}

/** Smallest radius on the picker's 0.5 km grid that would include at least one water station. */
export function suggestRadiusKm(stations: MapStation[], lat: number, lng: number, maxKm = 20): number | null {
  const d = nearestWaterKm(stations, lat, lng)
  if (d === null || d > maxKm) return null
  return Math.min(maxKm, Math.max(0.5, Math.ceil(d * 2) / 2))
}
