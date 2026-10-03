import type { Metadata } from 'next'
import { AlertsSetup } from '@/components/alerts/AlertsSetup'

export const metadata: Metadata = {
  title: 'ตั้งค่าการแจ้งเตือน',
  description: 'ตั้งค่าการแจ้งเตือนน้ำท่วมผ่านเว็บพุช LINE Telegram ntfy อีเมล หรือ Discord',
}

export default function AlertsPage() {
  return <AlertsSetup />
}
