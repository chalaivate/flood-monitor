import { handler, json, type RouteCtx } from '@/lib/server/http'
import { authorizePlace } from '@/lib/server/places'
import { clamp, queryNumber } from '@/lib/server/validation'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/places/[id]/events?limit=50 → { events: AlertEvent[] } (newest first) */
export const GET = handler('events GET', async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const raw = queryNumber(new URL(req.url).searchParams, 'limit')
  const limit = raw === undefined || !Number.isFinite(raw) ? 50 : Math.round(clamp(raw, 1, 200))
  return json({ events: await store.listAlertEvents(place.id, limit) })
})
