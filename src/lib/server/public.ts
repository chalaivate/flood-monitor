import type { Camera, CameraSourceId, Channel, Level, Place, SourceId, StationKind } from '../types'

// Public (API response) shapes. This file holds no runtime secrets and imports no
// Node modules, so client components may `import type` from it.

/** Place without its manage-token hash. */
export type PublicPlace = Omit<Place, 'manageTokenHash'>

/** A pending LINE/Telegram link code is valid this long after its channel was created. */
export const LINK_CODE_TTL_MS = 60 * 60_000

/**
 * Channel as shown to its owner: `target` masked (e.g. `te***@gmail.com`), the
 * link code (and when it stops working) present only while a LINE/Telegram channel
 * waits to be linked. After `linkExpiresAt`, POSTing the same channel type again
 * replaces the pending channel with a fresh code.
 */
export type PublicChannel = Omit<Channel, 'target' | 'linkCode'> & {
  target: string
  linkCode?: string | null
  linkExpiresAt?: string | null
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

function linkExpiry(createdAt: string): string | null {
  const t = Date.parse(createdAt)
  return Number.isFinite(t) ? new Date(t + LINK_CODE_TTL_MS).toISOString() : null
}

export function toPublicChannel(channel: Channel): PublicChannel {
  const showCode = !channel.verified && (channel.type === 'line' || channel.type === 'telegram')
  return {
    id: channel.id,
    placeId: channel.placeId,
    type: channel.type,
    target: maskTarget(channel),
    verified: channel.verified,
    ...(showCode ? { linkCode: channel.linkCode ?? null, linkExpiresAt: linkExpiry(channel.createdAt) } : {}),
    createdAt: channel.createdAt,
  }
}

// --- CCTV (GET /api/cctv/cameras) ------------------------------------------------------

/** Camera as the UI sees it: never includes upstream references. */
export interface PublicCamera extends Camera {
  /** Distance from the requested point, km (null when no point was given). */
  distanceKm: number | null
  /** 'image' when this server can show the camera's still; otherwise link to the agency page. */
  media: 'image' | 'link'
  /** Same-origin still URL, e.g. `/api/cctv/image/bma-floodcam/123.jpg`; null for 'link'. */
  imageUrl: string | null
  /** Suggested refresh interval for an open viewer, seconds. */
  refreshSec: number
}

/** Agency camera pages we only link to (no images through this server). */
export interface CameraLinkOut {
  id: string
  /** Thai title, e.g. "กล้องจราจร กทม.". */
  title: string
  owner: string
  url: string
}

export interface CamerasResponse {
  generatedAt: string
  /** When each enabled source's camera list was last refreshed (null = never). */
  catalogAt: Partial<Record<CameraSourceId, string | null>>
  /**
   * Nearest first when lat/lng were given: every camera of the nearest sites within r km, at
   * most n sites (all angles of a chosen site are included). Without lat/lng: every camera.
   */
  cameras: PublicCamera[]
  /** Distance to the nearest camera outside the radius (lat/lng queries only). */
  nearestOutsideKm: number | null
  links: CameraLinkOut[]
}
