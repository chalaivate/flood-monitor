import { getConfig } from '@/lib/config'
import { availableChannels } from '@/lib/notify'
import { handler, json } from '@/lib/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/config/public → settings the browser needs (no secrets). */
export const GET = handler('config/public', async () => {
  const c = getConfig()
  return json(
    {
      dataMode: c.DATA_MODE,
      defaultPlace: { label: c.DEFAULT_LABEL, lat: c.DEFAULT_LAT, lng: c.DEFAULT_LNG },
      pollMinutes: c.POLL_MINUTES,
      channels: availableChannels(c),
      telegramBot: c.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? null,
      lineAddFriendUrl: c.LINE_ADD_FRIEND_URL ?? null,
      vapidPublicKey: c.VAPID_PUBLIC_KEY ?? null,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
})
