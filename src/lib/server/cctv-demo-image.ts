import { haversineKm } from '../geo'
import type { LatestRow, Store } from '../store/types'
import { formatShortBkk } from '../time'
import type { Camera, Reading, Station } from '../types'

// DATA_MODE=fixture: a runtime-generated picture for the simulated demo-cam cameras. It is a
// schematic road or canal whose water band follows the latest SIMULATED reading of the station
// the camera is joined to, with the time and a full-width watermark. No real camera frame is
// ever used, stored or committed (PDPA), and nothing here suggests a real view.

export const DEMO_WATERMARK = 'ภาพจำลอง — ไม่ใช่ภาพจากกล้องจริง'

const W = 640
const H = 480
/** Bottom caption bar height; the scene's lowest visible line is H - BAR. */
const BAR = 58
const FONT = "'IBM Plex Sans Thai', 'Noto Sans Thai', 'Leelawadee UI', Tahoma, sans-serif"

export interface DemoSceneInput {
  camera: Pick<Camera, 'name' | 'facing'>
  /** The joined station and its latest simulated reading (null: no data yet). */
  station: Pick<Station, 'kind' | 'name'> | null
  reading: Reading | null
  now: Date
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' })

/** At most `max` characters (Thai vowel and tone marks stay with their consonant). */
function clip(s: string, max: number): string {
  const chars = Array.from(graphemes.segment(s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()), (g) => g.segment)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** A wavy water surface from x0 to x1 at height y, closed down to (bottomLeft|bottomRight, bottomY). */
function waterPath(x0: number, x1: number, y: number, bottomLeft: number, bottomRight: number, bottomY = H): string {
  const amp = 4
  const step = 40
  let d = `M${r1(x0)},${r1(y)}`
  for (let x = x0; x < x1; x += step) {
    const nx = Math.min(x1, x + step)
    d += ` Q${r1((x + nx) / 2)},${r1(y + ((x / step) % 2 === 0 ? -amp : amp))} ${r1(nx)},${r1(y)}`
  }
  return `${d} L${r1(bottomRight)},${bottomY} L${r1(bottomLeft)},${bottomY} Z`
}

function roadScene(depthCm: number | null): { body: string; caption: string } {
  const parts = [
    `<rect x="0" y="0" width="${W}" height="200" fill="#cfd8e3"/>`,
    `<rect x="30" y="110" width="90" height="90" fill="#9aa5b1"/>`,
    `<rect x="130" y="80" width="70" height="120" fill="#8b96a3"/>`,
    `<rect x="440" y="95" width="80" height="105" fill="#8b96a3"/>`,
    `<rect x="530" y="125" width="90" height="75" fill="#9aa5b1"/>`,
    `<rect x="0" y="200" width="${W}" height="${H - 200}" fill="#b8b2a7"/>`,
    `<polygon points="260,200 380,200 600,${H} 40,${H}" fill="#5f6670"/>`,
    `<line x1="320" y1="205" x2="320" y2="${H}" stroke="#f4f4f5" stroke-width="5" stroke-dasharray="26 22"/>`,
  ]
  let caption = 'ยังไม่มีข้อมูลจำลองของจุดนี้'
  if (depthCm !== null) {
    const d = Math.max(0, depthCm)
    if (d > 0) {
      // 60 cm or more fills 200 px above the caption bar.
      const top = H - BAR - 6 - (Math.min(d, 60) / 60) * 200
      parts.push(`<path d="${waterPath(0, W, top, 0, W)}" fill="#2563eb" fill-opacity="0.55"/>`)
    }
    caption = `น้ำบนถนน (จำลอง) ${r1(d)} ซม.`
  }
  return { body: parts.join(''), caption }
}

function canalScene(freeboardM: number | null): { body: string; caption: string } {
  const bankY = 262
  const floorY = H - BAR - 4
  const [tl, tr, bl, br] = [120, 520, 210, 430]
  const xl = (y: number) => tl + ((y - bankY) / (floorY - bankY)) * (bl - tl)
  const xr = (y: number) => tr - ((y - bankY) / (floorY - bankY)) * (tr - br)
  const parts = [
    `<rect x="0" y="0" width="${W}" height="190" fill="#cfd8e3"/>`,
    `<rect x="0" y="170" width="${W}" height="40" fill="#6b8f5e"/>`,
    `<rect x="0" y="205" width="${W}" height="${H - 205}" fill="#a39581"/>`,
    `<polygon points="${tl},${bankY} ${tr},${bankY} ${br},${floorY} ${bl},${floorY}" fill="#5b4b3a"/>`,
    `<rect x="0" y="${floorY}" width="${W}" height="${H - floorY}" fill="#5b4b3a"/>`,
  ]
  let caption = 'ยังไม่มีข้อมูลจำลองของจุดนี้'
  if (freeboardM !== null) {
    // Freeboard 0 m = water at the bank top; 2 m or more = near the channel floor.
    const y = Math.max(215, Math.min(floorY - 6, bankY + (Math.min(freeboardM, 2) / 2) * (floorY - bankY - 6)))
    parts.push(
      y >= bankY
        ? `<path d="${waterPath(xl(y), xr(y), y, bl, br, floorY)}" fill="#2563eb" fill-opacity="0.6"/>`
        : `<path d="${waterPath(0, W, y, 0, W)}" fill="#2563eb" fill-opacity="0.55"/>`,
    )
    caption = `ระยะห่างตลิ่ง (จำลอง) ${freeboardM.toFixed(2)} ม.`
  }
  parts.push(
    `<line x1="40" y1="${bankY}" x2="${W - 40}" y2="${bankY}" stroke="#f4f4f5" stroke-width="2" stroke-dasharray="8 8"/>`,
    `<text x="${W - 44}" y="${bankY - 8}" font-family="${FONT}" font-size="16" fill="#ffffff" text-anchor="end">ระดับตลิ่ง</text>`,
  )
  return { body: parts.join(''), caption }
}

/** The demo picture as an SVG document (deterministic for a given input). */
export function renderDemoCameraSvg(input: DemoSceneInput): string {
  const { camera, station, reading, now } = input
  const roadLike = station ? station.kind === 'roadflood' : camera.facing !== 'water'
  const scene = roadLike
    ? roadScene(reading ? (reading.roadFloodCm ?? null) : null)
    : canalScene(reading && typeof reading.freeboard === 'number' ? reading.freeboard : null)
  const time = `${formatShortBkk(now.toISOString())} น.`
  const name = esc(clip(camera.name, 34))
  const from = station ? esc(clip(`จำลองจาก: ${station.name}`, 70)) : ''
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(DEMO_WATERMARK)}">`,
    `<title>${esc(DEMO_WATERMARK)}: ${name}</title>`,
    scene.body,
    `<rect x="0" y="0" width="${W}" height="44" fill="#000000" fill-opacity="0.6"/>`,
    `<text x="14" y="29" font-family="${FONT}" font-size="19" fill="#ffffff">${name}</text>`,
    `<text x="${W - 14}" y="29" font-family="${FONT}" font-size="19" fill="#ffffff" text-anchor="end">${esc(time)}</text>`,
    // Full-width watermark across the frame, above the water so the band stays visible.
    `<rect x="0" y="146" width="${W}" height="56" fill="#ffffff" fill-opacity="0.85"/>`,
    `<text x="20" y="185" textLength="${W - 40}" lengthAdjust="spacingAndGlyphs" font-family="${FONT}" font-size="30" font-weight="700" fill="#b91c1c">${esc(DEMO_WATERMARK)}</text>`,
    `<rect x="0" y="${H - BAR}" width="${W}" height="${BAR}" fill="#000000" fill-opacity="0.65"/>`,
    `<text x="14" y="${H - 33}" font-family="${FONT}" font-size="17" fill="#ffffff">${esc(scene.caption)}</text>`,
    from ? `<text x="14" y="${H - 11}" font-family="${FONT}" font-size="13" fill="#e5e7eb">${from}</text>` : '',
    '</svg>',
  ].join('')
}

/**
 * Station the demo camera shows: the one its catalogue entry names (`stationId`, the camera's
 * server-side ref), then its joined stations, else the nearest water/road gauge within 500 m.
 */
export function pickDemoStation(camera: Pick<Camera, 'nearStationIds' | 'lat' | 'lng'>, latest: LatestRow[], stationId?: string | null): LatestRow | null {
  const usable = (r: LatestRow) => r.station.kind === 'roadflood' || r.station.kind === 'canal' || r.station.kind === 'river'
  for (const id of [...(stationId ? [stationId] : []), ...camera.nearStationIds]) {
    const row = latest.find((r) => r.station.id === id)
    if (row && usable(row)) return row
  }
  let best: { row: LatestRow; d: number } | null = null
  for (const row of latest) {
    if (!usable(row)) continue
    const d = haversineKm(camera.lat, camera.lng, row.station.lat, row.station.lng)
    if (d <= 0.5 && (!best || d < best.d)) best = { row, d }
  }
  return best?.row ?? null
}

/** The demo picture for a demo-cam camera, from the latest simulated readings in the store. */
export async function demoCameraSvg(store: Store, camera: Camera, now: Date, stationId?: string | null): Promise<string> {
  const row = pickDemoStation(camera, await store.latest(), stationId)
  return renderDemoCameraSvg({ camera, station: row?.station ?? null, reading: row?.reading ?? null, now })
}
