import { handler, HttpError, json, MSG, type RouteCtx } from '@/lib/server/http'
import { authorizePlace } from '@/lib/server/places'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** DELETE /api/places/[id]/channels/[channelId] → { ok: true } */
export const DELETE = handler('channel DELETE', async (req: Request, ctx: RouteCtx<{ id: string; channelId: string }>) => {
  const { id, channelId } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const channel = (await store.listChannels(place.id)).find((c) => c.id === channelId)
  if (!channel) throw new HttpError(404, MSG.channelNotFound)
  await store.deleteChannel(channel.id)
  return json({ ok: true })
})
