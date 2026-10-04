import type { Metadata } from 'next'
import { MapView } from '@/components/map/MapView'

export const metadata: Metadata = {
  title: 'แผนที่จุดวัด',
  description: 'แผนที่จุดวัดระดับน้ำคลอง สถานีวัดฝน และจุดวัดน้ำท่วมถนน พร้อมเรดาร์ฝน',
}

export default function MapPage() {
  return <MapView />
}
