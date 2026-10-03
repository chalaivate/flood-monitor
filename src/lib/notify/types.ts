import type { AppConfig } from '../config'
import type { Channel, ChannelType, Level } from '../types'

export interface NotifyMessage {
  title: string
  /** Plain-text body (Thai), may contain newlines. */
  body: string
  level: Level
  /** Deep link to the dashboard for this place. */
  url?: string
  /** Collapse key so repeated alerts for the same place replace each other (web push). */
  tag?: string
}

export interface SendResult {
  ok: boolean
  error?: string | null
  /** The target no longer exists (e.g. web push 404/410, LINE user blocked) — delete the channel. */
  gone?: boolean
}

export interface SendContext {
  config: AppConfig
  fetch: typeof fetch
}

export interface ChannelSender {
  type: ChannelType
  /** Whether the server has the credentials this channel needs. */
  isConfigured(config: AppConfig): boolean
  send(channel: Channel, msg: NotifyMessage, ctx: SendContext): Promise<SendResult>
}
