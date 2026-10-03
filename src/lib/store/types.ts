import type {
  AlertEvent,
  AlertState,
  Channel,
  Place,
  Reading,
  SourceHealth,
  Station,
} from '../types'

export interface LatestRow {
  station: Station
  reading: Reading | null
}

/**
 * Persistence boundary. Two implementations:
 * - SqliteStore (node:sqlite file; dev + single-host Docker in Thailand)
 * - SupabaseStore (Postgres; cloud deployments)
 * All timestamps are ISO-8601 UTC strings.
 */
export interface Store {
  // --- stations & readings -------------------------------------------------
  upsertStations(stations: Station[]): Promise<void>
  /** Insert readings, ignoring duplicates of (stationId, observedAt). */
  insertReadings(readings: Reading[]): Promise<number>
  listStations(): Promise<Station[]>
  /** Latest reading per station (null when none). */
  latest(): Promise<LatestRow[]>
  /** Readings for the given stations since `sinceIso`, ascending by observedAt. */
  history(stationIds: string[], sinceIso: string): Promise<Record<string, Reading[]>>
  /** Delete readings older than `beforeIso`. Returns rows deleted. */
  pruneReadings(beforeIso: string): Promise<number>

  // --- source health / ingest bookkeeping ---------------------------------
  setSourceHealth(health: SourceHealth): Promise<void>
  listSourceHealth(): Promise<SourceHealth[]>
  setMeta(key: string, value: string): Promise<void>
  getMeta(key: string): Promise<string | null>

  // --- places & channels ---------------------------------------------------
  createPlace(place: Place): Promise<void>
  updatePlace(place: Place): Promise<void>
  getPlace(id: string): Promise<Place | null>
  listPlaces(): Promise<Place[]>
  deletePlace(id: string): Promise<void>

  addChannel(channel: Channel): Promise<void>
  updateChannel(channel: Channel): Promise<void>
  listChannels(placeId?: string): Promise<Channel[]>
  findChannelByLinkCode(code: string): Promise<Channel | null>
  deleteChannel(id: string): Promise<void>

  // --- alerting ---------------------------------------------------------------
  getAlertStates(placeId: string): Promise<AlertState[]>
  setAlertStates(states: AlertState[]): Promise<void>
  appendAlertEvent(event: AlertEvent): Promise<void>
  listAlertEvents(placeId: string, limit: number): Promise<AlertEvent[]>
}
