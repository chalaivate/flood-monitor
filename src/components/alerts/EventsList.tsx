import type { AlertEvent, AlertKind } from '@/lib/types'
import { formatShortBkk } from '@/lib/time'
import { EmptyState } from '../Card'
import { LevelDot } from '../LevelBadge'

const KIND_TH: Record<AlertKind, string> = {
  escalate: 'ระดับสูงขึ้น',
  deescalate: 'คลี่คลาย',
  rapid_rise: 'น้ำขึ้นเร็ว',
  rain: 'ฝนหนัก',
  stale: 'ข้อมูลขาดหาย',
  test: 'ทดสอบ',
}

/** Alert history (GET /api/places/[id]/events), newest first. */
export function EventsList({ events, error }: { events: AlertEvent[] | null; error: string | null }) {
  if (!events) return <p className="text-sm text-muted">{error ?? 'กำลังโหลดประวัติ…'}</p>
  if (events.length === 0) {
    return <EmptyState title="ยังไม่มีการแจ้งเตือน">เมื่อสถานการณ์เปลี่ยน ข้อความที่ส่งจะแสดงที่นี่</EmptyState>
  }
  return (
    <ol className="flex flex-col divide-y divide-border">
      {events.map((e) => {
        const ok = e.deliveries?.filter((d) => d.ok).length ?? 0
        const total = e.deliveries?.length ?? 0
        return (
          <li key={e.id} className="py-3">
            <details>
              <summary className="flex cursor-pointer list-none items-start gap-3">
                <span className="mt-1">
                  <LevelDot level={e.level} size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{e.title}</span>
                  <span className="block text-xs text-muted">
                    {formatShortBkk(e.createdAt)} น. · {KIND_TH[e.kind] ?? e.kind}
                    {total > 0 ? ` · ส่งสำเร็จ ${ok}/${total}` : ''}
                  </span>
                </span>
              </summary>
              <p className="mt-2 ml-6 text-sm whitespace-pre-line text-text-2">{e.body}</p>
            </details>
          </li>
        )
      })}
    </ol>
  )
}
