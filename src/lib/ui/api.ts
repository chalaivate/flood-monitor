import type { CameraLinkOut, CamerasResponse, ChannelLink, MapStation, PublicCamera, PublicChannel, PublicPlace } from '../server/public'
import type { AlertEvent, ChannelType, HistoryPoint, Place } from '../types'

// Client-side view of the HTTP API (docs/DESIGN.md §5). Response shapes come from
// src/lib/server/public.ts as type-only imports (that module is client-safe); the UI
// never imports server runtime code.

export type DataMode = 'live' | 'fixture'

export interface PublicConfig {
  dataMode: DataMode
  defaultPlace: { label: string; lat: number; lng: number }
  pollMinutes: number
  channels: Record<ChannelType, boolean>
  telegramBot: string | null
  lineAddFriendUrl: string | null
  vapidPublicKey: string | null
  /** Animated RainViewer radar allowed (operator setting, licence-dependent). */
  rainviewer: boolean
  /** This deployment does not keep places or alert settings (serverless demo). */
  ephemeral: boolean
}

export type { CameraLinkOut, CamerasResponse, ChannelLink, MapStation, PublicCamera, PublicChannel, PublicPlace }

export interface StationsResponse {
  generatedAt: string
  stations: MapStation[]
}

export interface HistoryResponse {
  series: Record<string, HistoryPoint[]>
}

export interface PlaceInput {
  label: string
  lat: number
  lng: number
  radiusKm: number
  maxStations: number
  freeboard?: Place['freeboard']
  rain?: Place['rain']
  rapidRiseCm?: number
  notifyMinLevel?: Place['notifyMinLevel']
}

export interface CreateChannelResponse {
  channel: PublicChannel
  link?: ChannelLink
}

export interface TestResponse {
  deliveries: { channelId: string; type: ChannelType; ok: boolean; error?: string | null }[]
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Thai message for a failed request, preferring the server's own `error` text. */
function messageFor(status: number, body: unknown): string {
  const err = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null
  if (typeof err === 'string' && err.trim()) return err
  if (status === 401 || status === 403) return 'ไม่มีสิทธิ์จัดการจุดนี้ (รหัสจัดการไม่ถูกต้อง)'
  if (status === 404) return 'ไม่พบข้อมูลที่ขอ'
  if (status === 429) return 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่'
  if (status >= 500) return 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่'
  return `คำขอไม่สำเร็จ (${status})`
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  token?: string | null
  signal?: AbortSignal
  fetch?: typeof fetch
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const f = opts.fetch ?? fetch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let res: Response
  try {
    res = await f(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: 'no-store',
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 0)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) throw new ApiError(messageFor(res.status, body), res.status)
  return body as T
}

// --- place management --------------------------------------------------------

export const api = {
  createPlace: (input: PlaceInput) =>
    apiFetch<{ place: PublicPlace; manageToken: string }>('/api/places', { method: 'POST', body: input }),
  getPlace: (id: string, token: string) =>
    apiFetch<{ place: PublicPlace; channels?: PublicChannel[] }>(`/api/places/${encodeURIComponent(id)}`, { token }),
  updatePlace: (id: string, token: string, patch: Partial<PlaceInput>) =>
    apiFetch<{ place: PublicPlace } | PublicPlace>(`/api/places/${encodeURIComponent(id)}`, { method: 'PATCH', token, body: patch }).then(
      unwrapPlace,
    ),
  deletePlace: (id: string, token: string) =>
    apiFetch<unknown>(`/api/places/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
  listChannels: (id: string, token: string) =>
    apiFetch<{ channels: PublicChannel[] } | PublicChannel[]>(`/api/places/${encodeURIComponent(id)}/channels`, { token }).then((r) =>
      Array.isArray(r) ? r : (r?.channels ?? []),
    ),
  addChannel: (id: string, token: string, body: { type: ChannelType; target?: string }) =>
    apiFetch<CreateChannelResponse>(`/api/places/${encodeURIComponent(id)}/channels`, { method: 'POST', token, body }),
  deleteChannel: (id: string, token: string, channelId: string) =>
    apiFetch<unknown>(`/api/places/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE', token }),
  test: (id: string, token: string, channelId?: string) =>
    apiFetch<TestResponse>(`/api/places/${encodeURIComponent(id)}/test`, { method: 'POST', token, body: channelId ? { channelId } : {} }),
  events: (id: string, token: string, limit = 50) =>
    apiFetch<{ events: AlertEvent[] }>(`/api/places/${encodeURIComponent(id)}/events?limit=${limit}`, { token }).then((r) => r?.events ?? []),
}

function unwrapPlace(r: { place: PublicPlace } | PublicPlace): PublicPlace {
  return 'place' in r && r.place && typeof r.place === 'object' ? r.place : (r as PublicPlace)
}

export const CHANNEL_LABEL_TH: Record<ChannelType, string> = {
  webpush: 'แจ้งเตือนบนอุปกรณ์นี้',
  line: 'LINE',
  telegram: 'Telegram',
  ntfy: 'ntfy',
  email: 'อีเมล',
  discord: 'Discord',
}

// --- CCTV ---------------------------------------------------------------------

export interface CamerasQuery {
  lat: number
  lng: number
  /** Radius km (server default 3, max 20). */
  r?: number
  /** Most sites (server default 4, max 24); every angle of a site is included. */
  n?: number
}

/**
 * GET /api/cctv/cameras: nearest sites around a point, or (no query) every camera for the map.
 * Missing arrays are normalised so callers can rely on them.
 */
export async function fetchCameras(q: CamerasQuery | null = null, opts: Pick<ApiOptions, 'signal' | 'fetch'> = {}): Promise<CamerasResponse> {
  const params = new URLSearchParams()
  if (q) {
    params.set('lat', String(q.lat))
    params.set('lng', String(q.lng))
    if (q.r !== undefined) params.set('r', String(q.r))
    if (q.n !== undefined) params.set('n', String(q.n))
  }
  const qs = params.toString()
  const r = await apiFetch<Partial<CamerasResponse> | null>(`/api/cctv/cameras${qs ? `?${qs}` : ''}`, opts)
  return {
    generatedAt: typeof r?.generatedAt === 'string' ? r.generatedAt : new Date().toISOString(),
    catalogAt: r?.catalogAt && typeof r.catalogAt === 'object' ? r.catalogAt : {},
    cameras: Array.isArray(r?.cameras) ? r.cameras : [],
    nearestOutsideKm: typeof r?.nearestOutsideKm === 'number' ? r.nearestOutsideKm : null,
    links: Array.isArray(r?.links) ? r.links : [],
  }
}
