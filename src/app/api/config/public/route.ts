import { getConfig } from '@/lib/config'
import { availableChannels } from '@/lib/notify'
import { handler, json } from '@/lib/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/config/public → settings the browser needs (no secrets). A channel is listed
 * only when every setting it needs is present (see availableChannels): e-mail also needs
 * PUBLIC_BASE_URL for its confirmation link, LINE its add-friend URL and channel secret,
 * Telegram its bot username and webhook secret. Bot details are null when the bot is off.
 */
export const GET = handler('config/public', async () => {
  const c = getConfig()
  const channels = availableChannels(c)
  return json(
    {
      dataMode: c.DATA_MODE,
      defaultPlace: { label: c.DEFAULT_LABEL, lat: c.DEFAULT_LAT, lng: c.DEFAULT_LNG },
      pollMinutes: c.POLL_MINUTES,
      channels,
      telegramBot: channels.telegram ? (c.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? null) : null,
      lineAddFriendUrl: channels.line ? (c.LINE_ADD_FRIEND_URL ?? null) : null,
      vapidPublicKey: channels.webpush ? (c.VAPID_PUBLIC_KEY ?? null) : null,
      rainviewer: c.RAINVIEWER === '1',
      // Serverless with a per-instance SQLite store: places and alert settings are not kept.
      ephemeral: c.INGEST_ON_REQUEST === '1' && c.STORE === 'sqlite',
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
})
