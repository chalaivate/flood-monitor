import { generateManageToken, hashToken } from '@/lib/server/auth'
import { clientIp, handler, json, readJson } from '@/lib/server/http'
import { newPlace } from '@/lib/server/places'
import { toPublicPlace } from '@/lib/server/public'
import { enforceClientLimit, LIMITS } from '@/lib/server/rate-limit'
import { PlaceInputSchema } from '@/lib/server/validation'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/places body PlaceInput → 201 { place, manageToken } (the token is shown only once). */
export const POST = handler('places POST', async (req: Request) => {
  // Per client IP (when a trusted proxy supplies it) plus a server-wide backstop.
  enforceClientLimit('place', clientIp(req), LIMITS.placeCreate, LIMITS.placeCreateGlobal)
  const input = PlaceInputSchema.parse(await readJson(req))
  const manageToken = generateManageToken()
  const place = newPlace(input, hashToken(manageToken))
  const store = await getStore()
  await store.createPlace(place)
  return json({ place: toPublicPlace(place), manageToken }, { status: 201 })
})
