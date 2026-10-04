import { z } from 'zod'
import { serverDeps } from '@/lib/server/context'
import { handler, HttpError, json, MSG, readJson, type RouteCtx } from '@/lib/server/http'
import { authorizePlace } from '@/lib/server/places'
import { enforceLimit, LIMITS } from '@/lib/server/rate-limit'
import { sendTestMessage } from '@/lib/server/test-message'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ channelId: z.string().max(64).optional() })

/** POST /api/places/[id]/test body { channelId? } → { deliveries } */
export const POST = handler('place test', async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const { id } = await ctx.params
  const deps = await serverDeps()
  const place = await authorizePlace(req, deps.store, id)
  const { channelId } = Body.parse(await readJson(req, 4096))
  const channels = (await deps.store.listChannels(place.id)).filter((c) => c.verified && (!channelId || c.id === channelId))
  if (channelId && channels.length === 0) throw new HttpError(404, MSG.channelNotFound)
  if (channels.length === 0) throw new HttpError(400, 'ยังไม่มีช่องทางแจ้งเตือนที่พร้อมใช้งาน')
  enforceLimit(`test:${place.id}`, LIMITS.placeTest)
  const event = await sendTestMessage(deps, place, channelId)
  return json({ deliveries: event.deliveries ?? [] })
})
