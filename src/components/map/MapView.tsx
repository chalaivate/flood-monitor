'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { distanceTh } from '@/lib/engine/format'
import { haversineKm } from '@/lib/geo'
import { bkkTime } from '@/lib/ui/chart'
import { openLocationDialog } from '@/lib/ui/dialog'
import { freeboardTh } from '@/lib/ui/format'
import { useNow } from '@/lib/ui/hooks'
import { LEVEL_LADDER, levelLabel } from '@/lib/ui/levels'
import { FALLBACK_PLACE, usePlace } from '@/lib/ui/place'
import { usePublicConfig } from '@/lib/ui/public-config'
import { loadRadarFrames, type RadarFrame } from '@/lib/ui/rainviewer'
import { countByFilter, DEFAULT_KIND_FILTERS, filterStations, KIND_FILTERS, useStations, type KindFilter } from '@/lib/ui/stations'
import { IconCheck, IconChevronRight, IconLayers, IconMapPin, IconRefresh } from '../icons'
import { LevelDot } from '../LevelBadge'

const StationsMap = dynamic(() => import('./StationsMap'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-muted">กำลังโหลดแผนที่…</div>,
})

const WIDE_QUERY = '(min-width: 640px)'

function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

type RadarState = { kind: 'off' } | { kind: 'loading' } | { kind: 'on'; frame: RadarFrame } | { kind: 'error' }

/** /map: every station on a full-height map with filters, radar overlay and nearest list. */
export function MapView() {
  const { place } = usePlace()
  const cfg = usePublicConfig()
  const stations = useStations()
  const nowMs = useNow(stations.data?.generatedAt ?? null)
  const [filters, setFilters] = useState<KindFilter[]>(DEFAULT_KIND_FILTERS)
  const [radar, setRadar] = useState<RadarState>({ kind: 'off' })
  const [selected, setSelected] = useState<string | null>(null)
  // null = automatic: expanded on wide screens, collapsed on phones (so the map stays visible).
  const [panelPref, setPanelPref] = useState<boolean | null>(null)
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => true)
  const panelOpen = panelPref ?? wide

  const all = stations.data?.stations ?? []
  const shown = filterStations(all, filters)
  const counts = countByFilter(all)
  const hasHome = !!place && place.origin !== 'default' && place.lat !== null && place.lng !== null
  const home = hasHome ? { lat: place.lat!, lng: place.lng!, radiusKm: place.radiusKm, label: place.label } : null
  const center = home ?? (place?.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : (cfg.config?.defaultPlace ?? FALLBACK_PLACE))
  const nearest = home
    ? all
        .filter((s) => s.kind === 'canal' || s.kind === 'river')
        .map((s) => ({ s, d: haversineKm(home.lat, home.lng, s.lat, s.lng) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 6)
    : []

  useEffect(() => {
    if (radar.kind !== 'loading') return
    const ctrl = new AbortController()
    loadRadarFrames(ctrl.signal)
      .then((f) => {
        const last = f[f.length - 1]
        setRadar(last ? { kind: 'on', frame: last } : { kind: 'error' })
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setRadar({ kind: 'error' })
      })
    return () => ctrl.abort()
  }, [radar.kind])

  const toggle = (id: KindFilter) => setFilters((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))

  return (
    <main className="relative h-[calc(100dvh-57px)] w-full overflow-hidden">
      <h1 className="sr-only">แผนที่จุดวัดระดับน้ำ ฝน และน้ำท่วมถนน</h1>
      <div className="absolute inset-0">
        {place && (
          <StationsMap
            stations={shown}
            center={center}
            home={home}
            radarUrl={radar.kind === 'on' ? radar.frame.url : null}
            selectedId={selected}
            nowMs={nowMs}
            onSetHome={(lat, lng) => openLocationDialog({ initial: { lat, lng, label: 'บ้าน' }, title: 'ตั้งตำแหน่งนี้เป็นบ้าน' })}
          />
        )}
      </div>

      <section
        aria-label="ตัวกรองและคำอธิบายแผนที่"
        className="card absolute right-2 bottom-2 left-2 z-[1000] max-h-[55dvh] overflow-y-auto shadow-xl sm:top-3 sm:right-auto sm:bottom-auto sm:left-14 sm:max-h-[calc(100%-24px)] sm:w-[340px]"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <div className="min-w-0">
            <p className="font-medium">แผนที่จุดวัด</p>
            <p className="text-xs text-muted">
              {stations.data ? `แสดง ${shown.length.toLocaleString('th-TH')} จาก ${all.length.toLocaleString('th-TH')} จุด` : stations.error ? 'โหลดข้อมูลไม่สำเร็จ' : 'กำลังโหลด…'}
              {stations.data ? ` · ข้อมูล ${bkkTime(Date.parse(stations.data.generatedAt))} น.` : ''}
            </p>
          </div>
          <button
            type="button"
            className="fm-icon-btn size-9"
            aria-expanded={panelOpen}
            aria-controls="map-panel-body"
            aria-label={panelOpen ? 'ย่อแผง' : 'ขยายแผง'}
            onClick={() => setPanelPref(!panelOpen)}
          >
            <IconChevronRight size={18} className={`transition-transform ${panelOpen ? 'rotate-90' : '-rotate-90'}`} />
          </button>
        </div>

        <div className="px-4 pt-2 pb-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="ประเภทจุดวัด">
            {KIND_FILTERS.map((f) => {
              const on = filters.includes(f.id)
              return (
                <button key={f.id} type="button" aria-pressed={on} onClick={() => toggle(f.id)} className={`fm-chip h-8 ${on ? 'fm-chip-accent' : 'text-text-2'}`}>
                  {on && <IconCheck size={14} />}
                  {f.label}
                  <span className="tabular text-xs text-muted">{counts[f.id]}</span>
                </button>
              )
            })}
          </div>
          {stations.error && !stations.data && (
            <p role="alert" className="mt-2 text-sm">
              {stations.error}{' '}
              <button type="button" className="underline" onClick={stations.refresh}>
                ลองใหม่
              </button>
            </p>
          )}
        </div>

        {panelOpen && (
          <div id="map-panel-body" className="border-t border-border px-4 pt-3 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={radar.kind === 'on' || radar.kind === 'loading'}
                className={`fm-chip h-8 ${radar.kind === 'on' ? 'fm-chip-accent' : ''}`}
                onClick={() => setRadar((r) => (r.kind === 'off' || r.kind === 'error' ? { kind: 'loading' } : { kind: 'off' }))}
              >
                <IconLayers size={16} />
                เรดาร์ฝน
                {radar.kind === 'loading' && <IconRefresh size={14} className="fm-spin" />}
              </button>
              <span className="text-xs text-muted" role="status">
                {radar.kind === 'on' && `ภาพเมื่อ ${bkkTime(radar.frame.time)} น. · RainViewer`}
                {radar.kind === 'error' && 'โหลดเรดาร์ไม่ได้ในขณะนี้'}
              </span>
            </div>

            <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm text-text-2" aria-label="สัญลักษณ์ระดับ">
              {LEVEL_LADDER.map((l) => (
                <li key={l} className="inline-flex items-center gap-1.5">
                  <LevelDot level={l} size={12} decorative /> {levelLabel(l)}
                </li>
              ))}
              <li className="inline-flex items-center gap-1.5">
                <LevelDot level="unknown" size={12} decorative /> ไม่มีข้อมูล/สถานีสูบ
              </li>
            </ul>
            <p className="mt-1 text-xs text-muted">คลอง/แม่น้ำวัดจากระยะห่างตลิ่ง · ฝนวัดจากปริมาณ 24 ชม. · ถนนวัดจากความลึกน้ำ</p>

            <div className="mt-3 border-t border-border pt-3">
              {home ? (
                <>
                  <p className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                    <IconMapPin size={16} /> ใกล้ {home.label}
                  </p>
                  {nearest.length === 0 ? (
                    <p className="text-sm text-muted">ไม่พบจุดวัดระดับน้ำ</p>
                  ) : (
                    <ul className="flex flex-col">
                      {nearest.map(({ s, d }) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(s.id)}
                            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-card-2"
                          >
                            <LevelDot level={s.stale ? 'unknown' : s.level} size={12} />
                            <span className="min-w-0 flex-1 truncate text-sm">{s.shortName || s.name}</span>
                            <span className="tabular shrink-0 text-xs text-text-2">
                              {s.stale ? 'ไม่มีข้อมูล' : freeboardTh(s.freeboard).replace('ห่างตลิ่ง ', '') || '-'}
                            </span>
                            <span className="tabular w-14 shrink-0 text-right text-xs text-muted">{distanceTh(d)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {d0Exceeds(nearest, home.radiusKm) && (
                    <p className="mt-1 text-xs text-muted">ไม่มีจุดวัดในรัศมี {home.radiusKm} กม. ลองขยายรัศมี</p>
                  )}
                </>
              ) : (
                <div className="text-sm text-text-2">
                  <p>แตะบนแผนที่เพื่อเลือกตำแหน่งบ้าน หรือ</p>
                  <button type="button" className="fm-btn fm-btn-primary mt-2" onClick={() => openLocationDialog()}>
                    ตั้งตำแหน่งบ้าน
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function d0Exceeds(list: { d: number }[], radiusKm: number): boolean {
  return list.length > 0 && list[0]!.d > radiusKm
}
