import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from '@/lib/types'
import type { StationsResponse } from '@/lib/ui/api'
import { durationTh, freeboardTh, isIngestStale, newestObservation, stationShort, trendInfo } from '@/lib/ui/format'
import { LEVEL_GLYPH } from '@/lib/ui/levels'
import { applyVariant, rebaseSnapshot, shiftTimes, synthHistory } from '@/lib/ui/preview'
import { isIos, randomTopic, urlBase64ToUint8Array } from '@/lib/ui/push'
import { parseRainViewer } from '@/lib/ui/rainviewer'
import { countByFilter, DEFAULT_KIND_FILTERS, filterStations, nearestWaterKm, suggestRadiusKm, waterStationsWithin } from '@/lib/ui/stations'
import { thresholdForm, validateThresholds } from '@/lib/ui/thresholds'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'
import snapshotJson from './fixtures/snapshot-sample.json'
import stationsJson from './fixtures/stations-sample.json'

const snapshot = snapshotJson as unknown as DashboardSnapshot
const stations = (stationsJson as unknown as StationsResponse).stations

describe('format', () => {
  it('trendInfo: direction + Thai text, flat under 1 cm/h', () => {
    expect(trendInfo(4.2)).toEqual({ dir: 'up', text: 'ขึ้น 4 ซม./ชม.' })
    expect(trendInfo(-2)).toEqual({ dir: 'down', text: 'ลง 2 ซม./ชม.' })
    expect(trendInfo(0.4)).toEqual({ dir: 'flat', text: 'ทรงตัว' })
    expect(trendInfo(null)).toBeNull()
  })
  it('freeboardTh distinguishes above-bank water', () => {
    expect(freeboardTh(1.19)).toBe('ห่างตลิ่ง 1.19 ม.')
    expect(freeboardTh(-0.05)).toBe('สูงกว่าตลิ่ง 0.05 ม.')
    expect(freeboardTh(undefined)).toBe('')
  })
  it('isIngestStale after 3 missed polls', () => {
    const now = Date.parse('2026-10-03T04:35:00Z')
    expect(isIngestStale('2026-10-03T04:10:00Z', 10, now)).toBe(false)
    expect(isIngestStale('2026-10-03T04:04:00Z', 10, now)).toBe(true)
    expect(isIngestStale(null, 10, now)).toBe(true)
  })
  it('stationShort prefers shortName, else drops the ปตร. prefix', () => {
    expect(stationShort({ name: 'ปตร. คลองแสนแสบ', shortName: null })).toBe('คลองแสนแสบ')
    expect(stationShort({ name: 'x', shortName: 'สั้น' })).toBe('สั้น')
  })
  it('durationTh and newestObservation', () => {
    expect(durationTh(0.2)).toBe('ไม่ถึง 1 นาที')
    expect(durationTh(75)).toBe('1 ชม. 15 นาที')
    expect(durationTh(120)).toBe('2 ชม.')
    expect(durationTh(3 * 24 * 60)).toBe('3 วัน')
    expect(newestObservation(snapshot.water)).toBe('2026-10-03T04:29:00.000Z')
  })
  it('every level has a distinct glyph', () => {
    expect(new Set(Object.values(LEVEL_GLYPH)).size).toBe(5)
  })
})

describe('snapshot fixture', () => {
  it('models the reference dashboard', () => {
    expect(snapshot.water.map((w) => w.station.shortName)).toEqual(['ประเวศฯ วัดกระทุ่มฯ', 'ศาลาลอย อ่อนนุช 61', 'มะขามเทศ พัฒนาการ', 'ประเวศฯ ลาดกระบัง'])
    expect(snapshot.water.map((w) => w.reading?.freeboard)).toEqual([0.59, 0.69, 1.07, 1.19])
    expect(snapshot.overall.level).toBe('watch')
    expect(snapshot.rainMax24h?.valueMm).toBe(20.6)
  })
})

describe('preview helpers', () => {
  it('shiftTimes moves only ISO instants', () => {
    const out = shiftTimes({ a: '2026-10-03T04:35:00.000Z', b: 'ปกติ', c: [{ t: '2026-10-03T04:00:00Z' }], n: 3 }, 60_000)
    expect(out).toEqual({ a: '2026-10-03T04:36:00.000Z', b: 'ปกติ', c: [{ t: '2026-10-03T04:01:00.000Z' }], n: 3 })
  })
  it('rebaseSnapshot keeps relative ages', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    const r = rebaseSnapshot(snapshot, now)
    expect(r.generatedAt).toBe(new Date(now).toISOString())
    const age = (s: DashboardSnapshot) => Date.parse(s.generatedAt) - Date.parse(s.water[0]!.reading!.observedAt)
    expect(age(r)).toBe(age(snapshot))
  })
  it('synthHistory ends exactly at each reading and leaves a gap in series 2', () => {
    const h = synthHistory(snapshot)
    for (const w of snapshot.water) {
      const pts = h[w.station.id]!
      expect(pts.at(-1)!.t).toBe(w.reading!.observedAt)
      expect(pts.at(-1)!.freeboard).toBe(w.reading!.freeboard)
    }
    expect(h[snapshot.water[1]!.station.id]!.length).toBeLessThan(h[snapshot.water[0]!.station.id]!.length)
  })
  it('applyVariant derives states without mutating the input', () => {
    const before = JSON.stringify(snapshot)
    expect(applyVariant(snapshot, 'critical').overall.level).toBe('critical')
    expect(applyVariant(snapshot, 'empty').water).toHaveLength(0)
    expect(applyVariant(snapshot, 'noweather').weather).toBeNull()
    expect(applyVariant(snapshot, 'stale').water.some((w) => w.stale)).toBe(true)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
})

describe('RainViewer', () => {
  it('builds tile templates from weather-maps.json (oldest first)', () => {
    const frames = parseRainViewer({
      host: 'https://tilecache.rainviewer.com',
      radar: { past: [{ time: 1790000600, path: '/v2/radar/1790000600' }, { time: 1790000000, path: '/v2/radar/1790000000' }], nowcast: [{ time: 1790001200, path: '/v2/radar/nc' }] },
    })
    expect(frames.map((f) => f.time)).toEqual([1790000000000, 1790000600000])
    expect(frames[0]!.url).toBe('https://tilecache.rainviewer.com/v2/radar/1790000000/256/{z}/{x}/{y}/2/1_1.png')
  })
  it('rejects non-https hosts and odd paths', () => {
    expect(parseRainViewer({ host: 'http://evil', radar: { past: [{ time: 1, path: '/a' }] } })).toEqual([])
    expect(parseRainViewer({ host: 'https://x', radar: { past: [{ time: 1, path: 'javascript:alert(1)' }] } })).toEqual([])
    expect(parseRainViewer(null)).toEqual([])
  })
})

describe('push helpers', () => {
  it('decodes base64url VAPID keys', () => {
    expect([...urlBase64ToUint8Array('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
  })
  it('detects iOS including iPadOS desktop mode', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh)', 'MacIntel', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh)', 'MacIntel', 0)).toBe(false)
  })
  it('random ntfy topics are prefixed and topic-safe', () => {
    const t = randomTopic((n) => new Uint8Array(n).map((_, i) => i * 37))
    expect(t).toMatch(/^fm-[a-z2-9]{12}$/)
  })
})

describe('stations', () => {
  it('filters by kind groups and counts', () => {
    expect(filterStations(stations, ['pump']).every((s) => s.kind === 'pump')).toBe(true)
    expect(filterStations(stations, DEFAULT_KIND_FILTERS).some((s) => s.kind === 'pump')).toBe(false)
    const c = countByFilter(stations)
    expect(c.water + c.rain + c.roadflood + c.pump).toBe(stations.length)
  })
  it('finds water stations within a radius and suggests a radius when none', () => {
    const near = waterStationsWithin(stations, 13.72, 100.7, 3)
    expect(near.length).toBeGreaterThan(0)
    expect(near[0]!.distanceKm).toBeLessThanOrEqual(near.at(-1)!.distanceKm)
    const far = { lat: 13.9, lng: 100.75 }
    const d = nearestWaterKm(stations, far.lat, far.lng)!
    const r = suggestRadiusKm(stations, far.lat, far.lng)!
    expect(r).toBeGreaterThanOrEqual(d)
    expect(r - d).toBeLessThan(0.5)
    expect(suggestRadiusKm(stations, 18.8, 98.98)).toBeNull() // Chiang Mai: nothing within 20 km
  })
})

describe('threshold form', () => {
  const base = thresholdForm({ notifyMinLevel: 'warning', freeboard: DEFAULT_FREEBOARD, rain: DEFAULT_RAIN, rapidRiseCm: 10 })
  it('accepts the defaults', () => {
    expect(validateThresholds(base)).toBeNull()
  })
  it('rejects unordered or missing values', () => {
    expect(validateThresholds({ ...base, warning: '0.7' })).toMatch(/มากไปน้อย/)
    expect(validateThresholds({ ...base, critical: '' })).toMatch(/ครบ/)
    expect(validateThresholds({ ...base, rapidRiseCm: '1' })).toMatch(/3–50/)
    expect(validateThresholds({ ...base, rainWarning: '20' })).toMatch(/น้อยไปมาก/)
  })
})
