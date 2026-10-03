'use client'

import dynamic from 'next/dynamic'
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import type { RadarImage } from '@/lib/types'
import { usePublicConfig } from '@/lib/ui/public-config'
import { RAINVIEWER_TAB, radarTabLabel, radarTitle, tabKeyTarget } from '@/lib/ui/radar-tabs'
import { Card } from '../Card'

/** Official radar pages, shown as links when no embeddable radar is available. */
const RADAR_LINKS = [
  { href: 'https://weather.tmd.go.th/composite/index_composite.html', label: 'เรดาร์รวมกรมอุตุนิยมวิทยา' },
  { href: 'https://weather.bangkok.go.th/radar/RadarAnimation.aspx', label: 'เรดาร์ กทม. (ภาพเคลื่อนไหว)' },
]

const RadarMap = dynamic(() => import('../map/RadarMap'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center rounded-xl border border-border text-sm text-muted">กำลังโหลดแผนที่เรดาร์…</div>,
})

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
  const uid = useId()
  const [tab, setTab] = useState<string>(RAINVIEWER_TAB)
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
  const rainviewer = usePublicConfig().config?.rainviewer !== false
  const visible = images.filter((r) => !broken.includes(r.id))
  const fallbackTab = rainviewer ? RAINVIEWER_TAB : (visible[0]?.id ?? RAINVIEWER_TAB)
  const active = (tab === RAINVIEWER_TAB && rainviewer) || visible.some((r) => r.id === tab) ? tab : fallbackTab
  const tabs = [
    ...(rainviewer ? [{ id: RAINVIEWER_TAB, label: 'เคลื่อนไหว' }] : []),
    ...visible.map((r) => ({ id: r.id, label: radarTabLabel(r) })),
  ]
  const hasTabs = tabs.length > 1
  const tabId = (id: string) => `${uid}-tab-${id}`
  const panelId = `${uid}-panel`
  const img = visible.find((r) => r.id === active)
  // Cache-bust BMA images on their refresh cadence.
  const bucket = img ? Math.floor(nowMs / (Math.max(1, img.refreshMinutes) * 60_000)) : 0

  // WAI-ARIA tabs: one tab stop (roving tabIndex), arrows/Home/End move and select.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === active)
    const next = tabKeyTarget(e.key, index, tabs.length)
    if (next === null) return
    e.preventDefault()
    const target = tabs[next]!
    setTab(target.id)
    document.getElementById(tabId(target.id))?.focus()
  }

  return (
    <Card title={radarTitle(img)}>
      {hasTabs && (
        <div role="tablist" aria-label="แหล่งภาพเรดาร์" className="fm-tabs mb-3" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button
              key={t.id}
              id={tabId(t.id)}
              role="tab"
              type="button"
              aria-selected={active === t.id}
              aria-controls={panelId}
              tabIndex={active === t.id ? 0 : -1}
              className="fm-tabs-item"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={panelId}
        role={hasTabs ? 'tabpanel' : undefined}
        aria-labelledby={hasTabs ? tabId(active) : undefined}
        tabIndex={hasTabs && img ? 0 : undefined}
        className="h-[320px] sm:h-[360px]"
      >
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
        ) : rainviewer ? (
          <RadarMap lat={lat} lng={lng} radiusKm={radiusKm} nowMs={nowMs} />
        ) : (
          <div className="grid h-full place-items-center rounded-xl border border-border bg-card-2 p-4 text-center text-sm text-text-2">
            <div>
              <p className="mb-3">ไม่มีภาพเรดาร์ที่แสดงในหน้านี้ได้ในขณะนี้ ดูเรดาร์ทางการได้ที่</p>
              <ul className="space-y-1">
                {RADAR_LINKS.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-text underline underline-offset-2">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
      {!img && rainviewer && (
        <p className="mt-2 text-xs text-muted">
          สีฟ้า–น้ำเงิน = ฝนเล็กน้อยถึงปานกลาง · สีเหลือง–แดง = ฝนหนัก · ภาพย้อนหลังประมาณ 2 ชม.
        </p>
      )}
    </Card>
  )
}

