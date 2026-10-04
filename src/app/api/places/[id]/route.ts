import { handler, json, readJson, type RouteCtx } from '@/lib/server/http'
import { alertSettingsChanged, authorizePlace, patchPlace } from '@/lib/server/places'
import { toPublicChannel, toPublicPlace } from '@/lib/server/public'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = RouteCtx<{ id: string }>

/** GET /api/places/[id] → { place, channels } */
export const GET = handler('place GET', async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const channels = (await store.listChannels(place.id)).map(toPublicChannel)
  return json({ place: toPublicPlace(place), channels })
})

/**
 * PATCH /api/places/[id] body Partial<PlaceInput> → { place }
 * When the location, station selection or thresholds change, the place's alert state is
 * reset so the next cycle reports current conditions as if the place were new.
 */
export const PATCH = handler('place PATCH', async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  const updated = patchPlace(place, await readJson(req))
  await store.updatePlace(updated)
  if (alertSettingsChanged(place, updated)) await store.clearAlertStates(updated.id)
  return json({ place: toPublicPlace(updated) })
})

/** DELETE /api/places/[id] → { ok: true } (channels, alert state and history go with it). */
export const DELETE = handler('place DELETE', async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params
  const store = await getStore()
  const place = await authorizePlace(req, store, id)
  await store.deletePlace(place.id)
  return json({ ok: true })
})
