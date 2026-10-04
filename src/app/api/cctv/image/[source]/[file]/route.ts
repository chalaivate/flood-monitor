import { getConfig } from '@/lib/config'
import { demoCameraSvg } from '@/lib/server/cctv-demo-image'
import {
  CCTV_IMAGE_HEADERS,
  CCTV_MSG,
  cctvFailure,
  cctvFrameResponse,
  getCctvImage,
  isUpstreamCameraSource,
  resolveCctvCamera,
} from '@/lib/server/cctv-proxy'
import { lateFetch } from '@/lib/server/context'
import { clientIp, handler, json, type RouteCtx } from '@/lib/server/http'
import { ipBucket, LIMITS, takeClientLimit } from '@/lib/server/rate-limit'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Errors may be cached briefly by the browser and a CDN (never per client: 429 is no-store). */
const ERROR_CACHE = { 'Cache-Control': 'public, max-age=30' }

function cctvError(status: number, error: string, reason: string, headers: Record<string, string> = {}): Response {
  return json({ error, reason }, { status, headers: { ...ERROR_CACHE, ...headers } })
}

/**
 * GET /api/cctv/image/[source]/[file] → the latest still of one camera.
 * `file` is `<nativeId>.jpg` (`<nativeId>.svg` for the simulated demo-cam source).
 * Errors are Thai JSON `{ error, reason }`. Checked in order, none of it asking upstream:
 * - 404 `not-found`: unknown source or camera;
 * - 503 `unavailable` + Retry-After: a listed camera whose stills this server cannot fetch right
 *   now (stills switched off, link-only catalogue, host fallback, agency backoff): link out;
 * - 429 `limited` + Retry-After: the per-IP request limit.
 * Then the shared cache / single-flight upstream fetch, where a cache miss also spends the
 * client's miss budget (429 `limited`); 502 `unreachable` | `no-image`; 503 `busy` | `budget`
 * (shared queue or hourly budget) or `unavailable` (the source went off meanwhile). The last
 * good frame is served with `X-Cctv-Stale: 1` for a while instead of most failures.
 */
export const GET = handler('cctv image', async (req: Request, ctx: RouteCtx<{ source: string; file: string }>) => {
  const { source, file } = await ctx.params
  const config = getConfig()
  const store = await getStore()
  const hit = await resolveCctvCamera(config, store, source, file)
  if (hit.kind === 'not-found') return cctvError(404, CCTV_MSG.notFound, 'not-found')
  if (hit.kind === 'unavailable') {
    const f = cctvFailure('unavailable', hit.retryAfterSec)
    return cctvError(f.status, f.message, 'unavailable', f.headers)
  }
  const ip = clientIp(req)
  const limit = takeClientLimit('cctvImage', ip, LIMITS.cctvImage)
  if (!limit.ok) {
    const f = cctvFailure('limited', limit.retryAfterSec)
    return cctvError(f.status, f.message, 'limited', f.headers)
  }

  const { camera, ref } = hit
  if (camera.source === 'demo-cam') {
    const now = new Date()
    const svg = await demoCameraSvg(store, camera, now, ref)
    return new Response(svg, {
      status: 200,
      headers: {
        ...CCTV_IMAGE_HEADERS,
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-Cctv-Fetched-At': now.toISOString(),
        'X-Cctv-Changed-At': now.toISOString(),
      },
    })
  }
  if (!isUpstreamCameraSource(camera.source) || !ref) return cctvError(404, CCTV_MSG.notFound, 'not-found')

  const res = await getCctvImage(camera.source, camera.id, ref, {
    fetch: lateFetch,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    // No per-client accounting without a trusted client IP (TRUST_PROXY=none).
    client: ip === 'unknown' ? null : ipBucket(ip),
    signal: req.signal,
  })
  if (res.ok) return cctvFrameResponse(res.frame, res.stale, res.ttlMs)
  const f = cctvFailure(res.failure, res.retryAfterSec)
  return cctvError(f.status, f.message, res.failure, f.headers)
})
