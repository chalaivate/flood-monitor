import type { AppConfig } from '../config'
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

/**
 * Which channel types users can set up on this server. LINE and Telegram also need
 * their webhook secret (to link accounts), Telegram its bot username (deep link).
 */
export function availableChannels(config: AppConfig): Record<ChannelType, boolean> {
  const configured = (t: ChannelType) => senderFor(t)?.isConfigured(config) ?? false
  return {
    webpush: configured('webpush'),
    line: configured('line') && !!config.LINE_CHANNEL_SECRET,
    telegram: configured('telegram') && !!config.TELEGRAM_WEBHOOK_SECRET && !!config.TELEGRAM_BOT_USERNAME,
    ntfy: configured('ntfy'),
    email: configured('email'),
    discord: configured('discord'),
  }
}
