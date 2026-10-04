import type { AppConfig } from '../config'
import type { LookupFn } from '../server/net'
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
  /**
   * Short failure reason ("HTTP 403", "timeout", …). Stored in deliveries and shown to the
   * place owner, so it must never contain an upstream response body.
   */
  error?: string | null
  /** The target no longer exists (e.g. web push 404/410, LINE user blocked) — delete the channel. */
  gone?: boolean
}

export interface SendContext {
  config: AppConfig
  fetch: typeof fetch
  /** DNS resolver for the SSRF check of user-supplied URLs (default: the system resolver). */
  lookup?: LookupFn
}

export interface ChannelSender {
  type: ChannelType
  /** Whether the server has the credentials this channel needs. */
  isConfigured(config: AppConfig): boolean
  send(channel: Channel, msg: NotifyMessage, ctx: SendContext): Promise<SendResult>
}
