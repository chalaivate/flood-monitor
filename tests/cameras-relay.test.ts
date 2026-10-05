import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraCatalogHealth, getCameraRef, hasCameraRefs, loadCameraCatalogs, saveCameraCatalog } from '@/lib/cameras/catalog'
import { loadConfig, resetConfigCache } from '@/lib/config'
import {
  createRelayCameraState,
  parseRelayCameraState,
  RELAY_CAMERA_MAX_UNCONFIRMED,
  runPollCycle,
  runRelayCycle,
  serializeRelayCameraState,
  summarize,
} from '@/lib/server/poller'
import { IngestPayloadSchema, parseRelayCameraCatalog } from '@/lib/server/validation'
import { parseBmaRoadFlood } from '@/lib/sources/bma-misc'
import { parseBmaCameraProfile } from '@/lib/sources/cameras/bma-floodcam'
import { ddsCameraCatalog, ddsCamSource } from '@/lib/sources/cameras/dds'
import { demoCamSource } from '@/lib/sources/cameras/demo'
import type { CameraCatalogAdapter, CameraCatalogContext } from '@/lib/sources/cameras/types'
import { DEMO_SOURCES } from '@/lib/sources/demo'
import type { SourceAdapter } from '@/lib/sources/types'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import type { CameraCatalog, CameraCatalogResult } from '@/lib/types'

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
    async fetchCatalog(ctx: CameraCatalogContext) {
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

type Answer = (body: Record<string, unknown>, n: number) => unknown

/** By default the server saves every list it gets (as POST /api/ingest answers). */
const savesAll: Answer = (body) => ({
  inserted: 1,
  cameras: ((body.cameraCatalogs as { source: string; cameras: unknown[] }[] | undefined) ?? []).map((c) => ({ source: c.source, saved: true, count: c.cameras.length, warning: null })),
})

function ingestStub(status: (n: number) => number = () => 200, answer: Answer = savesAll) {
  const posts: Post[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body)
    const body = JSON.parse(raw) as Record<string, unknown>
    posts.push({ url: String(input), body, raw })
    const s = status(posts.length)
    return s === 200 ? Response.json(answer(body, posts.length)) : new Response('bad gateway', { status: s })
  }) as typeof fetch
  return {
    fetch: f,
    posts,
    /** The camera POSTs only (readings POSTs never carry camera lists). */
    cameraPosts: () => posts.filter((p) => 'cameraCatalogs' in p.body || 'cameraFailures' in p.body),
  }
}

const relayBase = { baseUrl: 'https://flood.example.org', token: 'tok', config: loadConfig({}), sources: [roadSource], log: () => {}, sleep: async () => {} }

/** Answers every camera list with the same verdict. */
const answerAll = (verdict: Record<string, unknown>): Answer => (body) => ({
  inserted: 0,
  cameras: ((body.cameraCatalogs as { source: string }[] | undefined) ?? []).map((c) => ({ source: c.source, saved: false, count: 0, ...verdict })),
})

describe('runRelayCycle with camera lists', () => {
  it('never relays the static DDS table or the simulated set (every server builds those itself)', async () => {
    const { fetch, posts, cameraPosts } = ingestStub()
    const s = await runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [ddsCamSource, demoCamSource], cameraState: createRelayCameraState() })
    expect(s.ok).toBe(true)
    expect(s.cameras).toEqual([])
    expect(posts).toHaveLength(1) // readings only
    expect(cameraPosts()).toEqual([])
  })

  it('pushes the list when due, after the readings in a POST of its own, public fields only, and not again until the next period', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const { fetch, posts } = ingestStub()
    const s1 = await runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s1.ok).toBe(true)
    expect(s1.cameras).toEqual([{ source: 'bma-floodcam', ok: true, count: 17 }])
    expect(posts).toHaveLength(2)
    // Readings first, without camera lists…
    expect(posts[0]!.body.results).toHaveLength(1)
    expect(posts[0]!.body.cameraCatalogs).toBeUndefined()
    // …then the camera list alone (no readings, so the server runs no alerts for it).
    expect(posts[1]!.body.results).toEqual([])
    const catalogs = posts[1]!.body.cameraCatalogs as { source: string; fetchedAt: string; cameras: unknown[] }[]
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.source).toBe('bma-floodcam')
    expect(catalogs[0]!.cameras).toHaveLength(17)
    // Never refs, stream addresses or upstream fields.
    for (const p of posts) for (const needle of ['refs', 'rtsp:', 'example.invalid/cam', 'LiveStream', 'fixture-secret', '10.0.0.9']) expect(p.raw).not.toContain(needle)

    await runRelayCycle({ ...relayBase, fetch, now: () => at(1), cameraSources: [cams], cameraState: state })
    expect(posts).toHaveLength(3) // readings only
    expect(cams.calls).toBe(1)
    await runRelayCycle({ ...relayBase, fetch, now: () => at(24), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
    expect(posts).toHaveLength(5)
    expect(posts[4]!.body.cameraCatalogs).toHaveLength(1)
  })

  it('the readings POST (and so the server alerts) never waits for a slow camera list', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let listDone = false
    const slow = cameraAdapter((_n, now) => bmaList(now))
    const fetchList = slow.fetchCatalog
    slow.fetchCatalog = async (ctx) => {
      await gate
      const r = await fetchList(ctx)
      listDone = true
      return r
    }
    const { fetch, posts } = ingestStub()
    const cycle = runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [slow], cameraState: createRelayCameraState() })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(listDone).toBe(false)
    expect(posts[0]!.body.results).toHaveLength(1)
    expect(posts[0]!.body.cameraCatalogs).toBeUndefined()
    release()
    const s = await cycle
    expect(s.ok).toBe(true)
    expect(posts).toHaveLength(2)
    expect((posts[1]!.body.cameraCatalogs as unknown[]).length).toBe(1)
  })

  it('re-sends a list the server has not accepted yet, without refetching it', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const down = ingestStub(() => 401)
    const s1 = await runRelayCycle({ ...relayBase, fetch: down.fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s1.ok).toBe(false)
    expect(down.posts).toHaveLength(1) // no camera POST while the server refuses the readings
    const up = ingestStub()
    await runRelayCycle({ ...relayBase, fetch: up.fetch, now: () => at(0.2), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1)
    expect(up.cameraPosts()).toHaveLength(1)
    expect((up.cameraPosts()[0]!.body.cameraCatalogs as unknown[]).length).toBe(1)
    await runRelayCycle({ ...relayBase, fetch: up.fetch, now: () => at(0.4), cameraSources: [cams], cameraState: state })
    expect(up.cameraPosts()).toHaveLength(1)
  })

  it('a list the server could not store is sent again next cycle, and forgotten once saved', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const logs: string[] = []
    let failStore = true
    const stub = ingestStub(
      () => 200,
      (body, n) => (failStore && 'cameraCatalogs' in body ? (failStore = false, answerAll({ warning: 'store failed: fetch failed (supabase)', retry: true })(body, n)) : savesAll(body, n)),
    )
    await runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch: stub.fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(logs.join('\n')).toContain('server did not confirm the bma-floodcam camera list: store failed: fetch failed (supabase); sending it again next cycle')
    // Still owed to the server: an --once schedule would refetch it.
    expect(JSON.parse(serializeRelayCameraState(state))['bma-floodcam'].lastSuccessAt).toBeNull()
    await runRelayCycle({ ...relayBase, fetch: stub.fetch, now: () => at(0.2), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1)
    expect(stub.cameraPosts()).toHaveLength(2) // re-sent, not refetched
    await runRelayCycle({ ...relayBase, fetch: stub.fetch, now: () => at(0.4), cameraSources: [cams], cameraState: state })
    expect(stub.cameraPosts()).toHaveLength(2) // saved: forgotten until the next period
    expect(JSON.parse(serializeRelayCameraState(state))['bma-floodcam'].lastSuccessAt).toBe(T0.toISOString())
  })

  it('an unreadable or missing answer counts as unconfirmed; after a few tries the list is refetched with backoff', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const stub = ingestStub(() => 200, (body) => ('cameraCatalogs' in body ? { inserted: 0, cameras: [] } : { inserted: 1 }))
    for (let i = 0; i < RELAY_CAMERA_MAX_UNCONFIRMED; i++) {
      await runRelayCycle({ ...relayBase, fetch: stub.fetch, now: () => at(i * 0.1), cameraSources: [cams], cameraState: state })
    }
    expect(cams.calls).toBe(1)
    expect(stub.cameraPosts()).toHaveLength(RELAY_CAMERA_MAX_UNCONFIRMED)
    const t = (RELAY_CAMERA_MAX_UNCONFIRMED - 1) * 0.1
    // Given up: no resend, and a new fetch only after the 1 h backoff.
    await runRelayCycle({ ...relayBase, fetch: stub.fetch, now: () => at(t + 0.5), cameraSources: [cams], cameraState: state })
    expect(stub.cameraPosts()).toHaveLength(RELAY_CAMERA_MAX_UNCONFIRMED)
    expect(cams.calls).toBe(1)
    await runRelayCycle({ ...relayBase, fetch: stub.fetch, now: () => at(t + 1), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
  })

  it('a list refused as too small is fetched again with backoff (so the server sees it come back); other refusals wait for the next period', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const logs: string[] = []
    const shrink = ingestStub(() => 200, answerAll({ reason: 'shrink', warning: 'bma-floodcam: only 8 of 20 cameras (< 50%); kept the previous list' }))
    await runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch: shrink.fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(logs.join('\n')).toContain('server kept its bma-floodcam camera list: bma-floodcam: only 8 of 20 cameras')
    await runRelayCycle({ ...relayBase, fetch: shrink.fetch, now: () => at(0.5), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1)
    expect(shrink.cameraPosts()).toHaveLength(1)
    await runRelayCycle({ ...relayBase, fetch: shrink.fetch, now: () => at(1), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
    expect(shrink.cameraPosts()).toHaveLength(2)
    // Refused again: the next try waits longer (2 h, then 4 h …), not every hour.
    await runRelayCycle({ ...relayBase, fetch: shrink.fetch, now: () => at(2.5), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
    await runRelayCycle({ ...relayBase, fetch: shrink.fetch, now: () => at(3), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(3)

    // The server fetched its own list: nothing to resend or refetch before the next period.
    const other = createRelayCameraState()
    const fresh = ingestStub(() => 200, answerAll({ reason: 'local-fresh', warning: 'bma-floodcam: relayed list ignored; this server fetched its own list' }))
    const own = cameraAdapter((_n, now) => bmaList(now))
    await runRelayCycle({ ...relayBase, fetch: fresh.fetch, now: () => T0, cameraSources: [own], cameraState: other })
    await runRelayCycle({ ...relayBase, fetch: fresh.fetch, now: () => at(2), cameraSources: [own], cameraState: other })
    expect(own.calls).toBe(1)
    expect(fresh.cameraPosts()).toHaveLength(1)
  })

  it('a server without camera support (no `cameras` in its answer) is not sent the list again', async () => {
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const old = ingestStub(() => 200, () => ({ inserted: 1 }))
    await runRelayCycle({ ...relayBase, fetch: old.fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    await runRelayCycle({ ...relayBase, fetch: old.fetch, now: () => at(0.2), cameraSources: [cams], cameraState: state })
    expect(old.cameraPosts()).toHaveLength(1)
    expect(cams.calls).toBe(1)
  })

  it('reports a failed camera list (redacted) and retries it with backoff; readings are unaffected', async () => {
    const cams = cameraAdapter(() => new Error('connect to rtsp://admin:x@cam.dyndns.invalid/1 failed'))
    const state = createRelayCameraState()
    const logs: string[] = []
    const { fetch, posts, cameraPosts } = ingestStub()
    const s = await runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch, now: () => T0, cameraSources: [cams], cameraState: state })
    expect(s).toMatchObject({ ok: true, allFailed: false })
    expect(s.cameras).toEqual([{ source: 'bma-floodcam', ok: false, count: 0, error: 'connect to <url> failed' }])
    expect(posts[0]!.body.results).toHaveLength(1)
    expect(cameraPosts()[0]!.body.cameraFailures).toEqual([{ source: 'bma-floodcam', error: 'connect to <url> failed', attemptedAt: T0.toISOString() }])
    for (const p of posts) expect(p.raw).not.toContain('dyndns')
    expect(logs.join('\n')).not.toContain('admin:x')
    await runRelayCycle({ ...relayBase, fetch, now: () => at(0.5), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(1) // 1 h backoff
    await runRelayCycle({ ...relayBase, fetch, now: () => at(1), cameraSources: [cams], cameraState: state })
    expect(cams.calls).toBe(2)
  })

  it('a shutdown during a camera list fetch is not a failure: no backoff, no report, readings still pushed', async () => {
    const ctrl = new AbortController()
    const hang = cameraAdapter((_n, now) => bmaList(now))
    const fetchList = hang.fetchCatalog
    hang.fetchCatalog = async (ctx) => {
      if (hang.calls === 0) {
        hang.calls++
        await new Promise((_r, reject) => ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true }))
      }
      return fetchList(ctx)
    }
    const state = createRelayCameraState()
    const logs: string[] = []
    const { fetch, posts, cameraPosts } = ingestStub()
    const cycle = runRelayCycle({ ...relayBase, log: (m) => logs.push(m), fetch, now: () => T0, cameraSources: [hang], cameraState: state, signal: ctrl.signal })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    ctrl.abort()
    const s = await cycle
    expect(s.ok).toBe(true)
    expect(s.cameras).toEqual([])
    expect(cameraPosts()).toHaveLength(0)
    expect(state.get('bma-floodcam')).toMatchObject({ failures: 0, lastAttemptAt: null, pending: null })
    expect(logs.join('\n')).toContain('interrupted by shutdown')
    // The restarted relay fetches it at once.
    await runRelayCycle({ ...relayBase, fetch, now: () => at(0.05), cameraSources: [hang], cameraState: parseRelayCameraState(serializeRelayCameraState(state)) })
    expect(hang.calls).toBe(2)
    expect(cameraPosts()).toHaveLength(1)
  })

  it('a DWR list fetched again gets the previous list, so failed station lookups keep their position', async () => {
    const seen: (CameraCatalog | null | undefined)[] = []
    const dwr = { ...cameraAdapter((_n, now) => bmaList(now)), id: 'dwr-cctv' as const }
    const base = dwr.fetchCatalog
    dwr.fetchCatalog = async (ctx) => {
      seen.push(ctx.previous)
      const r = await base(ctx)
      return { ...r, source: 'dwr-cctv', cameras: r.cameras.map((c) => ({ ...c, id: `dwr-cctv:${c.nativeId}`, source: 'dwr-cctv' as const })), refs: [] }
    }
    const state = createRelayCameraState()
    const { fetch } = ingestStub()
    await runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [dwr], cameraState: state })
    await runRelayCycle({ ...relayBase, fetch, now: () => at(24), cameraSources: [dwr], cameraState: state })
    expect(seen[0] ?? null).toBeNull()
    expect(seen[1]!.cameras).toHaveLength(17)
    expect(JSON.stringify(seen[1])).not.toContain('rtsp:')
    // The schedule file never holds it.
    expect(serializeRelayCameraState(state)).not.toContain('cameras')
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
      new Map([['dwr-cctv', { lastAttemptAt: null, lastSuccessAt: null, failures: 0, pending: null, unconfirmed: 0, rejected: 0, previous: null }]]),
    )
  })

  it('never relays the simulated demo cameras', async () => {
    const demo = { ...cameraAdapter((_n, now) => bmaList(now)), id: 'demo-cam' as const }
    const { fetch, posts } = ingestStub()
    await runRelayCycle({ ...relayBase, fetch, now: () => T0, cameraSources: [demo] })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.cameraCatalogs).toBeUndefined()
    expect(demo.calls).toBe(0)
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

  it('refuses a relayed DDS list even when the source is enabled here, and records no failure for it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.CCTV_SOURCES = 'bma-floodcam,bma-ddscam,dwr-cctv'
    resetConfigCache()
    try {
      const dds = ddsCameraCatalog(new Date())
      const res = await post(
        relayPayload({
          cameraCatalogs: [{ source: 'bma-ddscam', fetchedAt: dds.fetchedAt, cameras: dds.cameras }, { source: 'bma-ddscam', fetchedAt: 'nope', cameras: [] }],
          cameraFailures: [{ source: 'bma-ddscam', error: 'HTTP 403 from dds.bangkok.go.th' }],
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { inserted: number; cameras: { source: string; saved: boolean; reason: string }[] }
      expect(body.inserted).toBeGreaterThan(0)
      expect(body.cameras).toEqual([
        { source: 'bma-ddscam', saved: false, count: 0, warning: 'camera list not accepted from a relay (this server builds it itself)', reason: 'not-relayable' },
        { source: 'bma-ddscam', saved: false, count: 0, warning: 'camera list not accepted from a relay (this server builds it itself)', reason: 'not-relayable' },
      ])
      expect(await loadCameraCatalogs(store, ['bma-ddscam'])).toEqual([])
      expect(await cameraCatalogHealth(store, ['bma-ddscam'])).toEqual([{ source: 'bma-ddscam', catalogAt: null, count: 0, lastError: null }])
    } finally {
      process.env.CCTV_SOURCES = ENV.CCTV_SOURCES
      resetConfigCache()
      log.mockRestore()
    }
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
  it('answers a store failure with retry (and the source), so the relay sends the list again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const setMeta = store.setMeta.bind(store)
    let failures = 1
    vi.spyOn(store, 'setMeta').mockImplementation(async (key, value) => {
      if (key.startsWith('cctv:catalog:') && failures-- > 0) throw new TypeError('fetch failed (supabase)')
      return setMeta(key, value)
    })
    const first = (await (await post(relayPayload())).json()) as { inserted: number; cameras: unknown[] }
    expect(first.inserted).toBeGreaterThan(0) // readings stored all the same
    expect(first.cameras).toEqual([{ source: 'bma-floodcam', saved: false, count: 0, warning: 'store failed: fetch failed (supabase)', retry: true }])
    expect(await loadCameraCatalogs(store, ['bma-floodcam'])).toEqual([])
    const again = (await (await post(relayPayload())).json()) as { cameras: { saved: boolean }[] }
    expect(again.cameras[0]!.saved).toBe(true)
    log.mockRestore()
  })

  it('end to end: a relay whose list hit a store failure delivers it on the next cycle', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const setMeta = store.setMeta.bind(store)
    let failures = 1
    vi.spyOn(store, 'setMeta').mockImplementation(async (key, value) => {
      if (key.startsWith('cctv:catalog:') && failures-- > 0) throw new TypeError('fetch failed (supabase)')
      return setMeta(key, value)
    })
    const toServer = ((input: RequestInfo | URL, init?: RequestInit) => ingestRoute.POST(new Request(String(input), init))) as typeof fetch
    const cams = cameraAdapter((_n, now) => bmaList(now))
    const state = createRelayCameraState()
    const now = Date.now()
    const relay = { ...relayBase, token: 'ingest-token', fetch: toServer, cameraSources: [cams], cameraState: state }
    await runRelayCycle({ ...relay, now: () => new Date(now) })
    expect(await loadCameraCatalogs(store, ['bma-floodcam'])).toEqual([])
    await runRelayCycle({ ...relay, now: () => new Date(now + 0.2 * HOUR) })
    expect(cams.calls).toBe(1)
    expect((await loadCameraCatalogs(store, ['bma-floodcam']))[0]!.cameras).toHaveLength(17)
    log.mockRestore()
  })

  it('a refused list shows in health: too small (with its reason for the relay) or invalid', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await post(relayPayload())
    const t = Date.now() + 60_000
    const small = parseBmaCameraProfile(load('bma-camera-profile-partial.json'), new Date(t))
    const res = (await (await post({ results: [], cameraCatalogs: [{ source: small.source, fetchedAt: small.fetchedAt, cameras: small.cameras }] })).json()) as {
      cameras: { saved: boolean; reason?: string; warning: string }[]
    }
    expect(res.cameras[0]).toMatchObject({ saved: false, reason: 'shrink' })
    const [h] = await cameraCatalogHealth(store, ['bma-floodcam'])
    expect(h!.count).toBe(17)
    expect(h!.lastError).toMatch(/^relay: bma-floodcam: only 3 of 17 cameras \(< 50%\)/)

    await post({ results: [], cameraCatalogs: [{ source: 'dwr-cctv', fetchedAt: 'yesterday', cameras: [{}] }] })
    expect((await cameraCatalogHealth(store, ['dwr-cctv']))[0]!.lastError).toBe('relay: list refused: invalid camera list')
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
