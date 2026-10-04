import type { Channel } from '../types'
import { APP_NAME, SEND_TIMEOUT_MS, plainText } from './format'
import { classifyResponse, fetchUserTarget, sendErrorText } from './http'
import type { ChannelSender, NotifyMessage, SendResult } from './types'

// Discord incoming webhook (the channel target is the webhook URL).

export const DISCORD_CONTENT_MAX = 2000
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'])

/** https://discord.com/api/webhooks/<id>/<token> (optionally /api/v10/…). */
export function isDiscordWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      DISCORD_HOSTS.has(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password &&
      /^\/api\/(v\d+\/)?webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,120}\/?$/.test(u.pathname)
    )
  } catch {
    return false
  }
}

export const discordSender: ChannelSender = {
  type: 'discord',
  isConfigured: () => true,

  async send(channel: Channel, msg: NotifyMessage, ctx): Promise<SendResult> {
    if (!isDiscordWebhookUrl(channel.target)) return { ok: false, error: 'invalid Discord webhook URL', gone: true }
    try {
      // The host is pinned to discord.com above; the DNS check and the refusal to follow
      // redirects still apply because the URL is user input.
      const res = await fetchUserTarget(ctx, channel.target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: plainText(msg, DISCORD_CONTENT_MAX),
          username: APP_NAME,
          // Place labels are user input: never let them ping @everyone / roles.
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      const { result, status } = await classifyResponse('Discord', res)
      return result.ok ? result : { ...result, gone: status === 404 }
    } catch (err) {
      return { ok: false, error: sendErrorText(err) }
    }
  },
}
