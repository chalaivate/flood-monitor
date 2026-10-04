import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@/lib/store/sqlite'
import type { Channel, Place, Station } from '@/lib/types'
import { DEFAULT_FREEBOARD, DEFAULT_RAIN } from '@/lib/types'

const station: Station = {
  id: 'bma-canal:209',
  source: 'bma-canal',
  kind: 'canal',
  name: 'จุดวัดคลองจั่น ตอนถนนโยธินพัฒนา',
  lat: 13.80547,
  lng: 100.6226,
  agency: 'สำนักการระบายน้ำ กทม.',
  bankLevel: 0.9,
}

describe('SqliteStore', () => {
  it('stores stations, dedupes readings, returns latest and history', async () => {
    const store = new SqliteStore(':memory:')
    await store.upsertStations([station])
    await store.upsertStations([{ ...station, bankLevel: 1.0 }])
    expect((await store.listStations())[0]!.bankLevel).toBe(1.0)

    const n1 = await store.insertReadings([
      { stationId: station.id, observedAt: '2026-10-03T04:00:00Z', waterLevel: 0.5, freeboard: 0.5 },
      { stationId: station.id, observedAt: '2026-10-03T04:10:00.000Z', waterLevel: 0.55, freeboard: 0.45 },
    ])
    const n2 = await store.insertReadings([
      { stationId: station.id, observedAt: '2026-10-03T04:10:00Z', waterLevel: 0.55, freeboard: 0.45 },
    ])
    expect(n1).toBe(2)
    expect(n2).toBe(0)

    const latest = await store.latest()
    expect(latest).toHaveLength(1)
    expect(latest[0]!.reading?.waterLevel).toBe(0.55)

    const hist = await store.history([station.id, 'missing'], '2026-10-03T03:00:00Z')
    expect(hist[station.id]!.map((r) => r.waterLevel)).toEqual([0.5, 0.55])
    expect(hist.missing).toEqual([])

    expect(await store.pruneReadings('2026-10-03T04:05:00Z')).toBe(1)
    store.close()
  })

  it('manages places, channels, alert state and events', async () => {
    const store = new SqliteStore(':memory:')
    const now = new Date().toISOString()
    const place: Place = {
      id: 'p1',
      label: 'บ้าน',
      lat: 13.72,
      lng: 100.75,
      radiusKm: 3,
      maxStations: 4,
      freeboard: DEFAULT_FREEBOARD,
      rain: DEFAULT_RAIN,
      rapidRiseCm: 10,
      notifyMinLevel: 'warning',
      manageTokenHash: 'h',
      createdAt: now,
      updatedAt: now,
    }
    await store.createPlace(place)
    await store.updatePlace({ ...place, label: 'คอนโด' })
    expect((await store.getPlace('p1'))?.label).toBe('คอนโด')

    const ch: Channel = { id: 'c1', placeId: 'p1', type: 'telegram', target: '', verified: false, linkCode: 'ABC123', createdAt: now }
    await store.addChannel(ch)
    expect((await store.findChannelByLinkCode('ABC123'))?.id).toBe('c1')
    await store.updateChannel({ ...ch, target: '42', verified: true, linkCode: null })
    expect(await store.findChannelByLinkCode('ABC123')).toBeNull()
    expect((await store.listChannels('p1'))[0]!.verified).toBe(true)

    await store.setAlertStates([{ placeId: 'p1', key: 'rain', level: 'watch', updatedAt: now }])
    await store.setAlertStates([{ placeId: 'p1', key: 'rain', level: 'warning', updatedAt: now }])
    expect((await store.getAlertStates('p1')).map((s) => s.level)).toEqual(['warning'])

    await store.appendAlertEvent({ id: 'e1', placeId: 'p1', kind: 'rain', level: 'warning', title: 't', body: 'b', stationIds: [], createdAt: '2026-10-03T04:00:00Z' })
    await store.appendAlertEvent({ id: 'e2', placeId: 'p1', kind: 'rain', level: 'watch', title: 't2', body: 'b', stationIds: [], createdAt: '2026-10-03T05:00:00Z' })
    expect((await store.listAlertEvents('p1', 10)).map((e) => e.id)).toEqual(['e2', 'e1'])

    await store.setMeta('lastIngestAt', now)
    expect(await store.getMeta('lastIngestAt')).toBe(now)

    await store.deletePlace('p1')
    expect(await store.getPlace('p1')).toBeNull()
    expect(await store.listChannels('p1')).toEqual([])
    store.close()
  })
})
