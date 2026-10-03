import type { ChannelType } from '../types'

// Pure helpers for the alert channel picker (/alerts step 3).

export const CHANNEL_ORDER: ChannelType[] = ['webpush', 'line', 'telegram', 'ntfy', 'email', 'discord']

/**
 * Channel cards to offer, the ones this server can send first. E-mail is left out entirely
 * when the server reports it off (e.g. no PUBLIC_BASE_URL, so confirmation links would be
 * wrong); other disabled channels stay visible, greyed, so admins can see what exists.
 */
export function pickerChannels(enabled: Partial<Record<ChannelType, boolean>> | null | undefined): ChannelType[] {
  return CHANNEL_ORDER.filter((t) => t !== 'email' || !!enabled?.email).sort((a, b) => Number(!enabled?.[a]) - Number(!enabled?.[b]))
}

/** true once a LINE/Telegram link code's expiry time has passed (unknown expiry = still valid). */
export function linkCodeExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return false
  const t = Date.parse(expiresAt)
  return Number.isFinite(t) && nowMs > 0 && t <= nowMs
}
