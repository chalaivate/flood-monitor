'use client'

import type { ReactNode } from 'react'
import type { DashboardSnapshot, HistoryPoint } from '@/lib/types'
import { LEVEL_ORDER } from '@/lib/types'
import type { DataMode } from '@/lib/ui/api'
import { bkkTime } from '@/lib/ui/chart'
import { openLocationDialog } from '@/lib/ui/dialog'
import { durationTh, frozenSources, isIngestStale } from '@/lib/ui/format'
import { sourceLabel } from '@/lib/ui/levels'
import { notifyPlaceChanged, readStoredPlace, shareUrl, stripPlaceParams, type ResolvedPlace } from '@/lib/ui/place'
import { minutesBetween } from '@/lib/time'
import { Banner } from '../Banner'
import { CopyButton } from '../CopyButton'
import { IconAlert, IconLink, IconRefresh } from '../icons'
import { GaugeGrid } from './GaugeGrid'
import { HistoryChart } from './HistoryChart'
import { LegendCard } from './LegendCard'
import { RadarCard } from './RadarCard'
import { RainGaugeCard } from './RainGaugeCard'
import { RoadFloodCard } from './RoadFloodCard'
import { SituationCard } from './SituationCard'
import { WeatherCard } from './WeatherCard'

export interface DashboardProps {
  snapshot: DashboardSnapshot | null
  place: ResolvedPlace | null
  dataMode: DataMode | null
  nowMs: number
  history: { data: Record<string, HistoryPoint[]> | null; error: string | null }
  status: { error: string | null; updatedAt: number | null; carriedOver: boolean }
  onRetry?: () => void
  /** Extra controls rendered above the banners (dev preview variant switcher). */
  toolbar?: ReactNode
}

/** HA-style dashboard: 3 columns on desktop, 2 on tablets, 1 on phones (priority order). */
export function Dashboard({ snapshot, place, dataMode, nowMs, history, status, onRetry, toolbar }: DashboardProps) {
  const label = snapshot?.place.label ?? place?.label ?? ''
  return (
    <main className="mx-auto w-full max-w-[1680px] px-3 pt-3 pb-10 sm:px-4 sm:pt-4">
      <h1 className="sr-only">แดชบอร์ดเฝ้าระวังน้ำท่วม {label}</h1>
      {toolbar}
      <DashboardHeader snapshot={snapshot} place={place} status={status} onRetry={onRetry} />
      <Banners snapshot={snapshot} place={place} dataMode={dataMode} nowMs={nowMs} />
      {snapshot ? (
        <Grid snapshot={snapshot} nowMs={nowMs} history={history} dimmed={status.carriedOver} />
      ) : status.error ? (
        <div className="mt-3">
          <Banner tone="warning" title="โหลดข้อมูลสถานการณ์ไม่สำเร็จ" role="alert" action={onRetry && <RetryButton onRetry={onRetry} />}>
            {status.error}
          </Banner>
        </div>
      ) : (
        <LoadingGrid />
      )}
    </main>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className="fm-btn fm-btn-quiet" onClick={onRetry}>
      <IconRefresh size={16} /> ลองใหม่
    </button>
  )
}

function DashboardHeader({
  snapshot,
  place,
  status,
  onRetry,
}: {
  snapshot: DashboardSnapshot | null
  place: ResolvedPlace | null
  status: DashboardProps['status']
  onRetry?: () => void
}) {
  const p = snapshot?.place
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-lg font-medium sm:text-xl">{p?.label ?? place?.label ?? 'กำลังโหลด…'}</p>
        {p && (
          <p className="text-sm text-text-2">
            รัศมี {p.radiusKm} กม. · ติดตาม {snapshot.water.length} จุดวัดที่ใกล้ที่สุด
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status.error && snapshot ? (
          <span className="fm-chip fm-chip-warn" role="status">
            <IconAlert size={16} />
            <span>
              เชื่อมต่อไม่ได้ · แสดงข้อมูลเมื่อ {status.updatedAt ? bkkTime(status.updatedAt) : bkkTime(Date.parse(snapshot.generatedAt))} น.
            </span>
            {onRetry && (
              <button type="button" className="ml-1 underline underline-offset-2" onClick={onRetry}>
                ลองใหม่
              </button>
            )}
          </span>
        ) : status.updatedAt ? (
          <span className="text-xs text-muted" role="status">
            โหลดล่าสุด {bkkTime(status.updatedAt)} น. · รีเฟรชอัตโนมัติทุก 1 นาที
          </span>
        ) : null}
        {snapshot && (
          <CopyButton
            label="คัดลอกลิงก์"
            icon={<IconLink size={18} />}
            getText={() => shareUrl(window.location.origin, { ...snapshot.place, placeId: place?.placeId })}
          />
        )}
      </div>
    </div>
  )
}

function Banners({
  snapshot,
  place,
  dataMode,
  nowMs,
}: {
  snapshot: DashboardSnapshot | null
  place: ResolvedPlace | null
  dataMode: DataMode | null
  nowMs: number
}) {
  const out: ReactNode[] = []
  if (dataMode === 'fixture') {
    out.push(
      <Banner key="demo" tone="demo" title="ข้อมูลตัวอย่างสำหรับสาธิต ไม่ใช่ข้อมูลจริง" role="status">
        ระดับน้ำ ฝน และสถานะที่แสดงเป็นค่าจำลอง ห้ามใช้ตัดสินใจในสถานการณ์จริง
      </Banner>,
    )
  }
  if (snapshot && LEVEL_ORDER[snapshot.overall.level] >= LEVEL_ORDER.warning) {
    out.push(
      <Banner key="danger" tone={snapshot.overall.level} title={snapshot.overall.headline} role="alert">
        เตรียมยกของขึ้นที่สูงและติดตามประกาศทางการ · เหตุฉุกเฉินโทร{' '}
        <a href="tel:1555" className="font-medium text-text underline underline-offset-2">
          1555
        </a>{' '}
        (กทม.) หรือ{' '}
        <a href="tel:1784" className="font-medium text-text underline underline-offset-2">
          1784
        </a>{' '}
        (ปภ.)
      </Banner>,
    )
  }
  if (snapshot && isIngestStale(snapshot.lastIngestAt, snapshot.pollMinutes, nowMs)) {
    const mins = snapshot.lastIngestAt ? minutesBetween(snapshot.lastIngestAt, new Date(nowMs)) : null
    out.push(
      <Banner key="stale" tone="watch" title={mins === null ? 'ยังไม่มีการดึงข้อมูลจากแหล่งข้อมูล' : `ข้อมูลไม่ได้อัปเดตมา ${durationTh(mins)}`} role="status">
        ระบบดึงข้อมูลอาจขัดข้อง ค่าที่แสดงอาจไม่ใช่สถานการณ์ปัจจุบัน ระบบจะลองใหม่อัตโนมัติ
      </Banner>,
    )
  }
  const frozen = snapshot && !isIngestStale(snapshot.lastIngestAt, snapshot.pollMinutes, nowMs) ? frozenSources(snapshot.sources, nowMs) : []
  if (frozen.length > 0) {
    out.push(
      <Banner key="frozen" tone="watch" title="บางแหล่งข้อมูลไม่มีค่าใหม่" role="status">
        {frozen
          .map(({ source, minutes }) => `${sourceLabel(source.source)} (${source.source}) ค่าล่าสุดเมื่อ ${durationTh(minutes)}ที่แล้ว`)
          .join(' · ')}
        {' — จุดวัดจากแหล่งนี้จะแสดงเป็น “ไม่มีข้อมูลล่าสุด”'}
      </Banner>,
    )
  }
  if (place?.origin === 'default') {
    out.push(
      <Banner
        key="setplace"
        tone="info"
        title="ตั้งตำแหน่งบ้านของคุณ"
        action={
          <button type="button" className="fm-btn fm-btn-primary" onClick={() => openLocationDialog()}>
            เลือกตำแหน่ง
          </button>
        }
      >
        ขณะนี้แสดงข้อมูลรอบ{place.label}ซึ่งเป็นตำแหน่งเริ่มต้น เลือกตำแหน่งบ้านเพื่อดูจุดวัดระดับน้ำที่ใกล้คุณที่สุด
      </Banner>,
    )
  }
  if (snapshot && (place?.origin === 'url' || (place?.origin === 'url-id' && !place.manageToken))) {
    out.push(
      <Banner
        key="shared"
        tone="info"
        title={`กำลังดูตำแหน่งจากลิงก์ที่แชร์: ${snapshot.place.label}`}
        action={
          <>
            <button
              type="button"
              className="fm-btn fm-btn-primary"
              onClick={() =>
                openLocationDialog({
                  title: 'บันทึกเป็นตำแหน่งบ้านของฉัน',
                  initial: {
                    label: snapshot.place.label,
                    lat: snapshot.place.lat,
                    lng: snapshot.place.lng,
                    radiusKm: snapshot.place.radiusKm,
                    maxStations: snapshot.place.maxStations,
                  },
                })
              }
            >
              ตั้งเป็นบ้านของฉัน
            </button>
            {readStoredPlace() && (
              <button
                type="button"
                className="fm-btn fm-btn-quiet"
                onClick={() => {
                  window.history.replaceState(null, '', `${window.location.pathname}${stripPlaceParams(window.location.search)}`)
                  notifyPlaceChanged()
                }}
              >
                กลับไปที่บ้านของฉัน
              </button>
            )}
          </>
        }
      >
        ตำแหน่งนี้ยังไม่ได้บันทึกในเครื่องของคุณ
      </Banner>,
    )
  }
  if (out.length === 0) return null
  return <div className="mb-3 flex flex-col gap-2">{out}</div>
}

function Grid({
  snapshot,
  nowMs,
  history,
  dimmed,
}: {
  snapshot: DashboardSnapshot
  nowMs: number
  history: DashboardProps['history']
  dimmed: boolean
}) {
  const p = snapshot.place
  return (
    <div className={`flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start lg:grid-cols-3 ${dimmed ? 'opacity-60' : ''} transition-opacity`}>
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
        <div className="order-1 min-w-0 lg:order-none">
          <SituationCard snapshot={snapshot} />
        </div>
        <div className="order-6 min-w-0 lg:order-none">
          <RadarCard lat={p.lat} lng={p.lng} radiusKm={p.radiusKm} images={snapshot.radar} nowMs={nowMs} />
        </div>
      </div>
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
        <div className="order-2 min-w-0 lg:order-none">
          <GaugeGrid snapshot={snapshot} nowMs={nowMs} />
        </div>
        <div className="order-5 min-w-0 lg:order-none">
          <WeatherCard weather={snapshot.weather} nowMs={nowMs} />
        </div>
      </div>
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
        <div className="order-7 min-w-0 lg:order-none">
          <LegendCard snapshot={snapshot} nowMs={nowMs} />
        </div>
        <div className="order-3 min-w-0 lg:order-none">
          <HistoryChart water={snapshot.water} series={history.data} error={history.error} thresholds={p.freeboard} nowMs={nowMs} />
        </div>
        <div className="order-4 min-w-0 lg:order-none">
          <RainGaugeCard snapshot={snapshot} />
        </div>
        {snapshot.roadFlood.length > 0 && (
          <div className="order-4 min-w-0 lg:order-none">
            <RoadFloodCard items={snapshot.roadFlood} nowMs={nowMs} />
          </div>
        )}
      </div>
    </div>
  )
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-live="polite">
      {['สถานการณ์ตอนนี้', 'ระยะห่างตลิ่ง', 'ระยะห่างตลิ่ง 48 ชม.'].map((t) => (
        <div key={t} className="card h-64 p-5">
          <p className="text-lg text-text-2">{t}</p>
          <p className="mt-2 text-sm text-muted">กำลังโหลดข้อมูล…</p>
        </div>
      ))}
    </div>
  )
}
