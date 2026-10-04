import { distanceTh } from '@/lib/engine/format'
import { rainClassTh } from '@/lib/engine/status'
import { formatShortBkk } from '@/lib/time'
import type { MapStation } from '@/lib/ui/api'
import { ageTh, freeboardTh } from '@/lib/ui/format'
import { viewAtStationTh } from '@/lib/ui/cctv'
import { KIND_LABEL_TH, sourceLabel } from '@/lib/ui/levels'
import { IconCamera } from '../cctv/CameraGlyph'
import { LevelBadge } from '../LevelBadge'

function num(v: number | null | undefined, d = 2): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null
}

/**
 * Thai details for one station (map popup and list). Text only; safe from injected markup.
 * `cameraCount` > 0 (cameras joined to this station, known once the camera layer has loaded)
 * adds "ดูกล้องที่จุดนี้ (N มุม)".
 */
export function StationPopup({
  s,
  nowMs,
  homeKm,
  cameraCount = 0,
  onViewCameras,
}: {
  s: MapStation
  nowMs: number
  homeKm?: number | null
  cameraCount?: number
  onViewCameras?: () => void
}) {
  const rows: [string, string][] = []
  if (s.kind === 'canal' || s.kind === 'river') {
    const wl = num(s.waterLevel)
    const bank = num(s.bankLevel)
    if (wl) rows.push(['ระดับน้ำ', `${wl} ม.`])
    if (bank) rows.push(['ระดับตลิ่ง', `${bank} ม.`])
    const fb = freeboardTh(s.freeboard)
    rows.push(['ระยะห่างตลิ่ง', fb ? fb.replace(/^ห่างตลิ่ง /, '') : 'ไม่มีข้อมูลตลิ่ง'])
  } else if (s.kind === 'rain') {
    const r24 = num(s.rain24h, 1)
    rows.push(['ฝน 24 ชม.', r24 ? `${r24} มม. (${rainClassTh(s.rain24h)})` : '-'])
    const r1 = num(s.rain1h, 1)
    if (r1) rows.push(['ฝน 1 ชม.', `${r1} มม.`])
  } else if (s.kind === 'roadflood') {
    const cm = s.roadFloodCm
    rows.push(['น้ำบนถนน', typeof cm === 'number' ? (cm > 0 ? `${Math.round(cm)} ซม.` : 'ถนนแห้ง') : '-'])
  }
  if (s.officialStatus) rows.push([s.kind === 'pump' ? 'สถานะ' : 'สถานะตามหน่วยงาน', s.officialStatus])

  return (
    <div className="min-w-[220px] max-w-[280px]">
      <div className="font-medium text-text">{s.name}</div>
      <div className="text-xs text-muted">
        {KIND_LABEL_TH[s.kind]}
        {s.district ? ` · เขต${s.district}` : ''}
        {typeof homeKm === 'number' ? ` · ห่างจากบ้าน ${distanceTh(homeKm)}` : ''}
      </div>
      {s.kind !== 'pump' && <LevelBadge level={s.stale ? 'unknown' : s.level} className="mt-1.5 text-sm" />}
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.85rem]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-2">{k}</dt>
            <dd className="tabular text-right text-text">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-1.5 text-xs text-muted">
        {s.stale ? 'ไม่มีข้อมูลล่าสุด · ' : ''}
        {s.observedAt ? `อัปเดต ${ageTh(s.observedAt, nowMs)} (${formatShortBkk(s.observedAt)} น.)` : 'ยังไม่มีข้อมูล'}
      </div>
      <div className="text-xs text-muted">ที่มา: {sourceLabel(s.source)}</div>
      {cameraCount > 0 && onViewCameras && (
        <button type="button" className="fm-btn fm-btn-quiet mt-2" onClick={onViewCameras}>
          <IconCamera size={16} /> {viewAtStationTh(cameraCount)}
        </button>
      )}
    </div>
  )
}
