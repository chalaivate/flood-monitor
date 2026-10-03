'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import type { RadarImage } from '@/lib/types'
import { Card } from '../Card'

const RadarMap = dynamic(() => import('../map/RadarMap'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center rounded-xl border border-border text-sm text-muted">กำลังโหลดแผนที่เรดาร์…</div>,
})

const RV_TAB = 'rainviewer'

/** "เรดาร์ฝน": animated RainViewer mini-map plus BMA radar image tabs when they load. */
export function RadarCard({
  lat,
  lng,
  radiusKm,
  images,
  nowMs,
}: {
  lat: number
  lng: number
  radiusKm: number
  images: RadarImage[]
  nowMs: number
}) {
  const [tab, setTab] = useState<string>(RV_TAB)
  const [broken, setBroken] = useState<string[]>([])
  const urls = images.map((r) => `${r.id}\u0000${r.url}`).join('\u0001')

  // Probe each BMA image once so tabs for unreachable radars never appear.
  useEffect(() => {
    if (!urls) return
    const probes = urls.split('\u0001').map((entry) => {
      const [id, url] = entry.split('\u0000') as [string, string]
      const im = new Image()
      im.onerror = () => setBroken((b) => (b.includes(id) ? b : [...b, id]))
      im.src = url
      return im
    })
    return () => {
      for (const im of probes) im.onerror = null
    }
  }, [urls])
  const visible = images.filter((r) => !broken.includes(r.id))
  const active = tab === RV_TAB || visible.some((r) => r.id === tab) ? tab : RV_TAB
  const tabs = [{ id: RV_TAB, label: 'เคลื่อนไหว' }, ...visible.map((r) => ({ id: r.id, label: shortTitle(r.title) }))]
  const img = visible.find((r) => r.id === active)
  // Cache-bust BMA images on their refresh cadence.
  const bucket = img ? Math.floor(nowMs / (Math.max(1, img.refreshMinutes) * 60_000)) : 0

  return (
    <Card
      title={img ? `${img.title} ตอนนี้` : 'เรดาร์ฝนตอนนี้'}
      action={
        tabs.length > 1 ? (
          <div role="tablist" aria-label="แหล่งภาพเรดาร์" className="fm-tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={active === t.id}
                aria-controls="radar-panel"
                className="fm-tabs-item"
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <div id="radar-panel" role="tabpanel" className="h-[320px] sm:h-[360px]">
        {img ? (
          <figure className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card-2">
              {/* Proxied radar JPEG that changes every few minutes: next/image optimisation would only add latency. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${img.url}${img.url.includes('?') ? '&' : '?'}t=${bucket}`}
                alt={`${img.title} ภาพล่าสุด`}
                className="h-full w-full object-contain"
                onError={() => setBroken((b) => [...b, img.id])}
              />
            </div>
            <figcaption className="mt-2 text-xs text-muted">
              ที่มา: {img.source} · ปรับปรุงทุก {img.refreshMinutes} นาที
            </figcaption>
          </figure>
        ) : (
          <RadarMap lat={lat} lng={lng} radiusKm={radiusKm} nowMs={nowMs} />
        )}
      </div>
      {!img && (
        <p className="mt-2 text-xs text-muted">
          สีฟ้า–น้ำเงิน = ฝนเล็กน้อยถึงปานกลาง · สีเหลือง–แดง = ฝนหนัก · ภาพย้อนหลังประมาณ 2 ชม.
        </p>
      )}
    </Card>
  )
}

function shortTitle(title: string): string {
  const m = title.match(/\(([^)]+)\)/)
  return m?.[1] ?? title
}
