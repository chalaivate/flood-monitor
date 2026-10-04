'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchCameras, type PublicCamera } from '@/lib/ui/api'
import {
  CCTV_AUTO_PAUSED_TH,
  CCTV_CHAIN_TH,
  CCTV_RESUME_TH,
  CCTV_RIGHTS_TH,
  VIEWER_AUTO_PAUSE_MS,
  angleLabel,
  chaoPhrayaChain,
  creditTh,
  frameCopy,
  groupSites,
  sensorLevel,
  sensorLineTh,
  siteSensor,
  viewerAutoRefresh,
  viewerIntervalMs,
  type CameraSite,
  type SensorInfo,
} from '@/lib/ui/cctv'
import { distanceTh } from '@/lib/engine/format'
import { useNow } from '@/lib/ui/hooks'
import { IconChevronRight, IconClose, IconPause, IconPlay, IconRefresh } from '../icons'
import { LevelDot } from '../LevelBadge'
import { CameraFrame, OfficialLink } from './CameraFrame'
import { useCameraFrame, useCctvPaused, usePageVisible, useSaveData } from './hooks'
import { closeCameraViewer, openCameraViewer, useCameraViewer, type ViewerRequest } from './viewer-store'

/**
 * Camera viewer: a right-hand sheet on wide screens, full screen on phones (native modal
 * <dialog>: Escape closes, focus is trapped and returns to the opener). One camera at a time;
 * switching angle or site remounts the still and aborts its request.
 */
export function CameraViewer() {
  const v = useCameraViewer()
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (v && !d.open) d.showModal()
    if (!v && d.open) d.close()
  }, [v])

  return (
    <dialog ref={ref} className="fm-dialog fm-sheet" aria-labelledby="cam-viewer-title" onClose={() => closeCameraViewer()}>
      {v && <ViewerBody key={v.seq} request={v.request} />}
    </dialog>
  )
}

// The DWR camera list for the chain, loaded once per page (a few kB).
let chainCache: Promise<CameraSite[]> | null = null

function loadChain(): Promise<CameraSite[]> {
  if (!chainCache) {
    chainCache = fetchCameras().then((r) => groupSites(chaoPhrayaChain(r.cameras)))
    chainCache.catch(() => {
      chainCache = null
    })
  }
  return chainCache
}

type Resolved = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; sites: CameraSite[]; listLabel: string; sensors: Record<string, SensorInfo> }

function ViewerBody({ request }: { request: ViewerRequest }) {
  const [chain, setChain] = useState<Resolved>({ kind: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (request.kind !== 'chain') return
    let live = true
    loadChain()
      .then((sites) => live && setChain({ kind: 'ok', sites, listLabel: CCTV_CHAIN_TH, sensors: {} }))
      .catch(() => live && setChain({ kind: 'error' }))
    return () => {
      live = false
    }
  }, [request.kind, retry])

  const resolved: Resolved =
    request.kind === 'sites' ? { kind: 'ok', sites: request.sites, listLabel: request.listLabel ?? 'กล้อง', sensors: request.sensors ?? {} } : chain

  if (resolved.kind !== 'ok' || resolved.sites.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewerHeader title={CCTV_CHAIN_TH} subtitle="กรมทรัพยากรน้ำ" />
        <div className="flex-1 px-4 py-6 text-sm text-text-2 sm:px-5" role="status">
          {resolved.kind === 'loading' ? (
            'กำลังโหลดรายการกล้อง…'
          ) : (
            <>
              {resolved.kind === 'error' ? 'โหลดรายการกล้องไม่สำเร็จ' : 'เซิร์ฟเวอร์นี้ยังไม่มีกล้องแม่น้ำเจ้าพระยา'}
              {resolved.kind === 'error' && (
                <button
                  type="button"
                  className="fm-btn fm-btn-quiet ml-2"
                  onClick={() => {
                    setChain({ kind: 'loading' })
                    setRetry((n) => n + 1)
                  }}
                >
                  ลองใหม่
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <SiteViewer
      sites={resolved.sites}
      initialIndex={request.kind === 'sites' ? request.index : 0}
      initialCameraId={request.kind === 'sites' ? (request.cameraId ?? null) : null}
      listLabel={resolved.listLabel}
      sensors={resolved.sensors}
      chainMode={request.kind === 'chain'}
    />
  )
}

function ViewerHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 id="cam-viewer-title" className="text-lg leading-snug font-medium">
          {title}
        </h2>
        {subtitle && <p className="text-sm text-text-2">{subtitle}</p>}
      </div>
      <button type="button" className="fm-icon-btn -mr-2" aria-label="ปิด" onClick={() => closeCameraViewer()}>
        <IconClose />
      </button>
    </header>
  )
}

function SiteViewer({
  sites,
  initialIndex,
  initialCameraId,
  listLabel,
  sensors,
  chainMode,
}: {
  sites: CameraSite[]
  initialIndex: number
  initialCameraId: string | null
  listLabel: string
  sensors: Record<string, SensorInfo>
  chainMode: boolean
}) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), sites.length - 1))
  const site = sites[index]!
  const [cameraId, setCameraId] = useState<string | null>(initialCameraId)
  const angle = Math.max(
    0,
    site.cameras.findIndex((c) => c.id === cameraId),
  )
  const cam = site.cameras[angle]!
  const sensor = siteSensor(site, new Map(Object.entries(sensors)))
  const go = (i: number) => {
    setIndex((i + sites.length) % sites.length)
    setCameraId(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerHeader
        title={site.name}
        subtitle={[site.distanceKm !== null ? `ห่างจากบ้าน ${distanceTh(site.distanceKm)}` : '', site.owner].filter(Boolean).join(' · ')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
        {site.cameras.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="เลือกมุมกล้อง">
            {site.cameras.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={i === angle}
                className={`fm-chip h-8 ${i === angle ? 'fm-chip-accent font-medium' : 'text-text-2'}`}
                onClick={() => setCameraId(c.id)}
              >
                {angleLabel(c, i)}
              </button>
            ))}
          </div>
        )}
        <ViewerStill key={cam.id} cam={cam} />
        {sensor && (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-text-2">
            <span className="mt-[5px]">
              <LevelDot level={sensorLevel(sensor)} size={12} decorative />
            </span>
            <span>
              <span className="text-text">{sensorLineTh(sensor)}</span>
              <span className="block text-xs text-muted">จากเซ็นเซอร์ {sensor.name} ณ จุดเดียวกัน — สถานะมาจากเซ็นเซอร์ ไม่ได้มาจากภาพ</span>
            </span>
          </p>
        )}
        <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-xs leading-relaxed text-muted">
          <p className="text-text-2">
            {creditTh(cam.owner)}
            {cam.code ? ` · รหัส ${cam.code}` : ''}
          </p>
          <p>{CCTV_RIGHTS_TH}</p>
          <p className="flex flex-wrap gap-2 pt-1">
            <OfficialLink camera={cam} className="fm-btn fm-btn-quiet" />
            {cam.source === 'dwr-cctv' && !chainMode && (
              <button type="button" className="fm-btn fm-btn-quiet" onClick={() => openCameraViewer({ kind: 'chain' })}>
                {CCTV_CHAIN_TH}
              </button>
            )}
          </p>
        </div>
      </div>
      {sites.length > 1 && (
        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 sm:px-5">
          <button type="button" className="fm-btn fm-btn-quiet" onClick={() => go(index - 1)} aria-label="จุดกล้องก่อนหน้า">
            <IconChevronRight size={16} className="rotate-180" /> ก่อนหน้า
          </button>
          <span className="tabular min-w-0 truncate text-center text-xs text-muted" aria-live="polite">
            {listLabel} {index + 1}/{sites.length}
          </span>
          <button type="button" className="fm-btn fm-btn-quiet" onClick={() => go(index + 1)} aria-label="จุดกล้องถัดไป">
            ถัดไป <IconChevronRight size={16} />
          </button>
        </footer>
      )}
    </div>
  )
}

/** The still of one camera with its refresh controls (remounted per camera). */
function ViewerStill({ cam }: { cam: PublicCamera }) {
  const globalPaused = useCctvPaused()
  const saveData = useSaveData()
  const visible = usePageVisible()
  const nowMs = useNow(null, 15_000)
  // Starts paused when the page-wide pause is on; the viewer's own button overrides it.
  const [paused, setPaused] = useState(globalPaused)
  const [autoPaused, setAutoPaused] = useState(false)
  const [session, setSession] = useState(0)

  // Stop refreshing on our own after 5 minutes (counted again after "รีเฟรชต่อ").
  useEffect(() => {
    if (paused || saveData) return
    const t = setTimeout(() => setAutoPaused(true), VIEWER_AUTO_PAUSE_MS)
    return () => clearTimeout(t)
  }, [paused, saveData, session])

  const image = cam.media === 'image' && !!cam.imageUrl
  const auto = viewerAutoRefresh({ visible, paused, autoPaused, saveData })
  const frame = useCameraFrame(image ? cam.imageUrl : null, { enabled: true, auto, intervalMs: viewerIntervalMs(cam), bucketSec: cam.refreshSec })
  const copy = frameCopy(cam, { meta: frame.meta, loading: frame.loading, failure: frame.failure }, nowMs)
  const resume = () => {
    setPaused(false)
    setAutoPaused(false)
    setSession((n) => n + 1)
    frame.reload()
  }

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-border">
        <CameraFrame camera={cam} frame={frame} copy={copy} size="viewer" />
      </div>
      <p className="sr-only" aria-live="polite">
        {copy.live}
      </p>
      {copy.line && <p className="mt-2 text-sm text-text">{copy.line}</p>}
      {copy.notices.length > 0 && (frame.meta || cam.media === 'link') && (
        <ul className="mt-1.5 flex flex-col gap-1 text-sm text-text-2">
          {copy.notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {image && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {paused || autoPaused || saveData ? (
            <button type="button" className="fm-btn fm-btn-primary" onClick={resume} disabled={saveData && frame.loading}>
              {saveData ? <IconRefresh size={16} /> : <IconPlay size={16} />} {saveData ? 'โหลดภาพใหม่' : CCTV_RESUME_TH}
            </button>
          ) : (
            <button type="button" className="fm-btn fm-btn-quiet" onClick={() => setPaused(true)}>
              <IconPause size={16} /> หยุดรีเฟรช
            </button>
          )}
          {!(paused || autoPaused || saveData) && (
            <button type="button" className="fm-btn fm-btn-quiet" onClick={() => frame.reload()} disabled={frame.loading}>
              <IconRefresh size={16} className={frame.loading ? 'fm-spin' : ''} /> โหลดภาพใหม่
            </button>
          )}
          <span className="text-xs text-muted" role="status">
            {autoPaused && !paused
              ? CCTV_AUTO_PAUSED_TH
              : paused
                ? 'หยุดรีเฟรชอยู่'
                : saveData
                  ? 'โหมดประหยัดข้อมูล: ไม่รีเฟรชอัตโนมัติ (~50 KB ต่อภาพ)'
                  : `รีเฟรชทุก ${Math.round(viewerIntervalMs(cam) / 60_000)} นาที`}
          </span>
        </div>
      )}
    </div>
  )
}
