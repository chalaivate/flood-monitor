import type { Store } from '../store/types'
import type { Place } from '../types'
import { bearerToken, verifyManageToken } from './auth'
import { HttpError, MSG } from './http'
import { PlaceInputSchema, PlacePatchSchema, type PlaceInput } from './validation'

// Place lifecycle helpers used by /api/places/**.

/** Place ids are UUIDs; reject anything else before touching the store. */
const ID_RE = /^[A-Za-z0-9-]{8,64}$/

export function newPlace(input: PlaceInput, manageTokenHash: string, now = new Date()): Place {
  const iso = now.toISOString()
  return {
    id: crypto.randomUUID(),
    label: input.label,
    lat: input.lat,
    lng: input.lng,
    radiusKm: input.radiusKm,
    maxStations: input.maxStations,
    freeboard: input.freeboard,
    rain: input.rain,
    rapidRiseCm: input.rapidRiseCm,
    notifyMinLevel: input.notifyMinLevel,
    manageTokenHash,
    createdAt: iso,
    updatedAt: iso,
  }
}

/** Apply a PATCH body to a stored place; the merged result is fully re-validated. */
export function patchPlace(place: Place, body: unknown, now = new Date()): Place {
  const patch = PlacePatchSchema.parse(body)
  const merged = PlaceInputSchema.parse({
    label: patch.label ?? place.label,
    lat: patch.lat ?? place.lat,
    lng: patch.lng ?? place.lng,
    radiusKm: patch.radiusKm ?? place.radiusKm,
    maxStations: patch.maxStations ?? place.maxStations,
    freeboard: patch.freeboard ?? place.freeboard,
    rain: patch.rain ?? place.rain,
    rapidRiseCm: patch.rapidRiseCm ?? place.rapidRiseCm,
    notifyMinLevel: patch.notifyMinLevel ?? place.notifyMinLevel,
  })
  return { ...place, ...merged, updatedAt: now.toISOString() }
}

/** Settings that decide what a place is alerted about (everything except the label). */
const ALERT_SCALARS = ['lat', 'lng', 'radiusKm', 'maxStations', 'rapidRiseCm', 'notifyMinLevel'] as const
const ALERT_THRESHOLDS = ['freeboard', 'rain'] as const
const THRESHOLD_KEYS = ['watch', 'warning', 'critical'] as const

/**
 * Did an edit change what the place is alerted about? Alert states compare against the
 * previous evaluation, so after such a change they must be cleared: otherwise a level
 * that is already reached (e.g. after lowering notifyMinLevel or moving the place) is
 * never reported, and loosened thresholds produce a "คลี่คลาย" without any real change.
 */
export function alertSettingsChanged(before: Place, after: Place): boolean {
  return (
    ALERT_SCALARS.some((k) => before[k] !== after[k]) ||
    ALERT_THRESHOLDS.some((t) => THRESHOLD_KEYS.some((k) => before[t][k] !== after[t][k]))
  )
}

/** Load a place and check `Authorization: Bearer <manageToken>`. Throws HttpError 401/404. */
export async function authorizePlace(req: Request, store: Store, id: string): Promise<Place> {
  if (!ID_RE.test(id)) throw new HttpError(404, MSG.placeNotFound)
  const place = await store.getPlace(id)
  if (!place) throw new HttpError(404, MSG.placeNotFound)
  if (!verifyManageToken(bearerToken(req), place.manageTokenHash)) {
    throw new HttpError(401, MSG.unauthorized, { 'WWW-Authenticate': 'Bearer' })
  }
  return place
}

export function isPlaceId(id: string): boolean {
  return ID_RE.test(id)
}
