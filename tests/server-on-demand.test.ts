import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, resetConfigCache } from '@/lib/config'
import { META_LAST_INGEST_ATTEMPT } from '@/lib/pipeline'
import { ensureFreshData } from '@/lib/server/on-demand'
import { __setStoreForTests } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'
import * as publicConfigRoute from '@/app/api/config/public/route'

// Serverless deployments without a poller (INGEST_ON_REQUEST=1): a request on an instance whose
// data is older than POLL_MINUTES runs one poll cycle first. Demo data only — no network.

describe('serverless defaults', () => {
  it('uses /tmp and on-request ingest on Vercel with SQLite, never with Supabase', () => {
    const c = loadConfig({ VERCEL: '1' }, { warn: () => undefined, cwd: '/var/task' })
    expect(c.DATA_DIR).toBe('/tmp/flood-monitor')
    expect(c.INGEST_ON_REQUEST).toBe('1')
    expect(c.CCTV_IMAGES).toBe('0')
    const demo = loadConfig({ VERCEL: '1', DATA_MODE: 'fixture' }, { warn: () => undefined, cwd: '/var/task' })
    expect(demo.CCTV_IMAGES).toBe('1') // generated demo images need no agency
    const shared = loadConfig({ VERCEL: '1', STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { warn: () => undefined, cwd: '/var/task' })
    expect(shared.INGEST_ON_REQUEST).toBe('0')
    expect(shared.DATA_DIR).toBe('/var/task/data')
    expect(loadConfig({}, { cwd: '/srv' }).INGEST_ON_REQUEST).toBe('0')
  })
})

describe('ensureFreshData', () => {
  let store: SqliteStore
  const saved: Record<string, string | undefined> = {}
  const env = { DATA_MODE: 'fixture', INGEST_ON_REQUEST: '1', POLL_MINUTES: '10', CCTV_SOURCES: 'none' }

  beforeEach(() => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    resetConfigCache()
    store = new SqliteStore(':memory:')
    __setStoreForTests(store)
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetConfigCache()
    __setStoreForTests(null)
    store.close()
  })

  it('fills an empty instance on the first request, once for concurrent requests', async () => {
    expect((await store.latest()).length).toBe(0)
    await Promise.all([ensureFreshData(), ensureFreshData(), ensureFreshData()])
    const latest = await store.latest()
    expect(latest.length).toBeGreaterThan(10)
    expect(latest.some((r) => r.reading)).toBe(true)
    const attempt = await store.getMeta(META_LAST_INGEST_ATTEMPT)
    expect(attempt).not.toBeNull()
    // Fresh data: no new cycle within POLL_MINUTES.
    await ensureFreshData()
    expect(await store.getMeta(META_LAST_INGEST_ATTEMPT)).toBe(attempt)
  })

  it('runs again once the data is older than POLL_MINUTES', async () => {
    await ensureFreshData()
    const first = await store.getMeta(META_LAST_INGEST_ATTEMPT)
    await ensureFreshData(() => Date.parse(first!) + 11 * 60_000)
    expect(await store.getMeta(META_LAST_INGEST_ATTEMPT)).not.toBe(first)
  })

  it('does nothing when INGEST_ON_REQUEST is off', async () => {
    process.env.INGEST_ON_REQUEST = '0'
    resetConfigCache()
    await ensureFreshData()
    expect((await store.latest()).length).toBe(0)
  })

  it('tells the UI that places and alert settings are not kept', async () => {
    const res = await publicConfigRoute.GET()
    expect(((await res.json()) as { ephemeral: boolean }).ephemeral).toBe(true)
  })
})
