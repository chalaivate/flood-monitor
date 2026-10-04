import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraCatalogHealth, getCameraRef, hasCameraRefs, loadCameraCatalogs, saveCameraCatalog } from '@/lib/cameras/catalog'
import { loadConfig, resetConfigCache } from '@/lib/config'
import { createRelayCameraState, parseRelayCameraState, runPollCycle, runRelayCycle, serializeRelayCameraState, summarize } from '@/lib/server/poller'
import { IngestPayloadSchema, parseRelayCameraCatalog } from '@/lib/server/validation'
import { parseBmaRoadFlood } from '@/lib/sources/bma-misc'
import { parseBmaCameraProfile } from '@/lib/sources/cameras/bma-floodcam'
import type { CameraCatalogAdapter } from '@/lib/sources/cameras/types'
import { DEMO_SOURCES } from '@/lib/sources/demo'
import type { SourceAdapter } from '@/lib/sources/types'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import type { CameraCatalogResult } from '@/lib/types'

import * as ingestRoute from '@/app/api/ingest/route'

// Relay mode: camera lists are pushed with the readings, public fields only (stream addresses
// stay on the Thai machine); the receiving server validates each list on its own and never
// lets a bad camera list block readings. Also: the poll cycle refreshes catalogues only when
// asked. No network: every fetch is injected or stubbed.

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
const T0 = new Date('2026-10-04T08:00:00.000Z')
const HOUR = 3_600_000
const at = (h: number) => new Date(T0.getTime() + h * HOUR)

const bmaList = (now: Date): CameraCatalogResult => parseBmaCameraProfile(load('bma-camera-profile.json'), now)

function cameraAdapter(make: (n: number, now: Date) => CameraCatalogResult | Error): CameraCatalogAdapter & { calls: number } {
  const a = {
    id: 'bma-floodcam' as const,
    label: 'สำนักการระบายน้ำ กทม.',
    thaiIpOnly: true,
    refreshHours: 24,
    calls: 0,
    async fetchCatalog(ctx: { now: Date }) {
      a.calls++
      const r = make(a.calls, ctx.now)
      if (r instanceof Error) throw r
      return r
    },
  }
  return a
}

const roadSource: SourceAdapter = {
  id: 'bma-roadflood',
  label: 'สำนักการระบายน้ำ กทม.',
  thaiIpOnly: true,
  async fetch({ now }) {
    return parseBmaRoadFlood(load('bma-roadflood.json'), now)
  },
}

interface Post {
  url: string
  body: Record<string, unknown>
  raw: string
}

function ingestStub(status: (n: number) => number = () => 200, answer: unknown = { inserted: 1 }) {
  const posts: Post[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body)
    posts.push({ url: String(input), body: JSON.parse(raw), raw })
    const s = status(posts.length)
    return s === 200 ? Response.json(answer) : new Response('bad gateway', { status: s })
  }) as typeof fetch
  return { fetch: f, posts }
}

const relayBase = { baseUrl: 'https://flood.example.org', token: 'tok', config: loadConfig({}), sources: [roadSource], log: () => {}, sleep: async () => {} }

describe('runRelayCycle with camera lists', () => {
  it('pushes the list when due, public fields only, and not again until the next period', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const { fetch, posts } = ingestStub()
    const s1 = await runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s1.ok).toBe(true)
    expect(s1.cameras).toEqual([{ source: 'bma-floodcam', ok: true, count: 17 }])
    const catalogs = posts[0]!.body.cameraCatalogs as { source: string; fetchedAt: string; cameras: unknown[] }[]
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.source).toBe('bma-floodcam')
    expect(catalogs[0]!.cameras).toHaveLength(17)
    // Never refs, stream addresses or upstream fields.
    for (const needle of ['refs', 'rtsp:', 'example.invalid/cam', 'LiveStream', 'fixture-secret', '10.0.0.9']) expect(posts[0]!.raw).not.toContain(needle)
    expect(posts[0]!.body.results).toHaveLength(1) // readings still relayed

    await runRelayCycle({ ...relayBase, fetch, now: () => at(1), cameraSources: [cams], cameraState: state })
    expect(posts[1]!.body.cameraCatalogs).toBeUndefined()
    expect(cams.calls).toBe(1)
    await runRelayCycle({ ...relayBase, fetch, now: () => at(24), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
    expect(posts[2]!.body.cameraCatalogs).toHaveLength(1)
  })

  it('re-sends a list the server has not accepted yet, without refetching it', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const down = ingestStub(() => 401)
    const s1 = await runRelayCycle({ ...relayBase, fetch: down.fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s1.ok).toBe(false)
    const up = ingestStub()
    await runRelayCycle({ ...relayBase, fetch: up.fetch, now: () => at(0.2), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1)
    expect((up.posts[0]!.body.cameraCatalogs as unknown[]).length).toBe(1)
    await runRelayCycle({ ...relayBase, fetch: up.fetch, now: () => at(0.4), cameraSources: [cams], cameraState: state })
    expect(up.posts[1]!.body.cameraCatalogs).toBeUndefined()
  })

  it('reports a failed camera list (redacted) and retries it with backoff; readings are unaffected', async () => {
    const cams = cameraAdapter(() => new Error('connect to rtsp://admin:x@cam.dyndns.invalid/1 failed'))
    const state = createRelayCameraState()
    const logs: string[] = []
    const { fetch, posts } = ingestStub()
    const s = await runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s).toMatchObject({ ok: true, allFailed: false })
    expect(s.cameras).toEqual([{ source: 'bma-floodcam', ok: false, count: 0, error: 'connect to <url> failed' }])
    expect(posts[0]!.body.cameraFailures).toEqual([{ source: 'bma-floodcam', error: 'connect to <url> failed', attemptedAt: T0.toISOString() }])
    expect(posts[0]!.raw).not.toContain('dyndns')
    expect(logs.join('\n')).not.toContain('admin:x')
    await runRelayCycle({ ...relayBase, fetch, now: () => at(0.5), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1) // 1 h backoff
    await runRelayCycle({ ...relayBase, fetch, now: () => at(1), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
  })

  it('keeps the schedule (never lists or refs) across --once runs; undelivered lists are refetched', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    await runRelayCycle({ ...relayBase, fetch: ingestStub().fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    const saved = serializeRelayCameraState(state)
    expect(JSON.parse(saved)).toEqual({ 'bma-floodcam': { lastAttemptAt: T0.toISOString(), lastSuccessAt: T0.toISOString(), failures: 0 } })
    for (const needle of ['rtsp:', 'cameras', 'ปาก']) expect(saved).not.toContain(needle)
    // Next process: not due yet.
    await runRelayCycle({ ...relayBase, fetch: ingestStub().fetch, now: () => at(2), cameraSources: [cams], cameraState: parseRelayCameraState(saved) })
    expect(cams.calls).toBe(1)

    // A list that was fetched but not delivered is forgotten, so the next run fetches it again.
    const undelivered = createRelayCameraState()
    await runRelayCycle({ ...relayBase, fetch: ingestStub(() => 401).fetch, now: () => T0, cameraSources: [cams], cameraState: undelivered })
    expect(JSON.parse(serializeRelayCameraState(undelivered))['bma-floodcam'].lastSuccessAt).toBeNull()
    await runRelayCycle({ ...relayBase, fetch: ingestStub().fetch, now: () => at(0.1), cameraSources: [cams], cameraState: parseRelayCameraState(serializeRelayCameraState(undelivered)) })
    expect(cams.calls).toBe(3)

    expect(parseRelayCameraState(null).size).toBe(0)
    expect(parseRelayCameraState('{oops').size).toBe(0)
    expect(parseRelayCameraState('{"bma-traffic":{},"dwr-cctv":{"lastAttemptAt":"x","failures":-3}}')).toEqual(
      new Map([['dwr-cctv', { lastAttemptAt: null, lastSuccessAt: null, failures: 0, pending: null }]]),
    )
  })

  it('never relays the simulated demo cameras and logs what the server kept', async () => {
    const demo = { ...cameraAdapter((_n, now) => bmaList(now)), id: 'demo-cam' as const }
    const logs: string[] = []
    const { fetch, posts } = ingestStub(() => 200, { inserted: 0, cameras: [{ source: 'bma-floodcam', saved: false, warning: 'kept the previous list' }] })
    await runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch, now: () => T0, cameraSources: [demo] })
    expect(posts[0]!.body.cameraCatalogs).toBeUndefined()
    expect(logs.join('\n')).toContain('server kept its bma-floodcam camera list: kept the previous list')
  })
})

describe('relayed camera list validation', () => {
  const pub = () => {
    const r = bmaList(T0)
    return { source: r.source, fetchedAt: r.fetchedAt, cameras: r.cameras.map((c) => ({ ...c })) }
  }

  it('accepts a public list, strips unknown keys (a ref sent by mistake), drops invalid cameras', () => {
    const raw = pub()
    ;(raw.cameras[0] as Record<string, unknown>).ref = 'rtsp://example.invalid/cam/101'
    ;(raw.cameras[1] as Record<string, unknown>).LiveStream = 'rtsp://example.invalid/cam/102'
    raw.cameras[2]!.id = 'dwr-cctv:103' // id/source mismatch
    raw.cameras[3]!.lat = 51.5 // outside Thailand
    raw.cameras[4]!.name = 'bad\u0007name'
    const res = parseRelayCameraCatalog(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.dropped).toBe(3)
    expect(res.catalog.cameras).toHaveLength(14)
    expect(JSON.stringify(res.catalog)).not.toContain('rtsp:')
    expect('refs' in res.catalog).toBe(false)
  })

  it('rejects demo cameras, unknown sources, foreign cameras and empty lists', () => {
    expect(parseRelayCameraCatalog({ ...pub(), source: 'demo-cam' })).toMatchObject({ ok: false, source: 'demo-cam' })
    expect(parseRelayCameraCatalog({ ...pub(), source: 'bma-traffic' })).toMatchObject({ ok: false })
    expect(parseRelayCameraCatalog({ ...pub(), source: 'dwr-cctv' })).toMatchObject({ ok: false, error: 'no valid camera in the list' })
    expect(parseRelayCameraCatalog({ ...pub(), cameras: [] })).toMatchObject({ ok: false })
    expect(parseRelayCameraCatalog({ ...pub(), fetchedAt: 'yesterday' })).toMatchObject({ ok: false })
    expect(parseRelayCameraCatalog(null)).toMatchObject({ ok: false, source: null })
  })

  it('the ingest payload stays backward compatible and never fails on camera entries', () => {
    expect(IngestPayloadSchema.parse({ results: [] })).toEqual({ results: [], failures: [], cameraCatalogs: [], cameraFailures: [] })
    const odd = IngestPayloadSchema.parse({ results: [], cameraCatalogs: [42, { source: 'x' }], cameraFailures: ['?'] })
    expect(odd.cameraCatalogs).toHaveLength(2)
    expect(() => IngestPayloadSchema.parse({ results: [], cameraCatalogs: Array(6).fill({}) })).toThrow()
  })
})

describe('POST /api/ingest with camera lists', () => {
  const saved: Record<string, string | undefined> = {}
  const ENV: Record<string, string> = { DATA_MODE: 'live', STORE: 'sqlite', INGEST_TOKEN: 'ingest-token', RUN_ALERTS: '0', CCTV_SOURCES: 'bma-floodcam,dwr-cctv' }
  let store: SqliteStore

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    resetConfigCache()
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetConfigCache()
    __setStoreForTests(null)
  })
  beforeEach(() => {
    store = new SqliteStore(':memory:')
    __setStoreForTests(store)
  })

  const post = (json: unknown) =>
    ingestRoute.POST(
      new Request('http://localhost/api/ingest', {
        method: 'POST',
        headers: { authorization: 'Bearer ingest-token', 'content-type': 'application/json' },
        body: JSON.stringify(json),
      }),
    )
  const relayPayload = (extra: Record<string, unknown> = {}) => {
    const road = parseBmaRoadFlood(load('bma-roadflood.json'), new Date())
    const list = bmaList(new Date())
    return {
      results: [road],
      failures: [],
      cameraCatalogs: [{ source: list.source, fetchedAt: list.fetchedAt, cameras: list.cameras }],
      ...extra,
    }
  }

  it('stores the list link-only, joined to the stations of the same payload', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await post(relayPayload())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { inserted: number; cameras: unknown[] }
    expect(body.cameras).toEqual([{ source: 'bma-floodcam', saved: true, count: 17, warning: null }])
    const [cat] = await loadCameraCatalogs(store, ['bma-floodcam'])
    expect(cat!.cameras).toHaveLength(17)
    expect(cat!.cameras.find((c) => c.nativeId === '101')!.nearStationIds).toEqual(['road:FL.WTL.04'])
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(false)
    expect(await getCameraRef(store, 'bma-floodcam:101')).toBeNull()
    expect(log.mock.calls.flat().join('\n')).toContain('camera lists: bma-floodcam 17')
    log.mockRestore()
  })

  it('a bad camera list never blocks readings; relay failures show in health', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await post(
      relayPayload({
        cameraCatalogs: [{ source: 'bma-floodcam', fetchedAt: 'nope', cameras: [] }, { source: 'demo-cam', fetchedAt: new Date().toISOString(), cameras: [{}] }],
        cameraFailures: [{ source: 'dwr-cctv', error: 'HTTP 403 from telemetry.dwr.go.th' }, { source: 'nope' }],
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { inserted: number; cameras: { saved: boolean; warning: string }[] }
    expect(body.inserted).toBeGreaterThan(0)
    expect(body.cameras.map((c) => c.saved)).toEqual([false, false])
    expect(await loadCameraCatalogs(store, ['bma-floodcam'])).toEqual([])
    expect((await cameraCatalogHealth(store, ['dwr-cctv']))[0]!.lastError).toBe('relay: HTTP 403 from telemetry.dwr.go.th')
    log.mockRestore()
  })

  it('ignores lists for sources this server has not enabled, and keeps a fetched-here list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.CCTV_SOURCES = 'dwr-cctv'
    resetConfigCache()
    try {
      const body = (await (await post(relayPayload())).json()) as { cameras: { saved: boolean; warning: string }[] }
      expect(body.cameras[0]).toMatchObject({ saved: false, warning: 'camera source not enabled on this server (CCTV_SOURCES)' })
    } finally {
      process.env.CCTV_SOURCES = ENV.CCTV_SOURCES
      resetConfigCache()
    }
    // This server fetched its own list (it holds refs): a relayed copy does not replace it.
    await saveCameraCatalog(store, bmaList(new Date()))
    const body = (await (await post(relayPayload())).json()) as { cameras: { saved: boolean; warning: string }[] }
    expect(body.cameras[0]!.saved).toBe(false)
    expect(body.cameras[0]!.warning).toMatch(/relayed list ignored/)
    expect(await hasCameraRefs(store, 'bma-floodcam')).toBe(true)
    log.mockRestore()
  })
})

describe('runPollCycle and camera catalogues', () => {
  const fixture = loadConfig({ DATA_MODE: 'fixture', RUN_ALERTS: '0' })
  const noNetwork = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch

  it('refreshes the catalogues only when asked, after ingest', async () => {
    const store = new SqliteStore(':memory:')
    const deps = { store, config: fixture, sources: DEMO_SOURCES, senders: [], fetch: noNetwork, now: () => T0 }
    const plain = await runPollCycle(deps)
    expect(plain.cameras).toEqual([])
    expect(await loadCameraCatalogs(store, ['demo-cam'])).toEqual([])

    const s = await runPollCycle(deps, { cameras: true })
    expect(s.cameras).toEqual([{ source: 'demo-cam', ok: true, count: 5, warnings: [] }])
    expect(summarize(s)).toContain('camera lists: demo-cam 5')
    // Joined to the demo stations stored by the same cycle's ingest.
    const [cat] = await loadCameraCatalogs(store, ['demo-cam'])
    expect(cat!.cameras[0]!.nearStationIds).toEqual(['road:DEMO.FL.01'])
    const again = await runPollCycle(deps, { cameras: true })
    expect(again.cameras).toEqual([{ source: 'demo-cam', ok: true, count: 5, skipped: true }])
    expect(summarize(again)).not.toContain('camera lists')
    store.close()
  })

  it('a camera failure never fails the cycle; nothing starts once shutdown began', async () => {
    const store = new SqliteStore(':memory:')
    // Live config: the catalogue fetches fail (no network) but the cycle is fine.
    const live = loadConfig({ RUN_ALERTS: '0', CCTV_SOURCES: 'bma-floodcam' })
    const s = await runPollCycle({ store, config: live, sources: [roadSource], senders: [], fetch: noNetwork, now: () => T0 }, { cameras: true })
    expect(s.allFailed).toBe(false)
    expect(s.cameras).toEqual([{ source: 'bma-floodcam', ok: false, count: 0, error: 'no network in tests' }])

    const ctrl = new AbortController()
    ctrl.abort()
    const f = vi.fn(noNetwork)
    const stopped = await runPollCycle({ store, config: live, sources: [], senders: [], fetch: f, now: () => at(5) }, { cameras: true, signal: ctrl.signal })
    expect(stopped.cameras).toEqual([])
    expect(f).not.toHaveBeenCalled()
    store.close()
  })
})
