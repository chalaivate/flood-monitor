import type { DashboardSnapshot } from '@/lib/types'
import { durationTh } from '@/lib/ui/format'
import { sourceLabel } from '@/lib/ui/levels'
import { minutesBetween } from '@/lib/time'
import { LevelDot } from '../LevelBadge'

/** Key to the gauges: what the needle means, the thresholds in force, and where data come from. */
export function LegendCard({ snapshot, nowMs }: { snapshot: DashboardSnapshot; nowMs: number }) {
  const t = snapshot.place.freeboard
  const agencies = [...new Set([...snapshot.water, ...snapshot.rain, ...snapshot.roadFlood].map((s) => s.station.agency).filter(Boolean))]
  // One entry per agency label; a source is "down" when its last attempt failed.
  const bySource = new Map<string, { ok: boolean; lastSuccessAt?: string | null }>()
  for (const h of snapshot.sources) {
    const label = sourceLabel(h.source)
    const prev = bySource.get(label)
    bySource.set(label, { ok: (prev?.ok ?? false) || h.ok, lastSuccessAt: h.lastSuccessAt ?? prev?.lastSuccessAt })
  }
  const down = [...bySource.entries()].filter(([, v]) => !v.ok)

  return (
    <section className="card px-4 py-3.5 text-sm leading-relaxed text-text-2 sm:px-5" aria-label="คำอธิบายสัญลักษณ์">
      <p>
        <span className="text-text">เข็ม = ระยะจากผิวน้ำถึงขอบตลิ่ง (เมตร)</span> ยิ่งน้อยยิ่งใกล้ล้น
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        <li className="inline-flex items-center gap-1.5">
          <LevelDot level="normal" size={11} decorative /> ปกติ ≥ {t.watch.toFixed(2)}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <LevelDot level="watch" size={11} decorative /> เฝ้าระวัง &lt; {t.watch.toFixed(2)}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <LevelDot level="warning" size={11} decorative /> เตือนภัย &lt; {t.warning.toFixed(2)}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <LevelDot level="critical" size={11} decorative /> วิกฤต &lt; {t.critical.toFixed(2)} หรือล้นตลิ่ง
        </li>
        <li className="inline-flex items-center gap-1.5">
          <LevelDot level="unknown" size={11} decorative /> ไม่มีข้อมูล
        </li>
      </ul>
      {/* Attribute only the agencies whose data is on screen (none outside coverage). */}
      {agencies.length > 0 && <p className="mt-1.5 text-xs text-muted">ข้อมูล: {agencies.join(' · ')}</p>}
      {down.map(([label, v]) => (
        <p key={label} className="text-xs text-muted">
          แหล่งข้อมูลขัดข้อง: {label}
          {v.lastSuccessAt ? ` — ดึงสำเร็จล่าสุด ${durationTh(minutesBetween(v.lastSuccessAt, new Date(nowMs)))}ที่แล้ว` : ''}
        </p>
      ))}
    </section>
  )
}
