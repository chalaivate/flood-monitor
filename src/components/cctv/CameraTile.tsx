'use client'

import {
  CCTV_DEMO_TH,
  anglesTh,
  creditTh,
  frameCopy,
  sensorLevel,
  sensorLineTh,
  siteDistanceTh,
  tileAutoRefresh,
  tileIntervalMs,
  tileMayLoad,
  type RankedSite,
  type RefreshConditions,
} from '@/lib/ui/cctv'
import { LevelDot } from '../LevelBadge'
import { CameraFrame } from './CameraFrame'
import { useCameraFrame } from './hooks'

/** The angle a tile shows: the first one this server has stills for. */
export function tileCamera(site: RankedSite) {
  return site.cameras.find((c) => c.media === 'image' && c.imageUrl) ?? site.cameras[0]!
}

/**
 * One camera site on the dashboard card: thumbnail with a time badge (and "N มุม" for several
 * angles), name, distance, the joined sensor's own reading, credit. Tapping opens the viewer;
 * under Save-Data the first tap loads the still instead.
 */
export function CameraTile({
  site,
  conditions,
  tapped,
  onTap,
  onOpen,
  nowMs,
}: {
  site: RankedSite
  conditions: RefreshConditions
  tapped: boolean
  onTap: () => void
  onOpen: () => void
  nowMs: number
}) {
  const cam = tileCamera(site)
  const image = cam.media === 'image' && !!cam.imageUrl
  const frame = useCameraFrame(image ? cam.imageUrl : null, {
    enabled: tileMayLoad({ onScreen: conditions.onScreen, saveData: conditions.saveData, tapped }),
    auto: tileAutoRefresh(conditions),
    intervalMs: tileIntervalMs(cam),
    bucketSec: cam.refreshSec,
  })
  const tapToLoad = image && conditions.saveData && !tapped && !frame.meta
  const copy = frameCopy(cam, { meta: frame.meta, loading: frame.loading, failure: frame.failure, tapToLoad }, nowMs)
  const notice = copy.warn || copy.linkOnly ? copy.notices.filter((n) => n !== CCTV_DEMO_TH).at(-1) : null
  const sensor = site.sensor
  const label = tapToLoad ? `โหลดภาพกล้อง ${site.name} (~50 KB)` : `เปิดดูกล้อง ${site.name} · ${copy.badge}`

  return (
    <li className="min-w-0">
      {/* fm-cam-tile: the focus ring is drawn on the card, the button's own would be clipped. */}
      <article className="fm-cam-tile flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card-2">
        <button
          type="button"
          className="block w-full text-left"
          aria-label={label}
          onClick={() => {
            if (tapToLoad) {
              onTap()
              frame.reload()
            } else onOpen()
          }}
        >
          <CameraFrame
            camera={cam}
            frame={frame}
            copy={copy}
            size="tile"
            nowMs={nowMs}
            overlay={
              site.cameras.length > 1 ? (
                <span aria-hidden="true" className="absolute top-1.5 left-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[0.7rem] text-white">
                  {anglesTh(site.cameras.length)}
                </span>
              ) : null
            }
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
          <h3 className="truncate text-[0.9rem] leading-snug font-medium" title={site.name}>
            {site.name}
          </h3>
          <p className="text-[0.72rem] text-muted">
            {siteDistanceTh(site)}
            {site.cameras.length > 1 ? <span className="sr-only"> · {anglesTh(site.cameras.length)}</span> : null}
          </p>
          {sensor && (
            <p className="flex items-start gap-1 text-[0.72rem] leading-snug text-text-2" title={sensor.name}>
              <span className="mt-[3px]">
                <LevelDot level={sensorLevel(sensor)} size={10} decorative />
              </span>
              <span className="min-w-0">{sensorLineTh(sensor)}</span>
            </p>
          )}
          {notice && <p className="text-[0.72rem] leading-snug text-text-2">{notice}</p>}
          <p className="mt-auto pt-0.5 text-[0.68rem] leading-snug text-muted">{creditTh(site.owner)}</p>
          <p className="sr-only" aria-live="polite">
            {copy.live ? `${site.name}: ${copy.live}` : ''}
          </p>
        </div>
      </article>
    </li>
  )
}
