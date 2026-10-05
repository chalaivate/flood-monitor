import type { Camera, CameraCatalogResult, CameraRef } from '../../types'
import type { CameraCatalogAdapter } from './types'
import { siteIdFor } from './common'

// Water-level cameras of the Drainage and Sewerage Department (สำนักการระบายน้ำ กทม.), published
// on dds.bangkok.go.th/cctv.php ("กล้อง CCTV ดูระดับน้ำ เฝ้าระวังน้ำท่วม"). That page has no
// machine-readable list and only answers Thai IPs, so the catalogue is the table below: no
// network, every host builds it itself (never relayed). Each row's still is a fixed path on the
// same host (Thai IP only; fetched by src/lib/server/cctv-proxy.ts).
//
// Evidence:
// - The page's own Leaflet markers, as captured on 2026-09-28 by a third-party project
//   (SirawichDev/water-now, server/providers/cctv/dds-markers.json): `L.marker([lat, lon])
//   .bindPopup('CCTV <label> … <img src="<path>">')`. They give each camera's label and image
//   path (camera 3's is in another directory). Their pins are wrong for cameras 1, 4, 5 and 6
//   (geocodes of district names; 4 and 6 fall outside Bangkok), so each camera is placed at the
//   BMA station whose name matches instead; the DDS pin is kept in the row's comment.
// - 2026-10-06, a Thai IP got image/jpeg for cctv-image/cctv1 and cctv2 (the others untested).
// - Same third party, 2026-09-28 (unverified by us): cctv.php had begun serving the site's home
//   page instead of the camera map, the image URLs still answered, and the newest still was
//   from 28 Aug (Last-Modified). The proxy passes Last-Modified on as the capture time, so the
//   UI dims a still older than a day and shows its date.
// Positions stay provisional (confidence on each row) until confirmed on site or by DDS itself;
// the page's own pins cannot confirm them (wrong for 4 of 6), though `npm run cctv:probe` still
// prints them to show whether the page changed. To correct a row, edit DDS_CAMERAS: a stored list is replaced within
// refreshHours (a static list is never refused as "shrunk").

export const DDS_ORIGIN = 'https://dds.bangkok.go.th'
export const DDS_CCTV_PAGE = `${DDS_ORIGIN}/cctv.php`
export const DDS_OWNER = 'สำนักการระบายน้ำ กทม.'
/** Thai name of the source in lists of camera sources. */
export const DDS_CAM_TITLE = 'กล้องระดับน้ำ สำนักการระบายน้ำ'

export interface DdsCameraRow {
  /** Camera number on DDS's page: the nativeId and the image reference. */
  n: number
  /** Thai place name, without "กล้องระดับน้ำ". */
  place: string
  lat: number
  lng: number
  /** BMA stations the camera watches (`<kind>:<code>`), kept by the station join at any distance. */
  nearStationIds: readonly string[]
  /**
   * Path of the still on DDS_ORIGIN, as DDS's own page links it. A fixed string in code: the
   * image URL is never built from a request or a stored value.
   */
  imagePath: string
}

/** The published cameras (provisional positions: evidence and confidence on each row). */
export const DDS_CAMERAS: readonly DdsCameraRow[] = [
  // DDS label "CCTV บางเขนใหม่", DDS pin 13.87120,100.60095 (a geocode of a name, 11 km away).
  // Placed at ส.คลองบางเขนใหม่ (WL.BKA.01, บางซื่อ), the only BMA station of that name.
  // Confidence: medium.
  { n: 1, place: 'บางเขนใหม่', lat: 13.81722, lng: 100.51066, nearStationIds: ['canal:WL.BKA.01'], imagePath: '/cctv-image/cctv1.jpg' },
  // DDS label "CCTV สะพานพระปิ่นเกล้า", DDS pin 13.76381,100.48802 (Thonburi approach of the
  // bridge, on the Chao Phraya): kept, no BMA station there. Confidence: medium.
  { n: 2, place: 'สะพานพระปิ่นเกล้า', lat: 13.76381, lng: 100.48802, nearStationIds: [], imagePath: '/cctv-image/cctv2.jpg' },
  // DDS label "CCTV บางนา", DDS pin 13.66605,100.58141 (1.2 km away). Placed at ส.บางนา
  // (WL.BNA.01), the pump station DDS uses as a Chao Phraya reference gauge. Its still is in
  // /cctv/, not /cctv-image/ (DDS's own popup). Confidence: medium.
  { n: 3, place: 'บางนา', lat: 13.67482, lng: 100.58775, nearStationIds: ['canal:WL.BNA.01'], imagePath: '/cctv/cctv3.jpg' },
  // DDS label "CCTV คลองสวนแดน1", DDS pin 13.85042,100.21440 (a geocode of a name, outside
  // Bangkok, 28 km away). Placed at ค.สวนแดน ถ.ชัยพฤกษ์ (WL.SDN.01, ตลิ่งชัน); ค.มหาสวัสดิ์-สวนแดน 2
  // (WL.MSW.01) is the other candidate. Confidence: low.
  { n: 4, place: 'คลองสวนแดน 1', lat: 13.79063, lng: 100.46199, nearStationIds: ['canal:WL.SDN.01'], imagePath: '/cctv-image/cctv4.jpg' },
  // DDS label "CCTV คลองชักพระ", DDS pin 13.76261,100.44194 (a geocode of a name, 3 km away).
  // Placed at ส.คลองชักพระ (WL.CPA.01, ตลิ่งชัน); WL.CPA.02 and WL.BPM.01 are other candidates.
  // Confidence: low.
  { n: 5, place: 'คลองชักพระ', lat: 13.7789, lng: 100.46431, nearStationIds: ['canal:WL.CPA.01'], imagePath: '/cctv-image/cctv5.jpg' },
  // DDS label "CCTV คลองทวีวัฒนา", DDS pin 13.74712,100.32030 (a geocode of a name, outside
  // Bangkok, 6 km away). Placed at ปตร.คลองทวีวัฒนา (WL.TWW.01); ค.ทวีวัฒนา ถ.เพชรเกษม (WL.TWW.03)
  // is the other candidate. Confidence: low.
  { n: 6, place: 'คลองทวีวัฒนา', lat: 13.80042, lng: 100.32977, nearStationIds: ['canal:WL.TWW.01'], imagePath: '/cctv-image/cctv6.jpg' },
]

/** The table row of an image reference (the camera number as a string), else undefined. */
export function ddsCameraRow(ref: string): DdsCameraRow | undefined {
  return DDS_CAMERAS.find((r) => String(r.n) === ref)
}

function ddsCamera(row: DdsCameraRow): Camera {
  const nativeId = String(row.n)
  return {
    id: `bma-ddscam:${nativeId}`,
    source: 'bma-ddscam',
    nativeId,
    siteId: siteIdFor('bma-ddscam', row.lat, row.lng),
    name: `กล้องระดับน้ำ ${row.place}`,
    code: `DDS-CCTV-${String(row.n).padStart(2, '0')}`,
    angle: null,
    owner: DDS_OWNER,
    lat: row.lat,
    lng: row.lng,
    facing: 'water',
    nearStationIds: [...row.nearStationIds],
    officialUrl: DDS_CCTV_PAGE,
    cadenceMin: null,
  }
}

/** The catalogue from the table (same cameras for any `now`). The ref is the camera number. */
export function ddsCameraCatalog(now: Date): CameraCatalogResult {
  const cameras = DDS_CAMERAS.map(ddsCamera)
  const refs: CameraRef[] = cameras.map((c) => ({ cameraId: c.id, ref: c.nativeId }))
  return { source: 'bma-ddscam', fetchedAt: now.toISOString(), cameras, refs, warnings: [] }
}

export const ddsCamSource: CameraCatalogAdapter = {
  id: 'bma-ddscam',
  label: DDS_OWNER,
  // The list is a table in this file. Images are Thai-IP only: a host that is turned away
  // switches to agency links by itself (cctv-proxy host fallback).
  thaiIpOnly: false,
  // Daily, so a release that corrects a row replaces the stored list within a day.
  refreshHours: 24,
  // A table in code: a release that drops rows is saved as is (no shrink guard).
  staticList: true,
  async fetchCatalog(ctx) {
    return ddsCameraCatalog(ctx.now)
  },
  pinnedStationIds(nativeId) {
    return ddsCameraRow(nativeId)?.nearStationIds ?? []
  },
}
