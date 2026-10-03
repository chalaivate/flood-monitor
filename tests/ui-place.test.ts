import { describe, expect, it } from 'vitest'
import {
  clampCount,
  clampRadius,
  DEFAULT_MAX_STATIONS,
  DEFAULT_RADIUS_KM,
  FALLBACK_PLACE,
  manageUrl,
  parseHashToken,
  parsePlaceParams,
  parseStoredPlace,
  resolvePlace,
  shareUrl,
  snapshotQuery,
  stripPlaceParams,
  toStoredPlace,
} from '@/lib/ui/place'

const DEF = { label: 'ค่าเริ่มต้น', lat: 13.7563, lng: 100.5018 }
const stored = (o: Record<string, unknown>) => JSON.stringify({ label: 'บ้าน', lat: 13.72, lng: 100.7, radiusKm: 3, maxStations: 4, ...o })

describe('clamps', () => {
  it('clamps radius to 0.5–20 km with one decimal', () => {
    expect(clampRadius(0.1)).toBe(0.5)
    expect(clampRadius('25')).toBe(20)
    expect(clampRadius('2.345')).toBe(2.3)
    expect(clampRadius('abc')).toBe(DEFAULT_RADIUS_KM)
    expect(clampRadius(undefined)).toBe(DEFAULT_RADIUS_KM)
  })
  it('clamps station count to integers 1–8', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount('9')).toBe(8)
    expect(clampCount('3.6')).toBe(4)
    expect(clampCount(null)).toBe(DEFAULT_MAX_STATIONS)
  })
})

describe('parseStoredPlace', () => {
  it('accepts a valid record and keeps place id + token', () => {
    const p = parseStoredPlace(stored({ placeId: 'abc12345', manageToken: 'secret-token-123' }))
    expect(p).toEqual({ label: 'บ้าน', lat: 13.72, lng: 100.7, radiusKm: 3, maxStations: 4, placeId: 'abc12345', manageToken: 'secret-token-123' })
  })
  it('rejects malformed JSON, missing or invalid coordinates', () => {
    expect(parseStoredPlace(null)).toBeNull()
    expect(parseStoredPlace('{oops')).toBeNull()
    expect(parseStoredPlace(JSON.stringify({ label: 'x' }))).toBeNull()
    expect(parseStoredPlace(stored({ lat: 123 }))).toBeNull()
  })
  it('sanitises label, radius, count and drops bad ids', () => {
    const p = parseStoredPlace(stored({ label: '   ', radiusKm: 99, maxStations: -2, placeId: 'bad id!', manageToken: 'x' }))
    expect(p).toMatchObject({ label: 'บ้าน', radiusKm: 20, maxStations: 1 })
    expect(p?.placeId).toBeUndefined()
    expect(p?.manageToken).toBeUndefined()
  })
  it('accepts numeric strings', () => {
    expect(parseStoredPlace(stored({ lat: '13.5', lng: '100.5' }))).toMatchObject({ lat: 13.5, lng: 100.5 })
  })
})

describe('parsePlaceParams', () => {
  it('reads ?place=<id>', () => {
    expect(parsePlaceParams('?place=abc12345')).toEqual({ kind: 'id', placeId: 'abc12345' })
  })
  it('reads coordinates with defaults for r and n', () => {
    expect(parsePlaceParams('?lat=13.7&lng=100.6&label=%E0%B8%9A%E0%B9%89%E0%B8%B2%E0%B8%99')).toEqual({
      kind: 'coords',
      label: 'บ้าน',
      lat: 13.7,
      lng: 100.6,
      radiusKm: DEFAULT_RADIUS_KM,
      maxStations: DEFAULT_MAX_STATIONS,
    })
    expect(parsePlaceParams('lat=13.7&lng=100.6&r=0.2&n=12')).toMatchObject({ radiusKm: 0.5, maxStations: 8, label: 'ตำแหน่งที่แชร์' })
  })
  it('ignores incomplete or invalid input', () => {
    expect(parsePlaceParams('?lat=13.7')).toBeNull()
    expect(parsePlaceParams('?lat=abc&lng=100')).toBeNull()
    expect(parsePlaceParams('?lat=&lng=')).toBeNull()
    expect(parsePlaceParams('?place=<script>')).toBeNull()
    expect(parsePlaceParams('')).toBeNull()
  })
})

describe('resolvePlace priority', () => {
  it('URL place id beats everything; matches stored details when ids agree', () => {
    const r = resolvePlace('?place=abc12345&lat=1&lng=2', stored({ placeId: 'abc12345', manageToken: 'secret-token-123' }), DEF)
    expect(r).toMatchObject({ origin: 'url-id', placeId: 'abc12345', lat: 13.72, manageToken: 'secret-token-123' })
  })
  it('foreign place id has no coordinates or token', () => {
    const r = resolvePlace('?place=zzzz9999', stored({ placeId: 'abc12345', manageToken: 'secret-token-123' }), DEF)
    expect(r).toMatchObject({ origin: 'url-id', placeId: 'zzzz9999', lat: null, lng: null })
    expect(r.manageToken).toBeUndefined()
  })
  it('URL coordinates beat storage', () => {
    expect(resolvePlace('?lat=14&lng=100.5&label=A', stored({}), DEF)).toMatchObject({ origin: 'url', lat: 14, label: 'A' })
  })
  it('storage beats default', () => {
    expect(resolvePlace('', stored({}), DEF)).toMatchObject({ origin: 'storage', lat: 13.72 })
  })
  it('falls back to the server default, then the built-in default', () => {
    expect(resolvePlace('', null, DEF)).toMatchObject({ origin: 'default', label: 'ค่าเริ่มต้น', lat: DEF.lat })
    expect(resolvePlace('', null, null)).toMatchObject({ origin: 'default', lat: FALLBACK_PLACE.lat, lng: FALLBACK_PLACE.lng })
  })
})

describe('query and link builders', () => {
  it('builds the snapshot query by id or by coordinates', () => {
    const byId = resolvePlace('', stored({ placeId: 'abc12345', manageToken: 'secret-token-123' }), DEF)
    expect(snapshotQuery(byId)).toBe('place=abc12345')
    const q = new URLSearchParams(snapshotQuery(byId, { preferCoords: true }))
    expect(Object.fromEntries(q)).toEqual({ lat: '13.72', lng: '100.7', label: 'บ้าน', r: '3', n: '4' })
    const shared = resolvePlace('?place=zzzz9999', null, DEF)
    expect(snapshotQuery(shared, { preferCoords: true })).toBe('place=zzzz9999')
  })
  it('share links carry coordinates but never the manage token', () => {
    const p = resolvePlace('', stored({ placeId: 'abc12345', manageToken: 'secret-token-123' }), DEF)
    const url = shareUrl('https://flood.example', p)
    expect(url).toContain('lat=13.72')
    expect(url).not.toContain('secret')
    expect(parsePlaceParams(new URL(url).search)).toMatchObject({ kind: 'coords', lat: 13.72, lng: 100.7, radiusKm: 3, maxStations: 4 })
  })
  it('manage links put the token in the hash and parse back', () => {
    const url = manageUrl('https://flood.example', 'abc12345', 'tok/en+value')
    expect(url).toBe('https://flood.example/alerts?place=abc12345#token=tok%2Fen%2Bvalue')
    expect(parseHashToken(new URL(url).hash)).toBe('tok/en+value')
    expect(parseHashToken('#token=short')).toBeNull()
    expect(parseHashToken('')).toBeNull()
  })
  it('strips only place parameters', () => {
    expect(stripPlaceParams('?lat=1&lng=2&label=x&r=3&n=4&place=abc12345&variant=critical')).toBe('?variant=critical')
    expect(stripPlaceParams('?lat=1')).toBe('')
  })
  it('toStoredPlace refuses places without coordinates', () => {
    expect(toStoredPlace(resolvePlace('?place=zzzz9999', null, DEF))).toBeNull()
    expect(toStoredPlace(resolvePlace('', stored({}), DEF))).toEqual({ label: 'บ้าน', lat: 13.72, lng: 100.7, radiusKm: 3, maxStations: 4 })
  })
})
