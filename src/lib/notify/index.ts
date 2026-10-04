import type { AppConfig } from '../config'
import { publicOrigin } from '../server/http'
import type { ChannelType } from '../types'
import { discordSender } from './discord'
import { emailSender } from './email'
import { lineSender } from './line'
import { ntfySender } from './ntfy'
import { telegramSender } from './telegram'
import type { ChannelSender } from './types'
import { webPushSender } from './webpush'

export type { ChannelSender, NotifyMessage, SendContext, SendResult } from './types'

const SENDERS: ChannelSender[] = [webPushSender, lineSender, telegramSender, ntfySender, emailSender, discordSender]

/** One sender per channel type. */
export function getSenders(): ChannelSender[] {
  return SENDERS
}

export function senderFor(type: ChannelType): ChannelSender | undefined {
  return SENDERS.find((s) => s.type === type)
}

type SettingKey = keyof AppConfig & string

/**
 * Settings a channel needs before users can *set it up*. Sending to an already linked
 * channel needs less (see each sender's isConfigured), but a channel offered without the
 * rest hands out link codes or confirmation mails that can never complete:
 * - LINE: the access token sends, the channel secret verifies the webhook that receives
 *   link codes, and the add-friend URL is how users find the Official Account.
 * - Telegram: the bot token sends, the webhook secret authenticates updates (the webhook
 *   refuses everything without it), the bot username builds the t.me deep link.
 * - E-mail: the confirmation link must point at the public site (PUBLIC_BASE_URL); it is
 *   never derived from the request (see publicOrigin).
 */
export const CHANNEL_SETTINGS: Record<ChannelType, readonly SettingKey[]> = {
  webpush: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
  line: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_ADD_FRIEND_URL'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME'],
  ntfy: [],
  email: ['RESEND_API_KEY', 'EMAIL_FROM', 'PUBLIC_BASE_URL'],
  discord: [],
}

function isSet(config: AppConfig, key: SettingKey): boolean {
  if (key === 'PUBLIC_BASE_URL') return publicOrigin(config.PUBLIC_BASE_URL) !== null
  const v = config[key]
  return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null
}

/** Settings of `type` that are missing (or, for PUBLIC_BASE_URL, not an http(s) URL). */
export function missingChannelSettings(config: AppConfig, type: ChannelType): SettingKey[] {
  return CHANNEL_SETTINGS[type].filter((k) => !isSet(config, k))
}

/** Which channel types users can set up on this server: every required setting is present. */
export function availableChannels(config: AppConfig): Record<ChannelType, boolean> {
  const ready = (t: ChannelType) => (senderFor(t)?.isConfigured(config) ?? false) && missingChannelSettings(config, t).length === 0
  return {
    webpush: ready('webpush'),
    line: ready('line'),
    telegram: ready('telegram'),
    ntfy: ready('ntfy'),
    email: ready('email'),
    discord: ready('discord'),
  }
}

const CHANNEL_NAME: Record<ChannelType, string> = {
  webpush: 'Web Push',
  line: 'LINE',
  telegram: 'Telegram',
  ntfy: 'ntfy',
  email: 'E-mail',
  discord: 'Discord',
}

/**
 * Operator warnings for half-configured channels (some settings present, some missing),
 * naming the missing variables. Channels with nothing set are simply off: no warning.
 */
export function channelConfigWarnings(config: AppConfig): string[] {
  const out: string[] = []
  for (const type of Object.keys(CHANNEL_SETTINGS) as ChannelType[]) {
    // PUBLIC_BASE_URL is shared with alert links: only the channel's own keys show intent.
    const own = CHANNEL_SETTINGS[type].filter((k) => k !== 'PUBLIC_BASE_URL')
    const missing = missingChannelSettings(config, type)
    if (missing.length === 0 || !own.some((k) => isSet(config, k))) continue
    const invalidUrl = missing.includes('PUBLIC_BASE_URL') && !!config.PUBLIC_BASE_URL
    out.push(
      `${CHANNEL_NAME[type]} is not offered to users: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set` +
        (invalidUrl ? ' (PUBLIC_BASE_URL must be an http(s) URL without query or credentials)' : ''),
    )
  }
  return out
}

const g = globalThis as typeof globalThis & { __floodChannelWarningsLogged?: boolean }

/** Log channelConfigWarnings once per process (server start, worker start). Never throws. */
export function logChannelConfigWarnings(config: AppConfig, log: (line: string) => void): void {
  if (g.__floodChannelWarningsLogged) return
  g.__floodChannelWarningsLogged = true
  for (const w of channelConfigWarnings(config)) log(`[config] WARNING: ${w}`)
}
