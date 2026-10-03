import { getConfig } from '@/lib/config'
import { publicOrigin } from '@/lib/server/http'
import { log } from '@/lib/server/log'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/email/confirm?code= → verifies the e-mail channel, redirects to /alerts?confirmed=1|0. */
export async function GET(req: Request): Promise<Response> {
  const origin = publicOrigin(req, getConfig().PUBLIC_BASE_URL)
  const code = new URL(req.url).searchParams.get('code')?.trim() ?? ''
  let confirmed = false
  try {
    if (/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
      const store = await getStore()
      const ch = await store.findChannelByLinkCode(code)
      if (ch && ch.type === 'email' && !ch.verified) {
        await store.updateChannel({ ...ch, verified: true, linkCode: null })
        confirmed = true
      }
    }
  } catch (err) {
    log(`[api] email confirm failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${origin}/alerts?confirmed=${confirmed ? 1 : 0}`, 'Cache-Control': 'no-store' },
  })
}
