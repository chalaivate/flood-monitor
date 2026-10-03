import type { RadarImage } from './types'

// Radar / nowcast imagery shown on the dashboard. BMA still images are plain-HTTP and served
// only to Thai IPs, so they go through our proxy (/api/radar/bma/[site]); the UI hides any
// image that fails to load. RainViewer tiles (animated, global) are loaded client-side.

export const BMA_RADAR_SOURCES = {
  nongchok: 'http://weather.bangkok.go.th/FTPCustomer/radar/pics/radarh.jpg',
  nongkhaem: 'http://weather.bangkok.go.th/FTPCustomer/radar/pics/nkradarh.jpg',
} as const

export type BmaRadarSite = keyof typeof BMA_RADAR_SOURCES

export function isBmaRadarSite(v: string): v is BmaRadarSite {
  return Object.prototype.hasOwnProperty.call(BMA_RADAR_SOURCES, v)
}

/** Radar images for the dashboard, nearest-relevant first. */
export function radarImages(): RadarImage[] {
  return [
    {
      id: 'bma-nongchok',
      title: 'เรดาร์ฝน กทม. (หนองจอก)',
      url: '/api/radar/bma/nongchok',
      source: 'สำนักการระบายน้ำ กทม.',
      refreshMinutes: 5,
    },
    {
      id: 'bma-nongkhaem',
      title: 'เรดาร์ฝน กทม. (หนองแขม)',
      url: '/api/radar/bma/nongkhaem',
      source: 'สำนักการระบายน้ำ กทม.',
      refreshMinutes: 5,
    },
    {
      id: 'bma-nowcast',
      title: 'คาดการณ์ฝน 3 ชม. ข้างหน้า (กทม.)',
      url: 'https://dds.bangkok.go.th/Line_data/picture/radar_rain.gif',
      source: 'สำนักการระบายน้ำ กทม. / Weathernews',
      refreshMinutes: 10,
    },
  ]
}
