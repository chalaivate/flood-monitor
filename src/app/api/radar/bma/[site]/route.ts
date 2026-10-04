import { lateFetch } from '@/lib/server/context'
import { jsonError, type RouteCtx } from '@/lib/server/http'
import { getRadarImage, isRadarSite, RADAR_TTL_MS } from '@/lib/server/radar-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/radar/bma/nongchok | nongkhaem → latest BMA radar JPEG (cached ~4 min). */
export async function GET(_req: Request, ctx: RouteCtx<{ site: string }>): Promise<Response> {
  const { site } = await ctx.params
  if (!isRadarSite(site)) return jsonError(404, 'ไม่พบเรดาร์นี้')
  const res = await getRadarImage(site, lateFetch)
  if (!res.ok) {
    return jsonError(502, 'ไม่สามารถดึงภาพเรดาร์ของ กทม. ได้ในขณะนี้', { 'Cache-Control': 'public, max-age=60' })
  }
  const { image, stale } = res
  const maxAge = stale ? 60 : Math.floor(RADAR_TTL_MS / 1000)
  const headers: Record<string, string> = {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(image.bytes.byteLength),
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Radar-Fetched-At': new Date(image.fetchedAt).toISOString(),
    'X-Content-Type-Options': 'nosniff',
  }
  if (stale) headers['X-Radar-Stale'] = '1'
  if (image.lastModified) headers['Last-Modified'] = image.lastModified
  return new Response(image.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers })
}
