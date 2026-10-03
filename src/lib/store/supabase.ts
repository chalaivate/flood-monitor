import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AlertEvent, AlertState, Channel, Place, Reading, SourceHealth, Station } from '../types'
import type { LatestRow, Store } from './types'

// Postgres store on Supabase (schema: supabase/migrations/*_init.sql). Talks to
// PostgREST with the service-role key, which bypasses RLS; tables have RLS enabled
// with no policies, so the anon key can read nothing. Never use this from a browser.

export interface SupabaseStoreOptions {
  url: string
  serviceRoleKey: string
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Rows per upsert request. */
  chunkSize?: number
  /**
   * Rows per select page. Must not exceed the project's PostgREST `max-rows`
   * (Supabase default 1000), otherwise pagination stops early.
   */
  pageSize?: number
}

type Row = Record<string, unknown>

interface PgResult<T> {
  data: T | null
  error: { message: string; code?: string } | null
  count?: number | null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  // numeric columns can come back as strings depending on PostgREST settings.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Canonical 24-char ISO form (Postgres returns "…+00:00"). */
function iso(v: unknown): string {
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${String(v)}`)
  return d.toISOString()
}

function readingToRow(r: Reading): Row {
  return {
    station_id: r.stationId,
    observed_at: iso(r.observedAt),
    water_level: r.waterLevel ?? null,
    freeboard: r.freeboard ?? null,
    rain_1h: r.rain1h ?? null,
    rain_24h: r.rain24h ?? null,
    road_flood_cm: r.roadFloodCm ?? null,
    pumps_running: r.pumpsRunning ?? null,
    pumps_total: r.pumpsTotal ?? null,
    official_status: r.officialStatus ?? null,
  }
}

function rowToReading(r: Row): Reading {
  return {
    stationId: String(r.station_id),
    observedAt: iso(r.observed_at),
    waterLevel: num(r.water_level),
    freeboard: num(r.freeboard),
    rain1h: num(r.rain_1h),
    rain24h: num(r.rain_24h),
    roadFloodCm: num(r.road_flood_cm),
    pumpsRunning: num(r.pumps_running),
    pumpsTotal: num(r.pumps_total),
    officialStatus: str(r.official_status),
  }
}

/** jsonb comes back parsed; tolerate a text column holding JSON too. */
function parseData<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Last occurrence wins; ON CONFLICT DO UPDATE fails when one statement hits a key twice. */
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>()
  for (const item of items) map.set(key(item), item)
  return [...map.values()]
}

const READING_COLUMNS =
  'station_id,observed_at,water_level,freeboard,rain_1h,rain_24h,road_flood_cm,pumps_running,pumps_total,official_status'

export class SupabaseStore implements Store {
  readonly client: SupabaseClient
  private chunkSize: number
  private pageSize: number

  constructor(opts: SupabaseStoreOptions) {
    this.client = createClient(opts.url, opts.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { 'X-Client-Info': 'flood-monitor' },
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      },
    })
    this.chunkSize = Math.max(1, Math.min(500, opts.chunkSize ?? 500))
    this.pageSize = Math.max(1, opts.pageSize ?? 1000)
  }

  private check<T>(table: string, res: PgResult<T>): T | null {
    if (res.error) throw new Error(`supabase ${table}: ${res.error.message}`)
    return res.data
  }

  /** Read every row of an ordered query, page by page (PostgREST caps responses at max-rows). */
  private async selectAll(
    table: string,
    build: (from: number, to: number) => PromiseLike<PgResult<Row[]>>,
  ): Promise<Row[]> {
    const out: Row[] = []
    for (let from = 0; ; from += this.pageSize) {
      const page = this.check(table, await build(from, from + this.pageSize - 1)) ?? []
      out.push(...page)
      if (page.length < this.pageSize) return out
    }
  }

  // --- stations & readings -------------------------------------------------
  async upsertStations(stations: Station[]): Promise<void> {
    if (stations.length === 0) return
    const now = new Date().toISOString()
    const rows = dedupeBy(stations, (s) => s.id).map((s) => ({
      id: s.id,
      source: s.source,
      kind: s.kind,
      lat: s.lat,
      lng: s.lng,
      data: s,
      updated_at: now,
    }))
    for (const chunk of chunks(rows, this.chunkSize)) {
      this.check('stations', await this.client.from('stations').upsert(chunk, { onConflict: 'id' }))
    }
  }

  async insertReadings(readings: Reading[]): Promise<number> {
    if (readings.length === 0) return 0
    const rows = dedupeBy(readings.map(readingToRow), (r) => `${String(r.station_id)}|${String(r.observed_at)}`)
    let inserted = 0
    for (const chunk of chunks(rows, this.chunkSize)) {
      // ON CONFLICT DO NOTHING returns only the rows that were actually inserted.
      const res = await this.client
        .from('readings')
        .upsert(chunk, { onConflict: 'station_id,observed_at', ignoreDuplicates: true })
        .select('station_id')
      inserted += (this.check('readings', res) ?? []).length
    }
    return inserted
  }

  async listStations(): Promise<Station[]> {
    const rows = await this.selectAll('stations', (from, to) =>
      this.client.from('stations').select('data').order('id').range(from, to),
    )
    return rows.map((r) => parseData<Station>(r.data))
  }

  async latest(): Promise<LatestRow[]> {
    const [stations, rows] = await Promise.all([
      this.listStations(),
      this.selectAll('latest_readings', (from, to) =>
        this.client.from('latest_readings').select(READING_COLUMNS).order('station_id').range(from, to),
      ),
    ])
    const byStation = new Map(rows.map((r) => [String(r.station_id), rowToReading(r)]))
    return stations.map((station) => ({ station, reading: byStation.get(station.id) ?? null }))
  }

  async history(stationIds: string[], sinceIso: string): Promise<Record<string, Reading[]>> {
    const out: Record<string, Reading[]> = {}
    for (const id of stationIds) out[id] = []
    if (stationIds.length === 0) return out
    const since = iso(sinceIso)
    const rows = await this.selectAll('readings', (from, to) =>
      this.client
        .from('readings')
        .select(READING_COLUMNS)
        .in('station_id', stationIds)
        .gte('observed_at', since)
        .order('station_id')
        .order('observed_at')
        .range(from, to),
    )
    for (const r of rows) out[String(r.station_id)]?.push(rowToReading(r))
    return out
  }

  async pruneReadings(beforeIso: string): Promise<number> {
    const res = await this.client.from('readings').delete({ count: 'exact' }).lt('observed_at', iso(beforeIso))
    this.check('readings', res)
    return res.count ?? 0
  }

  // --- health & meta ------------------------------------------------------------
  async setSourceHealth(health: SourceHealth): Promise<void> {
    const res = await this.client
      .from('source_health')
      .upsert({ source: health.source, data: health, updated_at: new Date().toISOString() }, { onConflict: 'source' })
    this.check('source_health', res)
  }

  async listSourceHealth(): Promise<SourceHealth[]> {
    const rows = await this.selectAll('source_health', (from, to) =>
      this.client.from('source_health').select('data').order('source').range(from, to),
    )
    return rows.map((r) => parseData<SourceHealth>(r.data))
  }

  async setMeta(key: string, value: string): Promise<void> {
    const res = await this.client
      .from('meta')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    this.check('meta', res)
  }

  async getMeta(key: string): Promise<string | null> {
    const res = await this.client.from('meta').select('value').eq('key', key).maybeSingle()
    const row = this.check('meta', res) as Row | null
    return row ? String(row.value) : null
  }

  async tryLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.rpc('try_lock', {
      p_name: name,
      p_owner: owner,
      p_ttl_ms: Math.max(1, Math.round(ttlMs)),
    })
    return this.check('locks', res as PgResult<unknown>) === true
  }

  async unlock(name: string, owner: string): Promise<void> {
    this.check('locks', await this.client.from('locks').delete().eq('name', name).eq('owner', owner))
  }

  // --- places & channels ----------------------------------------------------------
  async createPlace(place: Place): Promise<void> {
    const res = await this.client
      .from('places')
      .insert({ id: place.id, data: place, created_at: iso(place.createdAt) })
    this.check('places', res)
  }

  async updatePlace(place: Place): Promise<void> {
    this.check('places', await this.client.from('places').update({ data: place }).eq('id', place.id))
  }

  async getPlace(id: string): Promise<Place | null> {
    const row = this.check('places', await this.client.from('places').select('data').eq('id', id).maybeSingle()) as Row | null
    return row ? parseData<Place>(row.data) : null
  }

  async listPlaces(): Promise<Place[]> {
    const rows = await this.selectAll('places', (from, to) =>
      this.client.from('places').select('data').order('created_at').order('id').range(from, to),
    )
    return rows.map((r) => parseData<Place>(r.data))
  }

  async deletePlace(id: string): Promise<void> {
    // Foreign keys cascade, but delete dependants explicitly so a schema without
    // the FK constraints behaves the same as the SQLite store.
    for (const table of ['channels', 'alert_states', 'alert_events'] as const) {
      this.check(table, await this.client.from(table).delete().eq('place_id', id))
    }
    this.check('places', await this.client.from('places').delete().eq('id', id))
  }

  async addChannel(channel: Channel): Promise<void> {
    const res = await this.client.from('channels').insert({
      id: channel.id,
      place_id: channel.placeId,
      type: channel.type,
      link_code: channel.linkCode ?? null,
      data: channel,
    })
    this.check('channels', res)
  }

  async updateChannel(channel: Channel): Promise<void> {
    const res = await this.client
      .from('channels')
      .update({ place_id: channel.placeId, type: channel.type, link_code: channel.linkCode ?? null, data: channel })
      .eq('id', channel.id)
    this.check('channels', res)
  }

  async listChannels(placeId?: string): Promise<Channel[]> {
    const rows = await this.selectAll('channels', (from, to) => {
      const q = this.client.from('channels').select('data')
      return (placeId ? q.eq('place_id', placeId) : q).order('id').range(from, to)
    })
    return rows.map((r) => parseData<Channel>(r.data))
  }

  async findChannelByLinkCode(code: string): Promise<Channel | null> {
    if (!code) return null
    const res = await this.client.from('channels').select('data').eq('link_code', code).limit(1)
    const rows = (this.check('channels', res) ?? []) as Row[]
    return rows[0] ? parseData<Channel>(rows[0].data) : null
  }

  async deleteChannel(id: string): Promise<void> {
    this.check('channels', await this.client.from('channels').delete().eq('id', id))
  }

  // --- alerting ---------------------------------------------------------------------
  async getAlertStates(placeId: string): Promise<AlertState[]> {
    const rows = await this.selectAll('alert_states', (from, to) =>
      this.client.from('alert_states').select('data').eq('place_id', placeId).order('key').range(from, to),
    )
    return rows.map((r) => parseData<AlertState>(r.data))
  }

  async setAlertStates(states: AlertState[]): Promise<void> {
    if (states.length === 0) return
    const rows = dedupeBy(states, (s) => `${s.placeId}|${s.key}`).map((s) => ({
      place_id: s.placeId,
      key: s.key,
      data: s,
    }))
    for (const chunk of chunks(rows, this.chunkSize)) {
      this.check('alert_states', await this.client.from('alert_states').upsert(chunk, { onConflict: 'place_id,key' }))
    }
  }

  async clearAlertStates(placeId: string): Promise<void> {
    this.check('alert_states', await this.client.from('alert_states').delete().eq('place_id', placeId))
  }

  async appendAlertEvent(event: AlertEvent): Promise<void> {
    const res = await this.client
      .from('alert_events')
      .insert({ id: event.id, place_id: event.placeId, created_at: iso(event.createdAt), data: event })
    this.check('alert_events', res)
  }

  async listAlertEvents(placeId: string, limit: number): Promise<AlertEvent[]> {
    const n = Math.max(1, Math.min(500, Math.floor(limit)))
    const res = await this.client
      .from('alert_events')
      .select('data')
      .eq('place_id', placeId)
      .order('created_at', { ascending: false })
      .limit(n)
    return ((this.check('alert_events', res) ?? []) as Row[]).map((r) => parseData<AlertEvent>(r.data))
  }
}
