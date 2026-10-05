import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BMA_FLOODCAM_PROXY,
  CCTV_POLICY,
  CCTV_SERVER_MAX_MS,
  CCTV_SWEEP_MS,
  CLIENT_MAX_MISSES,
  CLIENT_MAX_WAITING,
  HASH_MAX_AGE_MS,
  SOURCE_DOWN_AFTER,
  SOURCE_DOWN_MS,
  __resetCctvWarningsForTests,
  cctvConfigWarnings,
  CCTV_MSG,
  canServeImages,
  cctvFailure,
  cctvImageAvailability,
  cctvFrameResponse,
  cctvImagePath,
  cctvImageStats,
  clearCctvCache,
  dwrCaptureTime,
  getCctvImage,
  isJpeg,
  jpegSize,
  logCctvConfigWarnings,
  parseCctvImageFile,
  parseRetryAfterMs,
  startCctvSweeper,
  sweepCctvMemory,
  trimJpeg,
  validateJpeg,
  type CctvFetchDeps,
  type CctvImageOutcome,
} from '@/lib/server/cctv-proxy'
import { ImageCache, NotAttemptedError } from '@/lib/server/image-cache'
import { LIMITS, RateLimiter } from '@/lib/server/rate-limit'

// Image proxy internals with an injected fetch and clock; nothing reaches the network.
// Frames are synthetic byte strings shaped like JPEGs (no real camera picture is used).

/** Minimal JPEG-shaped bytes: SOI, APP0, SOF0 (w×h), a scan byte that varies with `seed`, EOI. */
function jpeg(w = 352, h = 288, seed = 0): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, seed & 0xff, 0x00,
    0xff, 0xd9,
  ])
}

const HTML_TRAILER = new TextEncoder().encode('<html><body>ad</body></html>')
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const REF = 'rtsp://example.invalid/cam/101'
const CAM = 'bma-floodcam:101'

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(respond: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return respond(String(input), init, calls.length)
  })
  return { fetch: f as unknown as typeof fetch, calls }
}

let t = 0
const now = () => t

function deps(f: typeof fetch, extra: Partial<CctvFetchDeps> = {}): CctvFetchDeps {
  return { fetch: f, now, publicBaseUrl: 'https://flood.example.org', ...extra }
}

beforeEach(() => {
  t = Date.UTC(2026, 9, 4, 3, 0, 0)
  clearCctvCache()
})
afterEach(() => clearCctvCache())

describe('JPEG checks', () => {
  it('accepts JPEG magic, trims bytes after the last end-of-image marker and reads the size', () => {
    const img = jpeg(640, 360)
    expect(isJpeg(img)).toBe(true)
    expect(jpegSize(img)).toEqual({ width: 640, height: 360 })
    const withTrailer = concat(img, HTML_TRAILER)
    expect(trimJpeg(withTrailer)).toEqual(img)
    expect(validateJpeg(withTrailer)).toEqual({ bytes: img, width: 640, height: 360 })
  })

  it('rejects challenge pages, PNG placeholders, empty and truncated bodies', () => {
    expect(() => validateJpeg(new TextEncoder().encode('<!DOCTYPE html><title>Just a moment...</title>'))).toThrow('not a JPEG image')
    const png = new Uint8Array(89)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => validateJpeg(png)).toThrow('not a JPEG image')
    expect(() => validateJpeg(new Uint8Array(0))).toThrow('empty body')
    expect(() => validateJpeg(jpeg().subarray(0, 30))).toThrow('truncated JPEG')
  })

  it('parses the DWR capture time from the snapshot path in Thai time', () => {
    expect(dwrCaptureTime('/TA100220/2026/10/4/10_15.jpg')).toBe('2026-10-04T03:15:00.000Z')
    expect(dwrCaptureTime('/TC020106/2026/9/26/7_17.jpg')).toBe('2026-09-26T00:17:00.000Z')
    expect(dwrCaptureTime('/TA100220/2026/2/31/10_15.jpg')).toBeNull()
    expect(dwrCaptureTime('/TA100220/latest.jpg')).toBeNull()
  })

  it('maps camera ids to fixed same-origin image paths and back', () => {
    expect(cctvImagePath({ source: 'bma-floodcam', nativeId: '101' })).toBe('/api/cctv/image/bma-floodcam/101.jpg')
    expect(cctvImagePath({ source: 'demo-cam', nativeId: '3' })).toBe('/api/cctv/image/demo-cam/3.svg')
    expect(parseCctvImageFile('bma-floodcam', '101.jpg')).toBe('101')
    expect(parseCctvImageFile('bma-floodcam', '101.svg')).toBeNull()
    expect(parseCctvImageFile('demo-cam', '3.svg')).toBe('3')
    expect(parseCctvImageFile('dwr-cctv', '../x.jpg')).toBeNull()
    expect(parseCctvImageFile('dwr-cctv', 'a%2Fb.jpg')).toBeNull()
  })
})

describe('BMA flood-camera frames', () => {
  it('builds the upstream URL server-side with a self-identifying browser User-Agent, no Referer/Origin, redirects by hand', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg()))
    const res = await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(REF)}&timestamp=${t}`)
    expect(calls[0]!.url.startsWith('https://floodbangkok.bangkok.go.th/api/proxy?rtcUrl=')).toBe(true)
    expect(calls[0]!.init.redirect).toBe('manual')
    const h = new Headers(calls[0]!.init.headers)
    expect(h.get('user-agent')).toMatch(/^Mozilla\/5\.0 .*flood-monitor\/0\.1 \(\+https:\/\/flood\.example\.org\/about\)$/)
    expect(h.get('accept')).toMatch(/^image\/jpeg,image\/png,image\/webp/)
    expect(h.has('referer')).toBe(false)
    expect(h.has('origin')).toBe(false)
  })

  it('refuses references that are not stream addresses without calling upstream', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg()))
    const res = await getCctvImage('bma-floodcam', CAM, 'javascript:alert(1)', deps(fetch))
    expect(res).toEqual({ ok: false, failure: 'unreachable' })
    expect(calls).toHaveLength(0)
  })

  it('shares one upstream request between concurrent viewers of a camera', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { fetch, calls } = fakeFetch(async () => {
      await gate
      return new Response(jpeg())
    })
    const pending = Array.from({ length: 5 }, () => getCctvImage('bma-floodcam', CAM, REF, deps(fetch)))
    await new Promise((r) => setTimeout(r, 5))
    release()
    const results = await Promise.all(pending)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('serves from cache for 60 s, refetches after, and serves the last frame as stale for up to 15 min', async () => {
    let down = false
    const { fetch, calls } = fakeFetch(() => (down ? Promise.reject(new TypeError('fetch failed')) : new Response(jpeg())))
    expect((await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).ok).toBe(true)
    t += 59_000
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).toMatchObject({ ok: true, stale: false })
    expect(calls).toHaveLength(1)
    t += 2_000
    expect((await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).ok).toBe(true)
    expect(calls).toHaveLength(2)

    down = true
    t += 61_000
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).toMatchObject({ ok: true, stale: true })
    expect(calls).toHaveLength(3)
    // Failure remembered for 60 s: no new upstream request.
    t += 30_000
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).toMatchObject({ ok: true, stale: true })
    expect(calls).toHaveLength(3)
    t += 31_000
    await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    expect(calls).toHaveLength(4)
    // Older than the stale limit (15 min after the last good frame): nothing is served.
    t += 13 * 60_000
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).toEqual({ ok: false, failure: 'unreachable' })
  })

  it('rejects HTML challenge pages and oversize bodies', async () => {
    const html = fakeFetch(() => new Response('<html>Just a moment...</html>', { headers: { 'content-type': 'text/html' } }))
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(html.fetch))).toEqual({ ok: false, failure: 'unreachable' })

    clearCctvCache()
    const declared = fakeFetch(() => new Response(jpeg(), { headers: { 'content-length': String(3 * 1024 * 1024) } }))
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(declared.fetch))).toEqual({ ok: false, failure: 'unreachable' })

    clearCctvCache()
    const big = new Uint8Array(CCTV_POLICY['bma-floodcam'].maxBytes + 10)
    big.set(jpeg())
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(big.subarray(0, 1024 * 1024))
              c.enqueue(big.subarray(1024 * 1024))
              c.close()
            },
          }),
        ),
    )
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(streamed.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    expect(cctvImageStats('bma-floodcam', t).frames1h).toMatchObject({ ok: 0, fail: 1 })
  })

  it('treats upstream errors and timeouts as unreachable', async () => {
    const http = fakeFetch(() => new Response('oops', { status: 520 }))
    expect(await getCctvImage('bma-floodcam', CAM, REF, deps(http.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    clearCctvCache()
    const slow = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const res = await getCctvImage('bma-floodcam', CAM, REF, deps(slow.fetch, { policy: { timeoutMs: 20 } }))
    expect(res).toEqual({ ok: false, failure: 'unreachable' })
  })

  it('keeps X-Cctv-Changed-At while the picture does not change (frozen camera)', async () => {
    let seed = 1
    const { fetch } = fakeFetch(() => new Response(jpeg(352, 288, seed)))
    const first = await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    const t0 = t
    t += 61_000
    const same = await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    expect(same.ok && first.ok && same.frame.fetchedAt > first.frame.fetchedAt).toBe(true)
    expect(same.ok && same.frame.changedAt).toBe(t0)
    seed = 2
    t += 61_000
    const changed = await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    expect(changed.ok && changed.frame.changedAt).toBe(t)
  })

  it('limits upstream requests in flight per source and refuses when the queue is full or the wait too long', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { fetch, calls } = fakeFetch(async () => {
      await gate
      return new Response(jpeg())
    })
    const policy = { maxInFlight: 1, maxQueue: 1, queueWaitMs: 30 }
    const first = getCctvImage('bma-floodcam', 'bma-floodcam:1', REF, deps(fetch, { policy }))
    await new Promise((r) => setTimeout(r, 2))
    const queued = getCctvImage('bma-floodcam', 'bma-floodcam:2', REF, deps(fetch, { policy }))
    const refused = await getCctvImage('bma-floodcam', 'bma-floodcam:3', REF, deps(fetch, { policy }))
    expect(refused).toEqual({ ok: false, failure: 'busy' })
    expect(await queued).toEqual({ ok: false, failure: 'busy' }) // waited 30 ms, then gave up
    release()
    expect((await first).ok).toBe(true)
    expect(calls).toHaveLength(1)
    // A refusal is not remembered as a camera failure: the next request may try at once.
    expect((await getCctvImage('bma-floodcam', 'bma-floodcam:3', REF, deps(fetch, { policy }))).ok).toBe(true)
    expect(cctvImageStats('bma-floodcam', t).frames1h.refused).toBe(2)
  })

  it('hands a freed slot to the next queued request', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { fetch, calls } = fakeFetch(async (_u, _i, n) => {
      if (n === 1) await gate
      return new Response(jpeg())
    })
    const policy = { maxInFlight: 1, maxQueue: 5, queueWaitMs: 5_000 }
    const first = getCctvImage('bma-floodcam', 'bma-floodcam:1', REF, deps(fetch, { policy }))
    await new Promise((r) => setTimeout(r, 2))
    const second = getCctvImage('bma-floodcam', 'bma-floodcam:2', REF, deps(fetch, { policy }))
    await new Promise((r) => setTimeout(r, 2))
    expect(calls).toHaveLength(1)
    release()
    expect((await first).ok && (await second).ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(cctvImageStats('bma-floodcam', t).inFlight).toBe(0)
  })

  it('stops at the hourly upstream budget (503) and resumes when the hour has passed', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg()))
    const policy = { hourlyBudget: 2 }
    expect((await getCctvImage('bma-floodcam', 'bma-floodcam:1', REF, deps(fetch, { policy }))).ok).toBe(true)
    expect((await getCctvImage('bma-floodcam', 'bma-floodcam:2', REF, deps(fetch, { policy }))).ok).toBe(true)
    expect(await getCctvImage('bma-floodcam', 'bma-floodcam:3', REF, deps(fetch, { policy }))).toEqual({ ok: false, failure: 'budget' })
    expect(calls).toHaveLength(2)
    t += 61 * 60_000
    expect((await getCctvImage('bma-floodcam', 'bma-floodcam:3', REF, deps(fetch, { policy }))).ok).toBe(true)
    expect(cctvImageStats('bma-floodcam', t).frames1h).toEqual({ ok: 1, fail: 0, refused: 0, budgetLeft: CCTV_POLICY['bma-floodcam'].hourlyBudget - 1 })
  })
})

describe('DWR river-camera frames', () => {
  const DWR_REF = '0b8f5a2e-1111-4222-8333-944455556666'

  it('asks for the snapshot path, then POSTs it for the image; capture time comes from the path', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes('/reportCctv/snapshot/') ? Response.json({ value: '/TA100220/2026/10/4/10_15.jpg' }) : new Response(jpeg(704, 576)),
    )
    const res = await getCctvImage('dwr-cctv', 'dwr-cctv:TA100220', DWR_REF, deps(fetch))
    expect(res).toMatchObject({ ok: true, stale: false, ttlMs: 5 * 60_000 })
    expect(res.ok && res.frame.capturedAt).toBe('2026-10-04T03:15:00.000Z')
    expect(res.ok && res.frame.width).toBe(704)
    expect(calls.map((c) => c.url)).toEqual([
      `https://telemetry.dwr.go.th/api/public/reportCctv/snapshot/${DWR_REF}`,
      'https://telemetry.dwr.go.th/api/file/image/cctv',
    ])
    expect(calls[1]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ path: '/TA100220/2026/10/4/10_15.jpg' })
    expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true)
  })

  it('reports no-image when DWR has no still, and refuses odd paths without a second request', async () => {
    const empty = fakeFetch(() => Response.json({ value: '' }))
    expect(await getCctvImage('dwr-cctv', 'dwr-cctv:A', DWR_REF, deps(empty.fetch))).toEqual({ ok: false, failure: 'no-image' })
    expect(empty.calls).toHaveLength(1)

    const missing = fakeFetch((url) => (url.includes('/snapshot/') ? Response.json({ value: '/TA1/2026/10/4/1_1.jpg' }) : new Response(null, { status: 404 })))
    expect(await getCctvImage('dwr-cctv', 'dwr-cctv:B', DWR_REF, deps(missing.fetch))).toEqual({ ok: false, failure: 'no-image' })

    const odd = fakeFetch(() => Response.json({ value: 'https://evil.example.invalid/x.jpg' }))
    expect(await getCctvImage('dwr-cctv', 'dwr-cctv:C', DWR_REF, deps(odd.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    expect(odd.calls).toHaveLength(1)

    const bad = fakeFetch(() => Response.json({ value: '/x.jpg' }))
    expect(await getCctvImage('dwr-cctv', 'dwr-cctv:D', 'not a uuid/../', deps(bad.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    expect(bad.calls).toHaveLength(0)
  })
})

describe('image responses', () => {
  it('sets cache, freshness and safety headers', async () => {
    const frame = { bytes: jpeg(), type: 'image/jpeg' as const, fetchedAt: t - 20_000, capturedAt: '2026-10-04T02:45:00.000Z', changedAt: t - 600_000, width: 352, height: 288 }
    const res = cctvFrameResponse(frame, false, 60_000, t)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('public, max-age=40')
    expect(res.headers.get('x-cctv-fetched-at')).toBe(new Date(t - 20_000).toISOString())
    expect(res.headers.get('x-cctv-captured-at')).toBe('2026-10-04T02:45:00.000Z')
    expect(res.headers.get('x-cctv-changed-at')).toBe(new Date(t - 600_000).toISOString())
    expect(res.headers.get('x-cctv-stale')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    const stale = cctvFrameResponse(frame, true, 60_000, t + 120_000)
    expect(stale.headers.get('cache-control')).toBe('public, max-age=60')
    expect(stale.headers.get('x-cctv-stale')).toBe('1')
  })

  it('maps failures to Thai messages and status codes', () => {
    expect(cctvFailure('unreachable')).toMatchObject({ status: 502, message: 'ติดต่อกล้องไม่ได้ในขณะนี้' })
    expect(cctvFailure('no-image')).toMatchObject({ status: 502, message: 'หน่วยงานยังไม่มีภาพจากกล้องนี้' })
    expect(cctvFailure('budget')).toMatchObject({ status: 503, message: 'ระบบพักการดึงภาพชั่วคราว' })
    expect(cctvFailure('busy').headers['Retry-After']).toBe('30')
    // This client's own limits: 429, never cached by shared caches.
    expect(cctvFailure('limited', 42)).toEqual({ status: 429, message: CCTV_MSG.limited, headers: { 'Retry-After': '42', 'Cache-Control': 'no-store' } })
    // This server cannot fetch the source right now: link out.
    expect(cctvFailure('unavailable', 1800)).toEqual({ status: 503, message: CCTV_MSG.unavailable, headers: { 'Retry-After': '1800' } })
    expect([CCTV_MSG.limited, CCTV_MSG.unavailable].every((m) => /[฀-๿]/.test(m))).toBe(true)
  })

  it('parses Retry-After in seconds or as an HTTP date', () => {
    expect(parseRetryAfterMs('120', t)).toBe(120_000)
    expect(parseRetryAfterMs(new Date(t + 90_000).toUTCString(), t)).toBe(90_000)
    expect(parseRetryAfterMs('soon', t)).toBeNull()
    expect(parseRetryAfterMs(null, t)).toBeNull()
  })
})

describe('ImageCache', () => {
  const policy = { ttlMs: 1_000, failTtlMs: 500, staleMaxMs: 5_000 }

  it('evicts the least recently used entry beyond its capacity', async () => {
    const clock = 0
    const cache = new ImageCache<{ fetchedAt: number }>(2)
    const load = async () => ({ fetchedAt: clock })
    await cache.get('a', policy, load, () => clock)
    await cache.get('b', policy, load, () => clock)
    await cache.get('a', policy, load, () => clock) // a is now the most recent
    await cache.get('c', policy, load, () => clock)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.size).toBe(2)
  })

  it('forgets values older than the stale limit and does not remember refusals', async () => {
    let clock = 0
    const cache = new ImageCache<{ fetchedAt: number }>(10)
    await cache.get('a', policy, async () => ({ fetchedAt: clock }), () => clock)
    clock = 5_001
    await cache.get('other', policy, async () => ({ fetchedAt: clock }), () => clock)
    expect(cache.has('a')).toBe(false)

    const refused = await cache.get('b', policy, async () => Promise.reject(new NotAttemptedError('budget')), () => clock)
    expect(refused.ok).toBe(false)
    const load = vi.fn(async () => ({ fetchedAt: clock }))
    expect((await cache.get('b', policy, load, () => clock)).ok).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('prune() drops values at their stale limit without any request (with an optional look-ahead)', async () => {
    const cache = new ImageCache<{ fetchedAt: number }>(10)
    await cache.get('a', policy, async () => ({ fetchedAt: 0 }), () => 0)
    cache.prune(4_000)
    expect(cache.has('a')).toBe(true)
    cache.prune(4_000, 1_000) // a sweep every second: 'a' would pass 5 s before the next one
    expect(cache.has('a')).toBe(false)
  })

  it('peek() tells whether a request would go upstream, without loading', async () => {
    let clock = 0
    const cache = new ImageCache<{ fetchedAt: number }>(10)
    expect(cache.peek('a', policy, clock)).toEqual({ wouldLoad: true, value: null })
    await cache.get('a', policy, async () => ({ fetchedAt: clock }), () => clock)
    expect(cache.peek('a', policy, clock)).toEqual({ wouldLoad: false, value: { fetchedAt: 0 } })
    clock = 2_000 // past the TTL, within the stale limit
    expect(cache.peek('a', policy, clock)).toEqual({ wouldLoad: true, value: { fetchedAt: 0 } })
    await cache.get('a', policy, async () => Promise.reject(new Error('down')), () => clock)
    expect(cache.peek('a', policy, clock).wouldLoad).toBe(false) // failure remembered
    let release!: () => void
    const pending = cache.get('b', policy, () => new Promise((r) => (release = () => r({ fetchedAt: clock }))), () => clock)
    expect(cache.peek('b', policy, clock).wouldLoad).toBe(false) // joins the running fetch
    release()
    await pending
  })
})

describe('host-level reachability', () => {
  async function storeWithRefs() {
    const { SqliteStore } = await import('@/lib/store/sqlite')
    const { saveCameraCatalog } = await import('@/lib/cameras/catalog')
    const store = new SqliteStore(':memory:')
    const camera = {
      id: CAM, source: 'bma-floodcam' as const, nativeId: '101', siteId: 'bma-floodcam:13.70000,100.60000', name: 'จุดทดสอบ',
      code: null, angle: null, owner: 'สำนักการระบายน้ำ กทม.', lat: 13.7, lng: 100.6, facing: 'road' as const,
      nearStationIds: [], officialUrl: 'https://floodbangkok.bangkok.go.th/', cadenceMin: null,
    }
    const at = new Date(t)
    await saveCameraCatalog(store, { source: 'bma-floodcam', fetchedAt: at.toISOString(), cameras: [camera], refs: [{ cameraId: CAM, ref: REF }], warnings: [] }, at)
    return store
  }
  const cfg = async () => (await import('@/lib/config')).loadConfig({}, { warn: () => undefined, cwd: '/srv/app' })

  it('switches a source to link-outs after repeated failures on a host that never got a frame', async () => {
    const { canServeImages, SOURCE_DOWN_AFTER, SOURCE_DOWN_MS } = await import('@/lib/server/cctv-proxy')
    const store = await storeWithRefs()
    const config = await cfg()
    expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(true)
    const down = fakeFetch(() => new Response('blocked', { status: 403 }))
    for (let i = 0; i < SOURCE_DOWN_AFTER; i++) {
      const res = await getCctvImage('bma-floodcam', `bma-floodcam:${200 + i}`, `rtsp://example.invalid/cam/${200 + i}`, deps(down.fetch))
      expect(res.ok).toBe(false)
    }
    expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(false)
    expect(await canServeImages(config, store, 'bma-floodcam', t + SOURCE_DOWN_MS + 1)).toBe(true)
    store.close()
  })

  it('never gives up on a host that has fetched frames before', async () => {
    const { SOURCE_DOWN_AFTER, canServeImages } = await import('@/lib/server/cctv-proxy')
    const store = await storeWithRefs()
    const ok = fakeFetch(() => new Response(jpeg(), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    expect((await getCctvImage('bma-floodcam', CAM, REF, deps(ok.fetch))).ok).toBe(true)
    const bad = fakeFetch(() => new Response('x', { status: 502 }))
    for (let i = 0; i < SOURCE_DOWN_AFTER + 2; i++) {
      await getCctvImage('bma-floodcam', `bma-floodcam:${300 + i}`, `rtsp://example.invalid/cam/${300 + i}`, deps(bad.fetch))
    }
    expect(await canServeImages(await cfg(), store, 'bma-floodcam', t)).toBe(true)
    store.close()
  })

  const ok = () => new Response(jpeg())
  const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => `bma-floodcam:${from + i}`)
  const get = (id: string, f: typeof fetch, extra: Partial<CctvFetchDeps> = {}) =>
    getCctvImage('bma-floodcam', id, `rtsp://example.invalid/cam/${id.split(':')[1]}`, deps(f, extra))
  const quiet = () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    return { lines, restore: () => spy.mockRestore() }
  }

  it('does not switch a fresh host off for camera-level failures (HTTP 5xx/404, placeholders, timeouts)', async () => {
    const store = await storeWithRefs()
    const config = await cfg()
    const png = new Uint8Array(89)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const cameraLevel: ((url: string, init: RequestInit) => Response | Promise<Response>)[] = [
      () => new Response('camera offline', { status: 500 }),
      () => new Response('', { status: 404 }),
      () => new Response(png),
      (_u, init) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    ]
    for (const respond of cameraLevel) {
      clearCctvCache()
      const { fetch, calls } = fakeFetch(respond)
      for (const id of ids(SOURCE_DOWN_AFTER + 2, 300)) expect((await get(id, fetch, { policy: { timeoutMs: 20 } })).ok).toBe(false)
      expect(calls).toHaveLength(SOURCE_DOWN_AFTER + 2)
      expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(true)
    }
    // A malformed reference is never sent and says nothing about the host either.
    clearCctvCache()
    const none = fakeFetch(ok)
    for (let i = 0; i < SOURCE_DOWN_AFTER; i++) await getCctvImage('bma-floodcam', `bma-floodcam:${400 + i}`, 'javascript:x', deps(none.fetch))
    expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(true)

    // Being turned away does count: network errors, HTML / challenge pages.
    const log = quiet()
    try {
      for (const respond of [
        () => Promise.reject(new TypeError('fetch failed')),
        () => new Response('<!DOCTYPE html><title>Just a moment...</title>', { headers: { 'content-type': 'text/html' } }),
      ]) {
        clearCctvCache()
        const { fetch } = fakeFetch(respond)
        for (const id of ids(SOURCE_DOWN_AFTER, 300)) await get(id, fetch)
        expect(await cctvImageAvailability(config, store, 'bma-floodcam', t)).toEqual({ images: false, reason: 'host-unreachable', until: t + SOURCE_DOWN_MS })
      }
    } finally {
      log.restore()
    }
    store.close()
  })

  it('counts an oversize challenge page on the DWR snapshot step as being turned away', async () => {
    const store = await storeWithRefs()
    const page = `<!DOCTYPE html><html><body>${'x'.repeat(20_000)}</body></html>`
    const { fetch, calls } = fakeFetch(() => new Response(page, { headers: { 'content-type': 'text/html' } }))
    const log = quiet()
    try {
      for (let i = 0; i < SOURCE_DOWN_AFTER; i++) expect(await getCctvImage('dwr-cctv', `dwr-cctv:S${i}`, `S${i}`, deps(fetch))).toMatchObject({ ok: false })
    } finally {
      log.restore()
    }
    expect(calls).toHaveLength(SOURCE_DOWN_AFTER) // never reached the image step
    expect(await cctvImageAvailability(await cfg(), store, 'dwr-cctv', t)).toMatchObject({ images: false, reason: 'host-unreachable' })
    store.close()
  })

  it('once a fresh host gives up, queued requests never go upstream and it is logged once', async () => {
    const store = await storeWithRefs()
    const log = quiet()
    try {
      let failAll!: (e: Error) => void
      const failing = new Promise<Response>((_, reject) => (failAll = reject))
      failing.catch(() => undefined)
      const { fetch, calls } = fakeFetch(() => failing)
      const pending = ids(12, 500).map((id) => get(id, fetch)) // 3 in flight, 9 queued
      await new Promise((r) => setTimeout(r, 5))
      expect(calls).toHaveLength(CCTV_POLICY['bma-floodcam'].maxInFlight)
      failAll(new TypeError('fetch failed'))
      const results = await Promise.all(pending)
      expect(calls).toHaveLength(3)
      expect(results.every((r) => !r.ok)).toBe(true)
      expect(results.filter((r) => !r.ok && r.failure === 'unavailable').length).toBeGreaterThanOrEqual(9)
      expect(log.lines.filter((l) => l.includes('images unreachable from this server'))).toHaveLength(1)
      // Later requests are answered at once, with how long it lasts.
      expect(await get('bma-floodcam:900', fetch)).toEqual({ ok: false, failure: 'unavailable', retryAfterSec: SOURCE_DOWN_MS / 1000 })
      expect(calls).toHaveLength(3)
    } finally {
      log.restore()
    }
    store.close()
  })

  it('pauses the whole source on HTTP 429, honouring Retry-After (capped at 1 h), even on a host that had frames', async () => {
    const store = await storeWithRefs()
    const config = await cfg()
    const log = quiet()
    try {
      let answer: () => Response = ok
      const { fetch, calls } = fakeFetch(() => answer())
      expect((await get('bma-floodcam:1', fetch)).ok).toBe(true)
      answer = () => new Response('slow down', { status: 429, headers: { 'Retry-After': '3600' } })
      expect(await get('bma-floodcam:2', fetch)).toEqual({ ok: false, failure: 'unavailable', retryAfterSec: 3600 })
      expect(await cctvImageAvailability(config, store, 'bma-floodcam', t)).toEqual({ images: false, reason: 'agency-backoff', until: t + 3600_000 })
      // The frame it already had is still served while young enough.
      t += 61_000
      expect(await get('bma-floodcam:1', fetch)).toMatchObject({ ok: true, stale: true })
      // 20 cameras once a minute: none of it reaches the agency.
      for (let i = 0; i < 20; i++) {
        t += 60_000
        expect(await get(`bma-floodcam:${100 + i}`, fetch)).toMatchObject({ ok: false, failure: 'unavailable' })
      }
      expect(calls).toHaveLength(2)
      expect(log.lines.filter((l) => l.includes('refusing image requests'))).toHaveLength(1)
      t += 40 * 60_000 // the hour is over
      answer = ok
      expect((await get('bma-floodcam:200', fetch)).ok).toBe(true)
      expect(calls).toHaveLength(3)
      // An absurd Retry-After is capped at an hour.
      answer = () => new Response('', { status: 429, headers: { 'Retry-After': '999999' } })
      await get('bma-floodcam:201', fetch)
      expect((await cctvImageAvailability(config, store, 'bma-floodcam', t)).until).toBe(t + BACKOFF_MAX_MS)
    } finally {
      log.restore()
    }
    store.close()
  })

  it('backs off after three 403s in a row on a host that had frames (a single one is sporadic), and on 503 with Retry-After', async () => {
    const store = await storeWithRefs()
    const config = await cfg()
    const log = quiet()
    try {
      let answer: () => Response = ok
      const { fetch } = fakeFetch(() => answer())
      expect((await get('bma-floodcam:1', fetch)).ok).toBe(true)
      answer = () => new Response('forbidden', { status: 403 })
      expect(await get('bma-floodcam:2', fetch)).toEqual({ ok: false, failure: 'unreachable' })
      answer = ok
      expect((await get('bma-floodcam:3', fetch)).ok).toBe(true) // the streak is broken
      answer = () => new Response('forbidden', { status: 403 })
      expect(await get('bma-floodcam:4', fetch)).toEqual({ ok: false, failure: 'unreachable' })
      expect(await get('bma-floodcam:5', fetch)).toEqual({ ok: false, failure: 'unreachable' })
      expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(true)
      expect(await get('bma-floodcam:6', fetch)).toMatchObject({ ok: false, failure: 'unavailable' })
      expect(await cctvImageAvailability(config, store, 'bma-floodcam', t)).toEqual({ images: false, reason: 'agency-backoff', until: t + BACKOFF_BASE_MS })

      clearCctvCache()
      answer = () => new Response('', { status: 503 })
      await get('bma-floodcam:7', fetch)
      expect(await canServeImages(config, store, 'bma-floodcam', t)).toBe(true) // no Retry-After: a camera error
      answer = () => new Response('', { status: 503, headers: { 'Retry-After': '120' } })
      await get('bma-floodcam:8', fetch)
      expect(await cctvImageAvailability(config, store, 'bma-floodcam', t)).toEqual({ images: false, reason: 'agency-backoff', until: t + 120_000 })
    } finally {
      log.restore()
    }
    store.close()
  })
})

describe('per-client limits (one client cannot use up the shared queue or budget)', () => {
  const ok = () => new Response(jpeg())
  const get = (id: string, f: typeof fetch, extra: Partial<CctvFetchDeps> = {}) =>
    getCctvImage('bma-floodcam', id, `rtsp://example.invalid/cam/${id.split(':')[1]}`, deps(f, extra))
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const hold = () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    return { release, respond: async () => (await held, ok()) }
  }

  it('charges only cache misses to the client, serves its stale frame when it runs out, and leaves others alone', async () => {
    const limiter = new RateLimiter(now)
    const { fetch, calls } = fakeFetch(ok)
    const a = { client: '198.51.100.66', limiter }
    const n = LIMITS.cctvMiss.capacity
    for (let i = 0; i < n; i++) expect((await get(`bma-floodcam:${i}`, fetch, a)).ok).toBe(true)
    expect((await get('bma-floodcam:0', fetch, a)).ok).toBe(true) // a hit costs nothing
    expect(calls).toHaveLength(n)
    const limited = await get(`bma-floodcam:${n}`, fetch, a)
    expect(limited).toMatchObject({ ok: false, failure: 'limited' })
    expect(!limited.ok && limited.retryAfterSec).toBeGreaterThan(0)
    expect(calls).toHaveLength(n)
    expect((await get(`bma-floodcam:${n}`, fetch, { client: '203.0.113.9', limiter })).ok).toBe(true)
    expect((await get(`bma-floodcam:${n + 1}`, fetch, { client: null, limiter })).ok).toBe(true) // unknown IP: per-source limits only

    // Past its TTL, a client without tokens gets the last good frame rather than a 429.
    t += 61_000
    while (limiter.take('cctvMiss:198.51.100.66', LIMITS.cctvMiss).ok) {
      // spend what refilled meanwhile
    }
    expect(await get('bma-floodcam:0', fetch, a)).toMatchObject({ ok: true, stale: true })
    expect(calls).toHaveLength(n + 2)
    // The bucket refills over its window.
    t += LIMITS.cctvMiss.windowMs
    expect((await get('bma-floodcam:0', fetch, a)).ok).toBe(true)
    expect(calls).toHaveLength(n + 3)
  })

  it(`lets one client have at most ${CLIENT_MAX_MISSES} upstream fetches going; its other misses wait in its own line`, async () => {
    const h = hold()
    const { fetch, calls } = fakeFetch(h.respond)
    const limiter = new RateLimiter(now)
    const mine = Array.from({ length: 4 }, (_, i) => get(`bma-floodcam:${i}`, fetch, { client: 'A', limiter }))
    await tick()
    expect(calls).toHaveLength(CLIENT_MAX_MISSES)
    const stats = cctvImageStats('bma-floodcam', t)
    expect(stats.inFlight + stats.queued).toBe(CLIENT_MAX_MISSES) // the shared queue holds no more of A
    const other = get('bma-floodcam:50', fetch, { client: 'B', limiter }) // the third slot is free for B
    await tick()
    expect(calls).toHaveLength(CLIENT_MAX_MISSES + 1)
    h.release()
    expect((await Promise.all([...mine, other])).every((r) => r.ok)).toBe(true)
    expect(calls).toHaveLength(5)
  })

  it('answers 429 when the client line is full and lets an abandoned request leave it', async () => {
    const h = hold()
    const { fetch } = fakeFetch(h.respond)
    const limiter = new RateLimiter(now)
    const a = { client: 'A', limiter }
    const pending = Array.from({ length: CLIENT_MAX_MISSES + CLIENT_MAX_WAITING - 1 }, (_, i) => get(`bma-floodcam:${i}`, fetch, a))
    await tick()
    const ctrl = new AbortController()
    const leaving = get('bma-floodcam:70', fetch, { ...a, signal: ctrl.signal, policy: { queueWaitMs: 60_000 } })
    await tick()
    expect(await get('bma-floodcam:71', fetch, a)).toMatchObject({ ok: false, failure: 'limited', retryAfterSec: 15 })
    ctrl.abort()
    expect(await leaving).toEqual({ ok: false, failure: 'busy' }) // at once, not after 60 s
    const next = get('bma-floodcam:71', fetch, a) // the freed place in the line
    h.release()
    expect((await Promise.all([...pending, next])).every((r: CctvImageOutcome) => r.ok)).toBe(true)
  })

  it('lets an abandoned request leave the source queue at once (it is not counted as refused)', async () => {
    const h = hold()
    const { fetch, calls } = fakeFetch(h.respond)
    const policy = { maxInFlight: 1, maxQueue: 1, queueWaitMs: 60_000 }
    const first = get('bma-floodcam:1', fetch, { policy })
    await tick()
    const ctrl = new AbortController()
    const queued = get('bma-floodcam:2', fetch, { policy, signal: ctrl.signal })
    await tick()
    expect(cctvImageStats('bma-floodcam', t).queued).toBe(1)
    expect(await get('bma-floodcam:3', fetch, { policy })).toEqual({ ok: false, failure: 'busy' }) // queue full
    ctrl.abort()
    expect(await queued).toEqual({ ok: false, failure: 'busy' })
    expect(cctvImageStats('bma-floodcam', t).queued).toBe(0)
    const again = get('bma-floodcam:3', fetch, { policy })
    await tick()
    expect(cctvImageStats('bma-floodcam', t).queued).toBe(1)
    h.release()
    expect((await first).ok && (await again).ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(cctvImageStats('bma-floodcam', t).frames1h.refused).toBe(1)
  })

  it('reports the remaining hourly budget only coarsely', async () => {
    const policy = CCTV_POLICY['bma-floodcam']
    const saved = policy.hourlyBudget
    policy.hourlyBudget = 8
    try {
      const { fetch } = fakeFetch(ok)
      for (let i = 0; i < 6; i++) await get(`bma-floodcam:${i}`, fetch)
      expect(cctvImageStats('bma-floodcam', t).budget).toBe('ok')
      await get('bma-floodcam:6', fetch)
      expect(cctvImageStats('bma-floodcam', t).budget).toBe('low')
      await get('bma-floodcam:7', fetch)
      expect(cctvImageStats('bma-floodcam', t).budget).toBe('spent')
    } finally {
      policy.hourlyBudget = saved
    }
  })
})

describe('server deadline (below the client watchdog)', () => {
  it('keeps queue wait + upstream deadline within CCTV_SERVER_MAX_MS (≤ 40 s) for every source', () => {
    expect(CCTV_SERVER_MAX_MS).toBeLessThanOrEqual(40_000)
    for (const p of Object.values(CCTV_POLICY)) expect(p.queueWaitMs + p.timeoutMs).toBeLessThanOrEqual(CCTV_SERVER_MAX_MS)
  })

  it('gives the two DWR steps one shared deadline', async () => {
    const step = 150
    const { fetch, calls } = fakeFetch(
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(url.includes('/snapshot/') ? Response.json({ value: '/TA100220/2026/10/4/10_15.jpg' }) : new Response(jpeg())), step)
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(init.signal?.reason)
          })
        }),
    )
    // Each step alone fits in the deadline; both together do not.
    const res = await getCctvImage('dwr-cctv', 'dwr-cctv:A', 'TA100220', deps(fetch, { policy: { timeoutMs: 250 } }))
    expect(res).toEqual({ ok: false, failure: 'unreachable' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.init.signal).toBe(calls[1]!.init.signal)
  })
})

describe('frame retention (memory only, dropped on time)', () => {
  type Mem = { __floodCctv: { frames: ImageCache<{ fetchedAt: number }>; hashes: Map<string, unknown> } }
  const mem = () => (globalThis as unknown as Mem).__floodCctv

  it('drops frames by their stale limit and frame hashes after 2 h on a timer, with no further requests', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldClearNativeTimers: true })
    try {
      startCctvSweeper()
      const { fetch } = fakeFetch(() => new Response(jpeg()))
      expect((await getCctvImage('bma-floodcam', CAM, REF, { fetch })).ok).toBe(true)
      expect(mem().frames.size).toBe(1)
      const staleMax = CCTV_POLICY['bma-floodcam'].staleMaxMs
      vi.advanceTimersByTime(staleMax - 2 * CCTV_SWEEP_MS)
      expect(mem().frames.size).toBe(1)
      vi.advanceTimersByTime(CCTV_SWEEP_MS) // the last sweep before the limit
      expect(mem().frames.size).toBe(0)
      expect(mem().hashes.size).toBe(1) // a hash is no image, but it is not kept for long either
      vi.advanceTimersByTime(HASH_MAX_AGE_MS)
      expect(mem().hashes.size).toBe(0)
    } finally {
      vi.useRealTimers()
      startCctvSweeper()
    }
  })

  it('a sweep never keeps a frame past its limit until the next sweep', async () => {
    const { fetch } = fakeFetch(() => new Response(jpeg()))
    expect((await getCctvImage('dwr-cctv', 'dwr-cctv:B', 'TA100220', deps(fakeFetch((url) => (url.includes('/snapshot/') ? Response.json({ value: '/TA1/2026/10/4/1_1.jpg' }) : new Response(jpeg()))).fetch))).ok).toBe(true)
    expect((await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))).ok).toBe(true)
    sweepCctvMemory(t + 15 * 60_000 - CCTV_SWEEP_MS + 1)
    expect(mem().frames.has(CAM)).toBe(false)
    expect(mem().frames.has('dwr-cctv:B')).toBe(true) // DWR frames may be kept for an hour
    sweepCctvMemory(t + 60 * 60_000 - CCTV_SWEEP_MS + 1)
    expect(mem().frames.size).toBe(0)
  })
})

describe('startup warnings', () => {
  const load = async (env: Record<string, string>) => (await import('@/lib/config')).loadConfig(env, { warn: () => undefined, cwd: '/srv/app' })

  it('warns when agency stills are on without a trusted client IP or a contact address', async () => {
    const both = cctvConfigWarnings(await load({}))
    expect(both).toHaveLength(2)
    expect(both[0]).toMatch(/TRUST_PROXY=none/)
    expect(both[1]).toMatch(/CONTACT_EMAIL/)
    expect(cctvConfigWarnings(await load({ TRUST_PROXY: 'cloudflare', CONTACT_EMAIL: 'privacy@example.org' }))).toEqual([])
    expect(cctvConfigWarnings(await load({ TRUST_PROXY: 'xff', CONTACT_EMAIL: 'not an address' })).join('\n')).toMatch(/CONTACT_EMAIL/)
    for (const env of [{ CCTV_IMAGES: '0' }, { CCTV_SOURCES: 'none' }, { DATA_MODE: 'fixture' }, { VERCEL: '1' }] as Record<string, string>[]) {
      expect(cctvConfigWarnings(await load(env))).toEqual([])
    }
  })

  it('logs them once per process, from onServerStart', async () => {
    const keys = ['TRUST_PROXY', 'CONTACT_EMAIL', 'CCTV_IMAGES', 'CCTV_SOURCES', 'DATA_MODE', 'VERCEL'] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    const { resetConfigCache } = await import('@/lib/config')
    const { onServerStart } = await import('@/lib/server/lifecycle')
    for (const k of keys) delete process.env[k]
    resetConfigCache()
    __resetCctvWarningsForTests()
    try {
      const logs: string[] = []
      onServerStart({}, { log: (m) => logs.push(m) })
      onServerStart({}, { log: (m) => logs.push(m) })
      const cctv = logs.filter((l) => l.startsWith('[cctv] WARNING:'))
      expect(cctv).toHaveLength(2)
      expect(cctv.join('\n')).toMatch(/TRUST_PROXY=none[\s\S]*CONTACT_EMAIL/)
      const again: string[] = []
      logCctvConfigWarnings((await import('@/lib/config')).getConfig(), (m) => again.push(m))
      expect(again).toEqual([])
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      resetConfigCache()
      __resetCctvWarningsForTests()
    }
  })
})

describe('upstream answers seen on real hosts', () => {
  it('follows a same-origin redirect, never one to another host', async () => {
    const same = fakeFetch((url, _i, n) =>
      n === 1 ? new Response(null, { status: 302, headers: { location: '/api/proxy/?rtcUrl=x' } }) : new Response(jpeg()),
    )
    expect((await getCctvImage('bma-floodcam', CAM, REF, deps(same.fetch))).ok).toBe(true)
    expect(same.calls[1]!.url).toBe('https://floodbangkok.bangkok.go.th/api/proxy/?rtcUrl=x')
    clearCctvCache()
    const away = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal' } }))
    expect(await getCctvImage('bma-floodcam', 'bma-floodcam:9', REF, deps(away.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    expect(away.calls).toHaveLength(1)
    const { cctvImageStats } = await import('@/lib/server/cctv-proxy')
    expect(cctvImageStats('bma-floodcam', t).lastFailure?.reason).toBe('HTTP 302 redirect to another host')
  })

  it('accepts PNG and WebP stills with the right content type, and treats tiny pictures as placeholders', async () => {
    const { validateImage } = await import('@/lib/server/cctv-proxy')
    const png = (w: number, h: number) => {
      const b = new Uint8Array(64)
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      new DataView(b.buffer).setUint32(16, w)
      new DataView(b.buffer).setUint32(20, h)
      return b
    }
    expect(validateImage(png(640, 360))).toMatchObject({ type: 'image/png', width: 640, height: 360 })
    expect(() => validateImage(png(1, 1))).toThrow(/placeholder/)
    const webp = new Uint8Array(2048)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8 '), 8)
    expect(validateImage(webp).type).toBe('image/webp')
    expect(() => validateImage(new TextEncoder().encode('<!DOCTYPE html><html>challenge</html>'))).toThrow(/not an image/)

    const f = fakeFetch(() => new Response(png(640, 360), { headers: { 'content-type': 'image/png' } }))
    const res = await getCctvImage('bma-floodcam', CAM, REF, deps(f.fetch))
    expect(res.ok && res.frame.type).toBe('image/png')
    expect(res.ok && cctvFrameResponse(res.frame, false, 60_000, t).headers.get('content-type')).toBe('image/png')
  })

  it('reports why the latest still failed, without camera ids, and logs each reason once', async () => {
    const { cctvImageStats } = await import('@/lib/server/cctv-proxy')
    const f = fakeFetch(() => new Response('nope', { status: 500 }))
    await getCctvImage('bma-floodcam', 'bma-floodcam:1', REF, deps(f.fetch))
    const stats = cctvImageStats('bma-floodcam', t)
    expect(stats.lastFailure).toEqual({ reason: 'HTTP 500', at: new Date(t).toISOString() })
    expect(JSON.stringify(stats)).not.toContain('bma-floodcam:1')
    expect(JSON.stringify(stats)).not.toContain('example.invalid')
  })
})

describe('agency errors on a host that never gave a frame', () => {
  it('rests the source after 8 server errors in a row so the UI shows agency links', async () => {
    const { AGENCY_ERROR_AFTER, cctvImageStats } = await import('@/lib/server/cctv-proxy')
    const f = fakeFetch(() => new Response('{"error":"internal server error"}', { status: 500, headers: { 'content-type': 'application/json' } }))
    for (let i = 0; i < AGENCY_ERROR_AFTER - 1; i++) {
      expect(await getCctvImage('bma-floodcam', `bma-floodcam:${400 + i}`, REF, deps(f.fetch))).toEqual({ ok: false, failure: 'unreachable' })
    }
    const last = await getCctvImage('bma-floodcam', 'bma-floodcam:499', REF, deps(f.fetch))
    expect(last).toMatchObject({ ok: false, failure: 'unavailable', retryAfterSec: 900 })
    const calls = f.calls.length
    expect(await getCctvImage('bma-floodcam', 'bma-floodcam:498', REF, deps(f.fetch))).toMatchObject({ ok: false, failure: 'unavailable' })
    expect(f.calls.length).toBe(calls) // no upstream call while rested
    expect(cctvImageStats('bma-floodcam', t).lastFailure?.reason).toBe('HTTP 500')
  })
})
