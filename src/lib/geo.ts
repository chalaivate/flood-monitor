const EARTH_RADIUS_KM = 6371.0088

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}

/** Rough bounding box of Thailand, used to reject obviously wrong coordinates. */
export function isInThailand(lat: number, lng: number): boolean {
  return lat >= 5.5 && lat <= 20.6 && lng >= 97.2 && lng <= 105.8
}

/**
 * Sort items by distance to a point, keep those within radiusKm, cap at limit.
 * Items without coordinates are dropped.
 */
export function nearest<T>(
  items: T[],
  getLatLng: (item: T) => { lat: number; lng: number } | null,
  origin: { lat: number; lng: number },
  opts: { radiusKm: number; limit: number },
): { item: T; distanceKm: number }[] {
  const out: { item: T; distanceKm: number }[] = []
  for (const item of items) {
    const p = getLatLng(item)
    if (!p || !isValidLatLng(p.lat, p.lng)) continue
    const distanceKm = haversineKm(origin.lat, origin.lng, p.lat, p.lng)
    if (distanceKm <= opts.radiusKm) out.push({ item, distanceKm })
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm)
  return out.slice(0, Math.max(0, opts.limit))
}

/**
 * Parse coordinates pasted by a user: "13.72, 100.61", a Google Maps URL
 * (…/@13.72,100.61,15z or ?q=13.72,100.61) or an OpenStreetMap URL (#map=15/13.72/100.61).
 */
export function parseLatLng(input: string): { lat: number; lng: number } | null {
  const s = input.trim()
  const patterns: RegExp[] = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, // google @lat,lng
    /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i,
    /#map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/, // osm
    /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/, // plain
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m) {
      const lat = Number(m[1])
      const lng = Number(m[2])
      if (isValidLatLng(lat, lng)) return { lat, lng }
    }
  }
  return null
}
