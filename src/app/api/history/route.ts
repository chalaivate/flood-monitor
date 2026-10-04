import { handler, HttpError, json } from '@/lib/server/http'
import { clamp, queryNumber } from '@/lib/server/validation'
import { getStore } from '@/lib/store'
import type { HistoryPoint } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_IDS = 8
const MAX_HOURS = 168

/** GET /api/history?ids=a,b&hours=48 → { series: Record<stationId, HistoryPoint[]> } */
export const GET = handler('history', async (req: Request) => {
  const q = new URL(req.url).searchParams
  const ids = [...new Set((q.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
  if (ids.length === 0) throw new HttpError(400, 'กรุณาระบุรหัสจุดวัด (ids)')
  if (ids.length > MAX_IDS) throw new HttpError(400, `ขอข้อมูลย้อนหลังได้ครั้งละไม่เกิน ${MAX_IDS} จุดวัด`)
  if (ids.some((id) => id.length > 200)) throw new HttpError(400, 'รหัสจุดวัดไม่ถูกต้อง')
  const hoursRaw = queryNumber(q, 'hours')
  if (hoursRaw !== undefined && !Number.isFinite(hoursRaw)) throw new HttpError(400, 'จำนวนชั่วโมงไม่ถูกต้อง')
  const hours = clamp(hoursRaw ?? 48, 1, MAX_HOURS)

  const store = await getStore()
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()
  const raw = await store.history(ids, since)
  const series: Record<string, HistoryPoint[]> = {}
  for (const id of ids) {
    series[id] = (raw[id] ?? []).map((r) => ({
      t: r.observedAt,
      waterLevel: r.waterLevel ?? null,
      freeboard: r.freeboard ?? null,
      rain24h: r.rain24h ?? null,
    }))
  }
  return json({ series }, { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' } })
})
