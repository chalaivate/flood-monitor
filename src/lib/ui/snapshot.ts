import type { DashboardSnapshot, HistoryPoint } from '../types'
import { ApiError, apiFetch, type HistoryResponse } from './api'
import { usePolled, type Polled } from './hooks'
import { snapshotQuery, type ResolvedPlace } from './place'

export const SNAPSHOT_REFRESH_MS = 60_000
export const HISTORY_REFRESH_MS = 5 * 60_000

/**
 * GET /api/snapshot for the current place, refreshed every 60 s and on focus.
 * A saved place id that no longer exists (404) falls back to its coordinates.
 */
export function useSnapshot(place: ResolvedPlace | null, enabled = true): Polled<DashboardSnapshot> {
  const primary = place && enabled ? snapshotQuery(place) : ''
  const fallback = place && enabled && place.placeId ? snapshotQuery(place, { preferCoords: true }) : ''
  const key = primary ? `/api/snapshot?${primary}` : null
  return usePolled<DashboardSnapshot>(
    key,
    async (signal) => {
      try {
        return await apiFetch<DashboardSnapshot>(`/api/snapshot?${primary}`, { signal })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && fallback && fallback !== primary) {
          return apiFetch<DashboardSnapshot>(`/api/snapshot?${fallback}`, { signal })
        }
        throw e
      }
    },
    SNAPSHOT_REFRESH_MS,
  )
}

/** GET /api/history for up to 8 station ids. */
export function useHistory(ids: string[], hours = 48): Polled<Record<string, HistoryPoint[]>> {
  const idList = ids.slice(0, 8).join(',')
  const key = idList ? `/api/history?ids=${encodeURIComponent(idList)}&hours=${hours}` : null
  return usePolled<Record<string, HistoryPoint[]>>(
    key,
    async (signal) => {
      const r = await apiFetch<HistoryResponse>(key ?? '', { signal })
      return r?.series ?? {}
    },
    HISTORY_REFRESH_MS,
  )
}
