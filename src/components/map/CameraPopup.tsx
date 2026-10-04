import { distanceTh } from '@/lib/engine/format'
import { CCTV_LINK_ONLY_TH, anglesTh, creditTh, sensorLevel, sensorLineTh, siteSensor, type CameraSite, type SensorInfo } from '@/lib/ui/cctv'
import { OfficialLink } from '../cctv/CameraFrame'
import { LevelDot } from '../LevelBadge'

/**
 * Footer of a camera popup: what a still is and how often it changes (DWR stations upload about
 * every 15 min; BMA stills are fetched on demand), then the credit. No still promise when the
 * site is link-only on this server.
 */
export function popupFootTh(site: Pick<CameraSite, 'cameras' | 'owner'>, image: boolean): string {
  if (!image) return creditTh(site.owner)
  const cadence = site.cameras.find((c) => c.media === 'image' && c.cadenceMin)?.cadenceMin
  return ['ภาพนิ่ง ไม่ใช่วิดีโอ', cadence ? `หน่วยงานถ่ายภาพราวทุก ${cadence} นาที` : '', creditTh(site.owner)].filter(Boolean).join(' · ')
}

/**
 * Map popup of one camera site. No still is requested here: "ดูภาพ" opens the viewer.
 * Leaflet styles <p> inside popups, so this uses <div>s (see globals.css).
 */
export function CameraPopup({
  site,
  sensors,
  homeKm,
  onOpen,
}: {
  site: CameraSite
  sensors: ReadonlyMap<string, SensorInfo>
  homeKm?: number | null
  onOpen: () => void
}) {
  const image = site.cameras.some((c) => c.media === 'image' && c.imageUrl)
  const sensor = siteSensor(site, sensors)
  return (
    <div className="min-w-[220px] max-w-[280px]">
      <div className="font-medium text-text">{site.name}</div>
      <div className="text-xs text-muted">
        กล้อง CCTV · {anglesTh(site.cameras.length)}
        {typeof homeKm === 'number' ? ` · ห่างจากบ้าน ${distanceTh(homeKm)}` : ''}
      </div>
      {sensor && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[0.8rem] text-text-2">
          <span className="mt-[4px]">
            <LevelDot level={sensorLevel(sensor)} size={10} decorative />
          </span>
          <span>{sensorLineTh(sensor)}</span>
        </div>
      )}
      {!image && <div className="mt-1.5 text-[0.8rem] text-text-2">{CCTV_LINK_ONLY_TH}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {image && (
          <button type="button" className="fm-btn fm-btn-primary" onClick={onOpen}>
            ดูภาพ
          </button>
        )}
        <OfficialLink camera={site.cameras[0]!} className="fm-btn fm-btn-quiet" />
      </div>
      <div className="mt-1.5 text-[0.7rem] text-muted">{popupFootTh(site, image)}</div>
    </div>
  )
}
