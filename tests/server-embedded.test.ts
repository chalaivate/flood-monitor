import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetConfigCache } from '@/lib/config'
import { __setStoreForTests, getStore } from '@/lib/store'
import { SqliteStore } from '@/lib/store/sqlite'

// The embedded worker (EMBEDDED_WORKER=1) and its instrumentation hook.

const fetched = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sources')>()),
  getSources: () => [
    {
      id: 'bma-canal',
      label: 'test',
      thaiIpOnly: false,
      async fetch({ now }: { now: Date }) {
        fetched.count++
        return { source: 'bma-canal', fetchedAt: now.toISOString(), warnings: [], stations: [], readings: [] }
      },
    },
  ],
}))

const saved = { ...process.env }

beforeAll(() => {
  process.env.POLL_MINUTES = '60'
  process.env.STORE = 'sqlite'
  resetConfigCache()
})

afterAll(async () => {
  const g = globalThis as typeof globalThis & { __floodEmbeddedWorker?: Promise<{ stop(): Promise<void> } | null> }
  await (await g.__floodEmbeddedWorker)?.stop()
  g.__floodEmbeddedWorker = undefined
  process.env = saved
  resetConfigCache()
  __setStoreForTests(null)
})

describe('getStore', () => {
  it('is a per-process singleton that tests can replace', async () => {
    const store = new SqliteStore(':memory:')
    __setStoreForTests(store)
    expect(await getStore()).toBe(store)
    expect(await getStore()).toBe(store)
    __setStoreForTests(null)
    process.env.STORE = 'supabase'
    process.env.SUPABASE_URL = ''
    resetConfigCache()
    await expect(getStore()).rejects.toThrow(/SUPABASE_URL/)
    process.env.STORE = 'sqlite'
    resetConfigCache()
    __setStoreForTests(store)
  })
})

describe('instrumentation / embedded worker', () => {
  it('does nothing unless EMBEDDED_WORKER=1 on the nodejs runtime', async () => {
    const { register } = await import('@/instrumentation')
    process.env.NEXT_RUNTIME = 'nodejs'
    process.env.EMBEDDED_WORKER = '0'
    await register()
    process.env.NEXT_RUNTIME = 'edge'
    process.env.EMBEDDED_WORKER = '1'
    await register()
    expect((globalThis as { __floodEmbeddedWorker?: unknown }).__floodEmbeddedWorker).toBeUndefined()
    expect(fetched.count).toBe(0)
  })

  it('starts one loop per process and runs the first cycle immediately', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { register } = await import('@/instrumentation')
    const { startEmbeddedWorker } = await import('@/lib/server/embedded-worker')
    process.env.NEXT_RUNTIME = 'nodejs'
    process.env.EMBEDDED_WORKER = '1'
    await register()
    await register()
    const a = startEmbeddedWorker()
    const b = startEmbeddedWorker()
    expect(a).toBe(b)
    const handle = await a
    expect(handle).not.toBeNull()
    await vi.waitFor(() => expect(fetched.count).toBe(1))
    const store = await getStore()
    expect(await store.getMeta('lastIngestAt')).not.toBeNull()
    log.mockRestore()
  })
})
