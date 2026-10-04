import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraCatalogHealth, STATUS_META_PREFIX } from '@/lib/cameras/catalog'
import { loadConfig, resetConfigCache } from '@/lib/config'
import { runPollCycle } from '@/lib/server/poller'
import { BMA_FLOODCAM_LIST_URL } from '@/lib/sources/cameras/bma-floodcam'
import { DWR_LIST_URL } from '@/lib/sources/cameras/dwr'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'

import * as cronRoute from '@/app/api/cron/poll/route'

// Which host refreshes which camera list: /api/cron/poll (usually serverless, outside Thailand)
// never touches a Thai-IP-only catalogue, so it can neither fail on it nor back off the Thai
// worker that shares its store; the long-running pollers keep refreshing every enabled list.
// No network: fetch is stubbed and every upstream call fails.

vi.mock('@/lib/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sources')>()),
  getSources: () => [],
}))

const T0 = new Date('2026-10-04T08:00:00.000Z')
const blocked = () => {
  const urls: string[] = []
  const f = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    throw new TypeError('fetch failed (blocked in tests)')
  }) as typeof fetch
  return { fetch: f, urls }
}

describe('runPollCycle camera scope', () => {
  const config = loadConfig({ RUN_ALERTS: '0', CCTV_SOURCES: 'bma-floodcam,dwr-cctv' })

  it('the long-running pollers refresh every enabled list; with skipThaiIpOnlyCameras only those reachable from anywhere', async () => {
    const store = new SqliteStore(':memory:')
    const all = blocked()
    const s = await runPollCycle({ store, config, sources: [], senders: [], fetch: all.fetch, now: () => T0 }, { cameras: true })
    expect(s.cameras.map((c) => c.source).sort()).toEqual(['bma-floodcam', 'dwr-cctv'])
    expect(all.urls).toContain(BMA_FLOODCAM_LIST_URL)

    const fresh = new SqliteStore(':memory:')
    const some = blocked()
    const c = await runPollCycle({ store: fresh, config, sources: [], senders: [], fetch: some.fetch, now: () => T0 }, { cameras: true, skipThaiIpOnlyCameras: true })
    expect(c.cameras.map((r) => r.source)).toEqual(['dwr-cctv'])
    expect(some.urls).not.toContain(BMA_FLOODCAM_LIST_URL)
    expect(await fresh.getMeta(STATUS_META_PREFIX + 'bma-floodcam')).toBeNull()
    store.close()
    fresh.close()
  })
})

describe('GET /api/cron/poll and camera lists', () => {
  const ENV: Record<string, string> = { DATA_MODE: 'live', STORE: 'sqlite', CRON_SECRET: 'cron-secret', RUN_ALERTS: '0', CCTV_SOURCES: 'bma-floodcam,dwr-cctv' }
  const saved: Record<string, string | undefined> = {}
  let store: SqliteStore
  let urls: string[]

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
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    store = new SqliteStore(':memory:')
    __setStoreForTests(store)
    const stub = blocked()
    urls = stub.urls
    vi.stubGlobal('fetch', stub.fetch)
  })

  it('never fetches (or records a failure for) the Thai-IP-only BMA list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await cronRoute.GET(new Request('http://localhost/api/cron/poll', { headers: { authorization: 'Bearer cron-secret' } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cameras: { source: string }[] }
    expect(body.cameras.map((c) => c.source)).toEqual(['dwr-cctv'])
    expect(urls).toContain(DWR_LIST_URL)
    expect(urls.some((u) => u.includes('bangkok.go.th'))).toBe(false)
    const health = await cameraCatalogHealth(store, ['bma-floodcam', 'dwr-cctv'])
    expect(health[0]).toEqual({ source: 'bma-floodcam', catalogAt: null, count: 0, lastError: null })
    expect(health[1]!.lastError).toMatch(/fetch failed/)
    log.mockRestore()
  })
})
