import type { Channel, Level, Place, SourceId, StationKind } from '../types'

// Public (API response) shapes. This file holds no runtime secrets and imports no
// Node modules, so client components may `import type` from it.

/** Place without its manage-token hash. */
export type PublicPlace = Omit<Place, 'manageTokenHash'>

/**
 * Channel as shown to its owner: `target` masked (e.g. `te***@gmail.com`), the
 * link code present only while a LINE/Telegram channel waits to be linked.
 */
export type PublicChannel = Omit<Channel, 'target' | 'linkCode'> & {
  target: string
  linkCode?: string | null
}

/** Compact station row for the map (`GET /api/stations`). */
export interface MapStation {
  id: string
  kind: StationKind
  source: SourceId
  name: string
  shortName: string | null
  district: string | null
  lat: number
  lng: number
  level: Level
  stale: boolean
  observedAt: string | null
  waterLevel: number | null
  bankLevel: number | null
  freeboard: number | null
  rain24h: number | null
  rain1h: number | null
  roadFloodCm: number | null
  officialStatus: string | null
}

/** `POST /api/places/[id]/channels` link instructions for channels that need a second step. */
export interface ChannelLink {
  /** Code to send to the LINE/Telegram bot (never returned for e-mail). */
  code?: string
  /** Deep link: LINE add-friend URL or https://t.me/<bot>?start=<code>. */
  url?: string
  instructions: string
}

export function toPublicPlace(place: Place): PublicPlace {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { manageTokenHash, ...rest } = place
  return rest
}

const stars = '***'

function maskEmail(addr: string): string {
  const at = addr.lastIndexOf('@')
  if (at <= 0) return stars
  const local = addr.slice(0, at)
  return `${local.slice(0, Math.min(2, local.length))}${stars}${addr.slice(at)}`
}

function maskNtfy(target: string): string {
  try {
    const u = new URL(target)
    const topic = u.pathname.replace(/^\/+|\/+$/g, '')
    return `${u.host}/${topic.slice(0, 3)}${stars}`
  } catch {
    return `${target.slice(0, 3)}${stars}`
  }
}

function maskDiscord(target: string): string {
  try {
    const u = new URL(target)
    const id = u.pathname.split('/').find((p) => /^\d{5,}$/.test(p)) ?? ''
    return `${u.host}/api/webhooks/${id.slice(0, 4)}${stars}`
  } catch {
    return `Discord webhook ${stars}`
  }
}

/** Human label for a web push endpoint (we never echo the endpoint itself). */
export function pushDeviceLabel(target: string): string {
  let host = ''
  try {
    host = new URL((JSON.parse(target) as { endpoint?: string }).endpoint ?? '').hostname
  } catch {
    return 'อุปกรณ์ที่ลงทะเบียน'
  }
  if (host.endsWith('fcm.googleapis.com') || host.endsWith('android.googleapis.com')) return 'เบราว์เซอร์ Chrome / Android'
  if (host.endsWith('mozilla.com') || host.endsWith('mozaws.net')) return 'เบราว์เซอร์ Firefox'
  if (host.endsWith('push.apple.com')) return 'อุปกรณ์ Apple (Safari)'
  if (host.endsWith('notify.windows.com')) return 'เบราว์เซอร์ Edge / Windows'
  return `อุปกรณ์ (${host})`
}

export function maskTarget(channel: Channel): string {
  const t = channel.target
  if (!t) return ''
  switch (channel.type) {
    case 'email':
      return maskEmail(t)
    case 'ntfy':
      return maskNtfy(t)
    case 'discord':
      return maskDiscord(t)
    case 'webpush':
      return pushDeviceLabel(t)
    case 'line':
    case 'telegram':
      return t.length <= 4 ? stars : `${t.slice(0, 3)}${stars}${t.slice(-2)}`
  }
}

export function toPublicChannel(channel: Channel): PublicChannel {
  const showCode = !channel.verified && (channel.type === 'line' || channel.type === 'telegram')
  return {
    id: channel.id,
    placeId: channel.placeId,
    type: channel.type,
    target: maskTarget(channel),
    verified: channel.verified,
    ...(showCode ? { linkCode: channel.linkCode ?? null } : {}),
    createdAt: channel.createdAt,
  }
}
