import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AlertEvent, AlertState, Channel, Place, Reading, SourceHealth, Station } from '../types'
import type { LatestRow, Store } from './types'

// Local store on Node's built-in SQLite (Node ≥ 22.13). WAL mode makes it safe for
// the Next.js server and the polling worker to share one file on the same host.

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
  station_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  water_level REAL,
  freeboard REAL,
  rain_1h REAL,
  rain_24h REAL,
  road_flood_cm REAL,
  pumps_running INTEGER,
  pumps_total INTEGER,
  official_status TEXT,
  PRIMARY KEY (station_id, observed_at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS readings_observed_at ON readings (observed_at);
CREATE TABLE IF NOT EXISTS source_health (source TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  type TEXT NOT NULL,
  link_code TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_place ON channels (place_id);
CREATE INDEX IF NOT EXISTS channels_link_code ON channels (link_code);
CREATE TABLE IF NOT EXISTS alert_states (
  place_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (place_id, key)
);
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_events_place ON alert_events (place_id, created_at);
CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
`

type Row = Record<string, unknown>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function rowToReading(r: Row): Reading {
  return {
    stationId: String(r.station_id),
    observedAt: String(r.observed_at),
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

/** Normalise any parseable timestamp to the canonical 24-char ISO form so text ordering is chronological. */
function iso(v: string): string {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${v}`)
  return d.toISOString()
}

export class SqliteStore implements Store {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // --- stations & readings ---------------------------------------------------
  async upsertStations(stations: Station[]): Promise<void> {
    if (stations.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO stations (id, source, kind, lat, lng, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source=excluded.source, kind=excluded.kind, lat=excluded.lat,
         lng=excluded.lng, data=excluded.data, updated_at=excluded.updated_at`,
    )
    this.tx(() => {
      for (const s of stations) stmt.run(s.id, s.source, s.kind, s.lat, s.lng, JSON.stringify(s), now)
    })
  }

  async insertReadings(readings: Reading[]): Promise<number> {
    if (readings.length === 0) return 0
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO readings (station_id, observed_at, water_level, freeboard, rain_1h, rain_24h,
         road_flood_cm, pumps_running, pumps_total, official_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    return this.tx(() => {
      let n = 0
      for (const r of readings) {
        const res = stmt.run(
          r.stationId,
          iso(r.observedAt),
          r.waterLevel ?? null,
          r.freeboard ?? null,
          r.rain1h ?? null,
          r.rain24h ?? null,
          r.roadFloodCm ?? null,
          r.pumpsRunning ?? null,
          r.pumpsTotal ?? null,
          r.officialStatus ?? null,
        )
        n += Number(res.changes)
      }
      return n
    })
  }

  async listStations(): Promise<Station[]> {
    return this.db
      .prepare('SELECT data FROM stations ORDER BY id')
      .all()
      .map((r) => JSON.parse(String((r as Row).data)) as Station)
  }

  async latest(): Promise<LatestRow[]> {
    const stations = await this.listStations()
    const rows = this.db
      .prepare(
        `SELECT r.* FROM readings r
         JOIN (SELECT station_id, MAX(observed_at) AS m FROM readings GROUP BY station_id) x
           ON r.station_id = x.station_id AND r.observed_at = x.m`,
      )
      .all() as Row[]
    const byStation = new Map(rows.map((r) => [String(r.station_id), rowToReading(r)]))
    return stations.map((station) => ({ station, reading: byStation.get(station.id) ?? null }))
  }

  async history(stationIds: string[], sinceIso: string): Promise<Record<string, Reading[]>> {
    const out: Record<string, Reading[]> = {}
    for (const id of stationIds) out[id] = []
    if (stationIds.length === 0) return out
    const placeholders = stationIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM readings WHERE station_id IN (${placeholders}) AND observed_at >= ?
         ORDER BY station_id, observed_at`,
      )
      .all(...stationIds, iso(sinceIso)) as Row[]
    for (const r of rows) out[String(r.station_id)]?.push(rowToReading(r))
    return out
  }

  async pruneReadings(beforeIso: string): Promise<number> {
    const res = this.db.prepare('DELETE FROM readings WHERE observed_at < ?').run(iso(beforeIso))
    return Number(res.changes)
  }

  // --- health & meta ------------------------------------------------------------
  async setSourceHealth(health: SourceHealth): Promise<void> {
    this.db
      .prepare('INSERT INTO source_health (source, data) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET data=excluded.data')
      .run(health.source, JSON.stringify(health))
  }

  async listSourceHealth(): Promise<SourceHealth[]> {
    return this.db
      .prepare('SELECT data FROM source_health ORDER BY source')
      .all()
      .map((r) => JSON.parse(String((r as Row).data)) as SourceHealth)
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  async tryLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date()
    const expires = new Date(now.getTime() + ttlMs).toISOString()
    return this.tx(() => {
      this.db.prepare('DELETE FROM locks WHERE name = ? AND expires_at < ?').run(name, now.toISOString())
      this.db
        .prepare(
          `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at WHERE locks.owner = excluded.owner`,
        )
        .run(name, owner, expires)
      const row = this.db.prepare('SELECT owner FROM locks WHERE name = ?').get(name) as Row | undefined
      return row?.owner === owner
    })
  }

  async unlock(name: string, owner: string): Promise<void> {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner)
  }

  // --- places & channels ----------------------------------------------------------
  async createPlace(place: Place): Promise<void> {
    this.db.prepare('INSERT INTO places (id, data, created_at) VALUES (?, ?, ?)').run(place.id, JSON.stringify(place), place.createdAt)
  }

  async updatePlace(place: Place): Promise<void> {
    this.db.prepare('UPDATE places SET data = ? WHERE id = ?').run(JSON.stringify(place), place.id)
  }

  async getPlace(id: string): Promise<Place | null> {
    const row = this.db.prepare('SELECT data FROM places WHERE id = ?').get(id) as Row | undefined
    return row ? (JSON.parse(String(row.data)) as Place) : null
  }

  async listPlaces(): Promise<Place[]> {
    return this.db
      .prepare('SELECT data FROM places ORDER BY created_at')
      .all()
      .map((r) => JSON.parse(String((r as Row).data)) as Place)
  }

  async deletePlace(id: string): Promise<void> {
    this.tx(() => {
      this.db.prepare('DELETE FROM channels WHERE place_id = ?').run(id)
      this.db.prepare('DELETE FROM alert_states WHERE place_id = ?').run(id)
      this.db.prepare('DELETE FROM alert_events WHERE place_id = ?').run(id)
      this.db.prepare('DELETE FROM places WHERE id = ?').run(id)
    })
  }

  async addChannel(channel: Channel): Promise<void> {
    this.db
      .prepare('INSERT INTO channels (id, place_id, type, link_code, data) VALUES (?, ?, ?, ?, ?)')
      .run(channel.id, channel.placeId, channel.type, channel.linkCode ?? null, JSON.stringify(channel))
  }

  async updateChannel(channel: Channel): Promise<void> {
    this.db
      .prepare('UPDATE channels SET place_id = ?, type = ?, link_code = ?, data = ? WHERE id = ?')
      .run(channel.placeId, channel.type, channel.linkCode ?? null, JSON.stringify(channel), channel.id)
  }

  async listChannels(placeId?: string): Promise<Channel[]> {
    const rows = placeId
      ? this.db.prepare('SELECT data FROM channels WHERE place_id = ? ORDER BY id').all(placeId)
      : this.db.prepare('SELECT data FROM channels ORDER BY id').all()
    return rows.map((r) => JSON.parse(String((r as Row).data)) as Channel)
  }

  async findChannelByLinkCode(code: string): Promise<Channel | null> {
    const row = this.db.prepare('SELECT data FROM channels WHERE link_code = ?').get(code) as Row | undefined
    return row ? (JSON.parse(String(row.data)) as Channel) : null
  }

  async deleteChannel(id: string): Promise<void> {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  }

  // --- alerting ---------------------------------------------------------------------
  async getAlertStates(placeId: string): Promise<AlertState[]> {
    return this.db
      .prepare('SELECT data FROM alert_states WHERE place_id = ? ORDER BY key')
      .all(placeId)
      .map((r) => JSON.parse(String((r as Row).data)) as AlertState)
  }

  async setAlertStates(states: AlertState[]): Promise<void> {
    if (states.length === 0) return
    const stmt = this.db.prepare(
      'INSERT INTO alert_states (place_id, key, data) VALUES (?, ?, ?) ON CONFLICT(place_id, key) DO UPDATE SET data=excluded.data',
    )
    this.tx(() => {
      for (const s of states) stmt.run(s.placeId, s.key, JSON.stringify(s))
    })
  }

  async clearAlertStates(placeId: string): Promise<void> {
    this.db.prepare('DELETE FROM alert_states WHERE place_id = ?').run(placeId)
  }

  async appendAlertEvent(event: AlertEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO alert_events (id, place_id, created_at, data) VALUES (?, ?, ?, ?)')
      .run(event.id, event.placeId, iso(event.createdAt), JSON.stringify(event))
  }

  async listAlertEvents(placeId: string, limit: number): Promise<AlertEvent[]> {
    return this.db
      .prepare('SELECT data FROM alert_events WHERE place_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(placeId, Math.max(1, Math.min(500, Math.floor(limit))))
      .map((r) => JSON.parse(String((r as Row).data)) as AlertEvent)
  }
}
