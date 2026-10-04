import { describe, expect, it } from 'vitest'
import { loadConfig } from '@/lib/config'
import type { ChannelSender, NotifyMessage } from '@/lib/notify/types'
import { fetchPolitely, runCycle, storeSourceResult } from '@/lib/pipeline'
import { DEMO_CENTER, DEMO_SOURCES } from '@/lib/sources/demo'
import type { SourceAdapter } from '@/lib/sources/types'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Place, Station } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

const config = loadConfig({ DATA_MODE: 'fixture', PUBLIC_BASE_URL: 'https://flood.example' })

function place(over: Partial<Place> = {}): Place {
  const now = new Date().toISOString()
  return {
    id: 'p1',
    label: DEMO_CENTER.label,
    lat: DEMO_CENTER.lat,
    lng: DEMO_CENTER.lng,
    radiusKm: 3,
    maxStations: 4,
    freeboard: DEFAULT_FREEBOARD,
    rain: DEFAULT_RAIN,
    rapidRiseCm: 10,
    notifyMinLevel: 'watch',
    manageTokenHash: 'x',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

function recordingSender(): ChannelSender & { sent: NotifyMessage[] } {
  const sent: NotifyMessage[] = []
  return {
    type: 'ntfy',
    sent,
    isConfigured: () => true,
    async send(_ch, msg) {
      sent.push(msg)
      return { ok: true }
    },
  }
}

describe('runCycle (demo sources)', () => {
  it('ingests, alerts once per change, records health and prunes', async () => {
    const store = new SqliteStore(':memory:')
    // During the simulated storm peak several nearby gauges are ≥ watch.
    const now = new Date('2026-10-03T01:35:00.000Z')
    await store.createPlace(place())
    await store.addChannel({ id: 'c1', placeId: 'p1', type: 'ntfy', target: 'fm-test', verified: true, createdAt: now.toISOString() })
    await store.addChannel({ id: 'c2', placeId: 'p1', type: 'ntfy', target: 'fm-unverified', verified: false, createdAt: now.toISOString() })
    const sender = recordingSender()
    const deps = { store, config, sources: DEMO_SOURCES, senders: [sender], fetch, now: () => now }

    const first = await runCycle(deps)
    expect(first.ingest.results.every((r) => r.ok)).toBe(true)
    expect(first.ingest.results.find((r) => r.source === 'bma-canal')!.inserted).toBeGreaterThan(1000)
    expect(first.alerts.events).toHaveLength(1)
    expect(sender.sent).toHaveLength(1) // only the verified channel
    expect(sender.sent[0]!.url).toBe('https://flood.example/?place=p1')
    expect(sender.sent[0]!.body).toContain('พื้นที่:')

    const events = await store.listAlertEvents('p1', 10)
    expect(events[0]!.deliveries).toEqual([{ channelId: 'c1', type: 'ntfy', ok: true, error: null }])
    const health = await store.listSourceHealth()
    expect(health.every((h) => h.ok && h.latestObservationAt)).toBe(true)

    // Same instant again: nothing new to say.
    const second = await runCycle(deps)
    expect(second.alerts.events).toHaveLength(0)
    expect(second.ingest.results.find((r) => r.source === 'bma-canal')!.inserted).toBe(0)
    store.close()
  })

  it('keeps going when a source fails and records the error', async () => {
    const store = new SqliteStore(':memory:')
    const broken: SourceAdapter = {
      id: 'bma-pump',
      label: 'x',
      thaiIpOnly: true,
      fetch: async () => {
        throw new Error('fetch failed')
      },
    }
    const res = await runCycle({ store, config, sources: [broken, ...DEMO_SOURCES], senders: [], fetch, now: () => new Date('2026-10-03T04:35:00Z') })
    expect(res.ingest.results.find((r) => r.source === 'bma-pump')).toMatchObject({ ok: false, error: 'fetch failed' })
    const h = (await store.listSourceHealth()).find((x) => x.source === 'bma-pump')!
    expect(h.ok).toBe(false)
    expect(h.error).toContain('IP ในประเทศไทย')
    store.close()
  })
})

describe('storeSourceResult', () => {
  it('never lets a mirror overwrite primary station metadata, but keeps its readings', async () => {
    const store = new SqliteStore(':memory:')
    const base: Station = { id: 'canal:WL.SSB.07', source: 'bma-canal', kind: 'canal', name: 'BMA name', lat: 13.76, lng: 100.64, agency: 'a', bankLevel: 0.75 }
    await storeSourceResult(store, { source: 'bma-canal', stations: [base], readings: [], fetchedAt: '', warnings: [] })
    const n = await storeSourceResult(store, {
      source: 'thaiwater-canal',
      stations: [{ ...base, source: 'thaiwater-canal', name: 'mirror name', bankLevel: 0.8 }],
      readings: [{ stationId: base.id, observedAt: '2026-10-03T04:30:00Z', waterLevel: 0.4, freeboard: 0.4 }],
      fetchedAt: '',
      warnings: [],
    })
    expect(n).toBe(1)
    const [st] = await store.listStations()
    expect(st!.name).toBe('BMA name')
    expect(st!.bankLevel).toBe(0.75)
    store.close()
  })
})

describe('fetchPolitely', () => {
  it('serialises sources of the same host and keeps result order', async () => {
    const log: string[] = []
    const mk = (id: string, ms: number) => ({ id, ms })
    const items = [mk('bma-canal', 30), mk('thaiwater-canal', 5), mk('bma-rain', 5)]
    const res = await fetchPolitely(items, async (s) => {
      log.push(`start ${s.id}`)
      await new Promise((r) => setTimeout(r, s.ms))
      log.push(`end ${s.id}`)
      if (s.id === 'thaiwater-canal') throw new Error('boom')
      return s.id
    })
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(log.indexOf('start bma-rain')).toBeGreaterThan(log.indexOf('end bma-canal'))
    expect(log.indexOf('start thaiwater-canal')).toBeLessThan(log.indexOf('end bma-canal'))
  })
})
