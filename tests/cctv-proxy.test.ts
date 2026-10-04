import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BMA_FLOODCAM_PROXY,
  CCTV_POLICY,
  cctvFailure,
  cctvFrameResponse,
  cctvImagePath,
  cctvImageStats,
  clearCctvCache,
  dwrCaptureTime,
  getCctvImage,
  isJpeg,
  jpegSize,
  parseCctvImageFile,
  trimJpeg,
  validateJpeg,
  type CctvFetchDeps,
} from '@/lib/server/cctv-proxy'
import { ImageCache, NotAttemptedError } from '@/lib/server/image-cache'

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
  it('builds the upstream URL server-side with an honest User-Agent, no Referer/Origin and no redirects', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jpeg()))
    const res = await getCctvImage('bma-floodcam', CAM, REF, deps(fetch))
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BMA_FLOODCAM_PROXY}?rtcUrl=${encodeURIComponent(REF)}`)
    expect(calls[0]!.url.startsWith('https://floodbangkok.bangkok.go.th/api/proxy?rtcUrl=')).toBe(true)
    expect(calls[0]!.init.redirect).toBe('error')
    const h = new Headers(calls[0]!.init.headers)
    expect(h.get('user-agent')).toBe('flood-monitor/0.1 (+https://flood.example.org/about)')
    expect(h.get('accept')).toBe('image/jpeg')
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
    expect(calls.every((c) => c.init.redirect === 'error')).toBe(true)
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
    const frame = { bytes: jpeg(), fetchedAt: t - 20_000, capturedAt: '2026-10-04T02:45:00.000Z', changedAt: t - 600_000, width: 352, height: 288 }
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
})
