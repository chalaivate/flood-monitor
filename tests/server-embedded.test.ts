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

describe('embedded worker restart', () => {
  type G = typeof globalThis & {
    __floodEmbeddedWorker?: Promise<{ stop(): Promise<void> } | null>
    __floodEmbeddedWorkerFailures?: number
    __floodEmbeddedWorkerRetry?: unknown
  }
  const g = globalThis as G

  it('backs off 30 s, doubling to at most 5 min', async () => {
    const { retryDelayMs } = await import('@/lib/server/embedded-worker')
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
  })

  it('clears a failed start and retries until the store opens', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { startEmbeddedWorker } = await import('@/lib/server/embedded-worker')
    // Stop the loop started by the previous test and forget it.
    await (await g.__floodEmbeddedWorker)?.stop()
    g.__floodEmbeddedWorker = undefined
    g.__floodEmbeddedWorkerFailures = 0

    // The store cannot be opened yet (Supabase selected without a URL).
    __setStoreForTests(null)
    process.env.STORE = 'supabase'
    process.env.SUPABASE_URL = ''
    resetConfigCache()

    const timers: { fn: () => void; ms: number }[] = []
    const opts = { setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimer: () => {} }

    expect(await startEmbeddedWorker(opts)).toBeNull()
    expect(g.__floodEmbeddedWorker).toBeUndefined()
    expect(timers.map((t) => t.ms)).toEqual([30_000])

    // First retry fails too: the delay doubles.
    timers[0]!.fn()
    expect(await g.__floodEmbeddedWorker).toBeNull()
    expect(timers.map((t) => t.ms)).toEqual([30_000, 60_000])
    expect(log.mock.calls.flat().join('\n')).toContain('retrying in 60 s')

    // The store becomes available: the next retry starts the loop.
    process.env.STORE = 'sqlite'
    resetConfigCache()
    __setStoreForTests(new SqliteStore(':memory:'))
    const before = fetched.count
    timers[1]!.fn()
    const handle = await g.__floodEmbeddedWorker
    expect(handle).not.toBeNull()
    expect(g.__floodEmbeddedWorkerFailures).toBe(0)
    expect(startEmbeddedWorker(opts)).toBe(g.__floodEmbeddedWorker)
    await vi.waitFor(() => expect(fetched.count).toBe(before + 1))
    expect(timers).toHaveLength(2)
    log.mockRestore()
  })
})

describe('graceful shutdown (lifecycle)', () => {
  type G = typeof globalThis & {
    __floodEmbeddedWorker?: Promise<{ stop(): Promise<void> } | null>
    __floodEmbeddedWorkerStopped?: boolean
    __floodEmbeddedWorkerRetry?: unknown
    __floodEmbeddedWorkerFailures?: number
    __floodChannelWarningsLogged?: boolean
  }
  const g = globalThis as G

  function fakeProcess(existingListeners = 0) {
    const handlers = new Map<string, (() => void)[]>()
    return {
      on(signal: string, fn: () => void) {
        handlers.set(signal, [...(handlers.get(signal) ?? []), fn])
      },
      listenerCount: () => existingListeners,
      emit(signal: string) {
        for (const fn of handlers.get(signal) ?? []) fn()
      },
      count: (signal: string) => handlers.get(signal)?.length ?? 0,
    }
  }

  it('on SIGTERM stops the poller, waits for the cycle and background tasks, then exits 143', async () => {
    const { installShutdownHandlers, __resetShutdownForTests } = await import('@/lib/server/lifecycle')
    __resetShutdownForTests()
    const proc = fakeProcess()
    const exits: number[] = []
    const logs: string[] = []
    const order: string[] = []
    let finishCycle!: () => void
    const stopWorker = vi.fn(
      () =>
        new Promise<void>((r) => {
          finishCycle = () => {
            order.push('worker stopped')
            r()
          }
        }),
    )
    const waitBackground = vi.fn(async () => {
      order.push('background settled')
    })
    expect(installShutdownHandlers({ proc, exit: (c) => exits.push(c), log: (m) => logs.push(m), stopWorker, waitBackground, graceMs: 5_000 })).toBe(true)
    // Installed once per process.
    expect(installShutdownHandlers({ proc })).toBe(false)
    expect(proc.count('SIGTERM')).toBe(1)

    proc.emit('SIGTERM')
    expect(stopWorker).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(exits).toEqual([]) // still waiting for the cycle in flight
    finishCycle()
    await vi.waitFor(() => expect(exits).toEqual([143]))
    expect(order).toEqual(['worker stopped', 'background settled'])
    expect(logs.join('\n')).toContain('SIGTERM received')
    expect(logs.at(-1)).toBe('[shutdown] done')
    __resetShutdownForTests()
  })

  it('exits after the grace period, and at once on a second signal', async () => {
    const { installShutdownHandlers, __resetShutdownForTests } = await import('@/lib/server/lifecycle')
    __resetShutdownForTests()
    const proc = fakeProcess()
    const exits: number[] = []
    const logs: string[] = []
    const never = () => new Promise<void>(() => {})
    installShutdownHandlers({ proc, exit: (c) => exits.push(c), log: (m) => logs.push(m), stopWorker: never, waitBackground: never, graceMs: 20 })
    proc.emit('SIGINT')
    await vi.waitFor(() => expect(exits).toEqual([130]))
    expect(logs.join('\n')).toContain('grace period over')

    __resetShutdownForTests()
    const proc2 = fakeProcess()
    const exits2: number[] = []
    installShutdownHandlers({ proc: proc2, exit: (c) => exits2.push(c), log: () => {}, stopWorker: never, waitBackground: never, graceMs: 60_000 })
    proc2.emit('SIGTERM')
    proc2.emit('SIGTERM')
    expect(exits2).toEqual([143])
    __resetShutdownForTests()
  })

  it('warns when another SIGTERM handler (Next.js) is already registered', async () => {
    const { installShutdownHandlers, __resetShutdownForTests } = await import('@/lib/server/lifecycle')
    __resetShutdownForTests()
    const logs: string[] = []
    installShutdownHandlers({ proc: fakeProcess(1), exit: () => {}, log: (m) => logs.push(m) })
    expect(logs.join('\n')).toContain('not in .env')
    __resetShutdownForTests()
  })

  it('drain waits for running after-response tasks (ingest alerts)', async () => {
    const { drain } = await import('@/lib/server/lifecycle')
    const { runAfterResponse } = await import('@/lib/server/background')
    let release!: () => void
    runAfterResponse('ingest', () => new Promise<void>((r) => (release = r)))
    let finished: boolean | null = null
    const p = drain({ stopWorker: async () => {}, graceMs: 5_000 }).then((ok) => (finished = ok))
    await new Promise((r) => setTimeout(r, 10))
    expect(finished).toBeNull()
    release()
    await p
    expect(finished).toBe(true)
  })

  it('onServerStart logs half-configured channels and installs handlers only with NEXT_MANUAL_SIG_HANDLE', async () => {
    const { onServerStart, __resetShutdownForTests } = await import('@/lib/server/lifecycle')
    __resetShutdownForTests()
    g.__floodChannelWarningsLogged = false
    process.env.TELEGRAM_BOT_TOKEN = '123:ABC'
    process.env.TELEGRAM_WEBHOOK_SECRET = ''
    process.env.TELEGRAM_BOT_USERNAME = ''
    resetConfigCache()
    const logs: string[] = []
    const proc = fakeProcess()
    onServerStart({ EMBEDDED_WORKER: '0', NEXT_MANUAL_SIG_HANDLE: 'true' }, { proc, log: (m) => logs.push(m), exit: () => {} })
    expect(logs.join('\n')).toContain('Telegram is not offered to users: TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME are not set')
    expect(proc.count('SIGTERM')).toBe(1)
    expect(proc.count('SIGINT')).toBe(1)

    // Without NEXT_MANUAL_SIG_HANDLE Next.js owns the signals: no handlers, and a hint when the worker is embedded.
    __resetShutdownForTests()
    const proc2 = fakeProcess()
    const logs2: string[] = []
    const startSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    onServerStart({ EMBEDDED_WORKER: '1' }, { proc: proc2, log: (m) => logs2.push(m) })
    startSpy.mockRestore()
    expect(proc2.count('SIGTERM')).toBe(0)
    expect(logs2.join('\n')).toContain('NEXT_MANUAL_SIG_HANDLE is not set')
    // Channel warnings are logged once per process.
    expect(logs2.join('\n')).not.toContain('Telegram')
    delete process.env.TELEGRAM_BOT_TOKEN
    resetConfigCache()
    __resetShutdownForTests()
  })

  it('stopEmbeddedWorker stops the loop, cancels a pending retry and prevents restarts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { startEmbeddedWorker, stopEmbeddedWorker } = await import('@/lib/server/embedded-worker')
    const running = await g.__floodEmbeddedWorker
    expect(running).not.toBeNull()
    await stopEmbeddedWorker()
    expect(g.__floodEmbeddedWorker).toBeUndefined()
    const before = fetched.count
    expect(await startEmbeddedWorker()).toBeNull()

    // A retry scheduled before the shutdown is cancelled and does not start anything.
    g.__floodEmbeddedWorkerStopped = false
    __setStoreForTests(null)
    process.env.STORE = 'supabase'
    process.env.SUPABASE_URL = ''
    resetConfigCache()
    const timers: { fn: () => void; cleared: boolean }[] = []
    const opts = {
      setTimer: (fn: () => void) => timers.push({ fn, cleared: false }) - 1,
      clearTimer: (h: unknown) => {
        timers[h as number]!.cleared = true
      },
    }
    expect(await startEmbeddedWorker(opts)).toBeNull()
    expect(timers).toHaveLength(1)
    await stopEmbeddedWorker()
    expect(timers[0]!.cleared).toBe(true)
    process.env.STORE = 'sqlite'
    resetConfigCache()
    __setStoreForTests(new SqliteStore(':memory:'))
    timers[0]!.fn() // a timer that fired anyway
    expect(g.__floodEmbeddedWorker).toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(fetched.count).toBe(before)
    g.__floodEmbeddedWorkerStopped = false
    g.__floodEmbeddedWorkerFailures = 0
    log.mockRestore()
  })
})
