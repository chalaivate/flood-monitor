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
import { enforceClientLimit, LIMITS } from '@/lib/server/rate-limit'
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
 * Checked in order before any upstream request: the source serves images on this host, the
 * camera is in the catalogue (404 ไม่พบกล้องนี้), the per-IP limit (429). Then the shared cache /
 * single-flight upstream fetch: 502 when the camera cannot be reached or has no image, 503 when
 * the per-source concurrency or hourly budget is spent. The last good frame is served with
 * `X-Cctv-Stale: 1` for a while when the upstream fails.
 */
export const GET = handler('cctv image', async (req: Request, ctx: RouteCtx<{ source: string; file: string }>) => {
  const { source, file } = await ctx.params
  const config = getConfig()
  const store = await getStore()
  const hit = await resolveCctvCamera(config, store, source, file)
  if (!hit) return cctvError(404, CCTV_MSG.notFound, 'not-found')
  enforceClientLimit('cctvImage', clientIp(req), LIMITS.cctvImage)

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

  const res = await getCctvImage(camera.source, camera.id, ref, { fetch: lateFetch, publicBaseUrl: config.PUBLIC_BASE_URL })
  if (res.ok) return cctvFrameResponse(res.frame, res.stale, res.ttlMs)
  const f = cctvFailure(res.failure)
  return cctvError(f.status, f.message, res.failure, f.headers)
})
