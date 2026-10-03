import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from '@/lib/types'
import { radarImages } from '@/lib/radar'
import { linkCodeExpired, pickerChannels } from '@/lib/ui/channels'
import { classifyCoverage, coverageHintTh, farDistanceTh, rainCoverage, waterCoverage } from '@/lib/ui/coverage'
import { classifyPushSupport } from '@/lib/ui/push'
import { radarTabLabel, radarTitle, tabKeyTarget } from '@/lib/ui/radar-tabs'
import { Dashboard } from '@/components/dashboard/Dashboard'
import snapshotJson from '@/app/dev/preview/snapshot-sample.json'

const snapshot = snapshotJson as unknown as DashboardSnapshot
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

describe('radar tabs', () => {
  const [nongchok, nongkhaem, nowcast] = radarImages()

  it('labels tabs from tabLabel; a forecast is never labelled by its parenthesised area', () => {
    expect(radarImages().map(radarTabLabel)).toEqual(['หนองจอก', 'หนองแขม', 'คาดการณ์ 3 ชม.'])
    expect(radarTabLabel({ ...nowcast!, tabLabel: undefined })).toBe(nowcast!.title)
    expect(radarTabLabel({ ...nongchok!, tabLabel: undefined })).toBe('หนองจอก')
  })

  it('says "ตอนนี้" for observed radar only', () => {
    expect(radarTitle(undefined)).toBe('เรดาร์ฝนตอนนี้')
    expect(radarTitle(nongkhaem)).toBe('เรดาร์ฝน กทม. (หนองแขม) ตอนนี้')
    expect(radarTitle(nowcast)).toBe('คาดการณ์ฝน 3 ชม. ข้างหน้า (กทม.)')
    expect(radarTitle(nowcast)).not.toContain('ตอนนี้')
  })

  it('implements the ARIA tabs keys: arrows wrap, Home/End jump, others ignored', () => {
    expect(tabKeyTarget('ArrowRight', 0, 4)).toBe(1)
    expect(tabKeyTarget('ArrowRight', 3, 4)).toBe(0)
    expect(tabKeyTarget('ArrowLeft', 0, 4)).toBe(3)
    expect(tabKeyTarget('Home', 2, 4)).toBe(0)
    expect(tabKeyTarget('End', 0, 4)).toBe(3)
    expect(tabKeyTarget('ArrowRight', -1, 4)).toBe(1)
    expect(tabKeyTarget('Enter', 1, 4)).toBeNull()
    expect(tabKeyTarget('ArrowRight', 0, 0)).toBeNull()
  })
})

describe('coverage', () => {
  const empty = { ...snapshot, water: [], rain: [], rainMax24h: null }

  it('classifies radius-too-small vs outside coverage vs no data', () => {
    expect(classifyCoverage(undefined, 3)).toEqual({ kind: 'unknown' })
    expect(classifyCoverage(null, 3)).toEqual({ kind: 'no-data' })
    expect(classifyCoverage(586.2, 3)).toEqual({ kind: 'outside', nearestKm: 586.2 })
    expect(classifyCoverage(20.4, 3)).toEqual({ kind: 'outside', nearestKm: 20.4 })
    // Suggest a radius that actually reaches the station, capped at the 20 km maximum.
    expect(classifyCoverage(13.1, 3)).toEqual({ kind: 'expand', nearestKm: 13.1, radiusKm: 14 })
    expect(classifyCoverage(19.6, 3)).toEqual({ kind: 'expand', nearestKm: 19.6, radiusKm: 20 })
    expect(classifyCoverage(3, 3)).toEqual({ kind: 'expand', nearestKm: 3, radiusKm: 4 })
  })

  it('reads the snapshot coverage contract', () => {
    expect(waterCoverage(snapshot)).toEqual({ kind: 'ok' })
    expect(waterCoverage({ ...empty, coverage: undefined })).toEqual({ kind: 'unknown' })
    expect(waterCoverage({ ...empty, coverage: { nearestWaterKm: 586.2, nearestRainKm: 586.3 } }).kind).toBe('outside')
    expect(waterCoverage({ ...empty, coverage: { nearestWaterKm: null, nearestRainKm: null } }).kind).toBe('no-data')
    // Rain gauges are already searched within 15 km, so 13 km away cannot be "expand".
    expect(rainCoverage({ ...empty, coverage: { nearestWaterKm: 1, nearestRainKm: 17.2 } })).toEqual({ kind: 'expand', nearestKm: 17.2, radiusKm: 18 })
    expect(rainCoverage({ ...empty, coverage: { nearestWaterKm: 1, nearestRainKm: 40 } }).kind).toBe('outside')
  })

  it('explains out-of-coverage in Thai with the distance', () => {
    expect(coverageHintTh({ kind: 'outside', nearestKm: 586.2 })).toBe('สถานีวัดน้ำที่ใกล้ที่สุดอยู่ห่าง 586 กม. — อยู่นอกพื้นที่ครอบคลุม')
    expect(coverageHintTh({ kind: 'expand', nearestKm: 13.1, radiusKm: 14 })).toContain('14 กม.')
    expect(coverageHintTh({ kind: 'unknown' })).toBe('ขยายรัศมีค้นหาเพื่อดูกราฟย้อนหลัง')
    expect(farDistanceTh(1234.4)).toBe('1,234 กม.')
    expect(farDistanceTh(0.4)).toBe('400 ม.')
  })
})

describe('alert channels', () => {
  it('drops e-mail from the picker when the server reports it off', () => {
    const on = { webpush: true, line: false, telegram: true, ntfy: true, email: true, discord: false }
    expect(pickerChannels(on)).toEqual(['webpush', 'telegram', 'ntfy', 'email', 'line', 'discord'])
    expect(pickerChannels({ ...on, email: false })).not.toContain('email')
    expect(pickerChannels(null)).not.toContain('email')
  })

  it('treats a link code as expired once linkExpiresAt has passed', () => {
    const t = Date.parse('2026-10-03T10:00:00Z')
    expect(linkCodeExpired('2026-10-03T10:00:00Z', t)).toBe(true)
    expect(linkCodeExpired('2026-10-03T10:00:01Z', t)).toBe(false)
    expect(linkCodeExpired(null, t)).toBe(false)
    expect(linkCodeExpired('not a date', t)).toBe(false)
    // nowMs 0 = clock not started yet (first render): never claim expiry.
    expect(linkCodeExpired('2026-10-03T10:00:00Z', 0)).toBe(false)
  })

  it('reports an insecure (http://) origin before anything else', () => {
    expect(classifyPushSupport({ secure: false, ios: true, standalone: false, hasApis: false })).toBe('insecure')
    expect(classifyPushSupport({ secure: true, ios: true, standalone: false, hasApis: true })).toBe('ios-needs-install')
    expect(classifyPushSupport({ secure: true, ios: false, standalone: false, hasApis: true })).toBe('supported')
    expect(classifyPushSupport({ secure: true, ios: false, standalone: false, hasApis: false })).toBe('unsupported')
  })
})

describe('dashboard order', () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, {
      snapshot,
      place: null,
      dataMode: 'live',
      nowMs: Date.parse(snapshot.generatedAt),
      history: { data: null, error: null },
      status: { error: null, updatedAt: null, carriedOver: false },
    }),
  )

  it('keeps cards in phone priority order in the DOM (= focus / reading order)', () => {
    const areas = [...html.matchAll(/data-area="([a-z]+)"/g)].map((m) => m[1])
    const expected = ['sit', 'gauge', 'history', 'rain', 'road', 'weather', 'radar', 'legend']
    expect(areas).toEqual(snapshot.roadFlood.length > 0 ? expected : expected.filter((a) => a !== 'road'))
    expect(html).not.toMatch(/\border-\d/)
    expect(html).not.toMatch(/\bcontents\b/)
  })

  it('places every card in each wider grid template exactly once', () => {
    const templates = [...css.matchAll(/grid-template-areas:\s*((?:'[^']*'\s*)+);/g)].map((m) => [...m[1]!.matchAll(/'([^']*)'/g)].map((r) => r[1]!.trim().split(/\s+/)))
    expect(templates.length).toBe(4)
    for (const rows of templates) {
      const names = new Set(rows.flat().filter((n) => n !== '.'))
      for (const a of ['sit', 'gauge', 'history', 'rain', 'weather', 'radar', 'legend']) expect(names.has(a)).toBe(true)
      // Every row has the same number of columns.
      expect(new Set(rows.map((r) => r.length)).size).toBe(1)
    }
  })
})

describe('colour tokens (WCAG AA)', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x! + 0.05) / (y! + 0.05)
  }
  const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
  const token = (b: string, name: string) => b.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1] ?? ''
  const dark = block(':root {')
  const light = block(":root[data-theme='light']")

  it('muted text is >= 4.5:1 on every surface in both themes', () => {
    for (const b of [dark, light]) {
      for (const surface of ['--bg', '--card', '--card-2']) expect(ratio(token(b, '--muted'), token(b, surface))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('filled buttons put white on --accent-fill (>= 4.5:1), accent text is >= 4.5:1', () => {
    expect(token(dark, '--accent-fill')).toBe('#0b6bdc')
    expect(ratio(token(dark, '--accent-ink'), token(dark, '--accent-fill'))).toBeGreaterThanOrEqual(4.5)
    expect(block('.fm-btn-primary {')).toContain('var(--accent-fill)')
    expect(block('.fm-skip {')).toContain('var(--accent-fill)')
    for (const surface of ['--card', '--card-2']) {
      expect(ratio(token(dark, '--accent-text'), token(dark, surface))).toBeGreaterThanOrEqual(4.5)
      expect(ratio(token(light, '--accent-text'), token(light, surface))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
