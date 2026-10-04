'use client'

import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import type { CamerasResponse } from '@/lib/ui/api'
import {
  CCTV_CARD_SUBTITLE,
  CCTV_CARD_TITLE,
  CCTV_CHAIN_TH,
  CCTV_PAUSE_TH,
  CCTV_RIGHTS_TH,
  cardQuery,
  creditTh,
  groupSites,
  noCamerasTh,
  ownersOf,
  rankSites,
  type SensorInfo,
} from '@/lib/ui/cctv'
import { Card, EmptyState } from '../Card'
import { IconCheck, IconMapPin, IconPause } from '../icons'
import { CameraLinks } from './CameraFrame'
import { IconCamera } from './CameraGlyph'
import { CameraTile } from './CameraTile'
import { setCctvPaused, useCctvPaused, useOnScreen, usePageVisible, useSaveData } from './hooks'
import { openCameraViewer } from './viewer-store'

/** True when the server has camera sources switched on (otherwise the card is not shown). */
export function camerasEnabled(data: CamerasResponse | null): data is CamerasResponse {
  return !!data && Object.keys(data.catalogAt).length > 0
}

/**
 * Dashboard card "กล้อง CCTV ใกล้บ้าน": up to 4 camera sites around the place (2×2), sites
 * whose sensor is at "เฝ้าระวัง" or worse first, filled from beyond the radius up to 10 km.
 * Stills refresh every 3 min only while the card is on screen, the tab is visible, the global
 * pause is off and Save-Data is off. Pictures never affect status.
 */
export function CameraCard({
  data,
  place,
  sensors,
  nowMs,
}: {
  data: CamerasResponse
  place: { lat: number; lng: number; radiusKm: number }
  sensors: ReadonlyMap<string, SensorInfo>
  nowMs: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(box)
  const visible = usePageVisible()
  const paused = useCctvPaused()
  const saveData = useSaveData()
  const [tapped, setTapped] = useState<ReadonlySet<string>>(() => new Set())
  const sites = useMemo(() => rankSites(groupSites(data.cameras), { radiusKm: place.radiusKm, sensors }), [data.cameras, place.radiusKm, sensors])
  const owners = ownersOf(sites.flatMap((s) => s.cameras))
  const listed = Object.values(data.catalogAt).some((t) => !!t)
  const chain = !!data.catalogAt['dwr-cctv']
  const conditions = { onScreen, visible, paused, saveData }

  return (
    <div ref={box}>
      <Card
        id="cctv"
        title={CCTV_CARD_TITLE}
        subtitle={CCTV_CARD_SUBTITLE}
        action={
          sites.some((s) => s.cameras.some((c) => c.media === 'image')) ? (
            <button
              type="button"
              className={`fm-chip h-8 ${paused ? 'fm-chip-accent' : 'text-text-2'}`}
              aria-pressed={paused}
              aria-label={CCTV_PAUSE_TH}
              title={CCTV_PAUSE_TH}
              onClick={() => setCctvPaused(!paused)}
            >
              {paused ? <IconCheck size={14} /> : <IconPause size={14} />}
              หยุดรีเฟรช
            </button>
          ) : null
        }
      >
        {sites.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="กล้องใกล้บ้าน">
            {sites.map((site, i) => (
              <CameraTile
                key={site.siteId}
                site={site}
                conditions={conditions}
                tapped={tapped.has(site.siteId)}
                onTap={() => setTapped((t) => new Set(t).add(site.siteId))}
                onOpen={() =>
                  openCameraViewer({ kind: 'sites', sites, index: i, listLabel: 'กล้องใกล้บ้าน', sensors: Object.fromEntries(sensors) })
                }
                nowMs={nowMs}
              />
            ))}
          </ul>
        ) : (
          <EmptyState title={listed ? noCamerasTh(cardQuery(place).r, data.nearestOutsideKm) : 'เซิร์ฟเวอร์นี้ยังไม่มีรายการกล้อง'} icon={<IconCamera size={28} />}>
            {!listed && <p>ดูภาพกล้องได้ที่เว็บของหน่วยงานด้านล่าง</p>}
          </EmptyState>
        )}

        {sites.length > 0 && (paused || saveData) && (
          <p className="mt-2 text-xs text-text-2" role="status">
            {paused
              ? 'หยุดรีเฟรชภาพกล้องไว้ — ภาพอาจไม่ใช่ภาพปัจจุบัน กด “หยุดรีเฟรช” อีกครั้งเพื่อรีเฟรชต่อ'
              : 'โหมดประหยัดข้อมูล: แตะภาพเพื่อโหลด (~50 KB ต่อภาพ) ไม่รีเฟรชอัตโนมัติ'}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href="/map?cams=1" className="fm-btn fm-btn-quiet">
            <IconMapPin size={16} /> ดูทั้งหมดบนแผนที่
          </Link>
          {chain && (
            <button type="button" className="fm-btn fm-btn-quiet" onClick={() => openCameraViewer({ kind: 'chain' })}>
              <IconCamera size={16} /> {CCTV_CHAIN_TH}
            </button>
          )}
        </div>
        <div className="mt-3">
          <CameraLinks links={data.links} />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {owners.length > 0 && <>{creditTh(owners.join(' · '))} — </>}
          {CCTV_RIGHTS_TH} ·{' '}
          <Link href="/about#cctv" className="underline underline-offset-2">
            เงื่อนไขการแสดงภาพ
          </Link>
        </p>
      </Card>
    </div>
  )
}
