import type { Metadata, Viewport } from 'next'
import '@fontsource/ibm-plex-sans-thai/400.css'
import '@fontsource/ibm-plex-sans-thai/500.css'
import '@fontsource/ibm-plex-sans-thai/600.css'
import './globals.css'
import { InlineScript } from '@/components/InlineScript'

export const metadata: Metadata = {
  title: { default: 'เฝ้าระวังน้ำท่วม', template: '%s · เฝ้าระวังน้ำท่วม' },
  description:
    'ติดตามระดับน้ำคลอง ระยะห่างตลิ่ง ฝนสะสม และเรดาร์ฝนรอบตำแหน่งของคุณ พร้อมแจ้งเตือนเมื่อสถานการณ์เปลี่ยน ข้อมูลจากสำนักการระบายน้ำ กทม. และ สสน.',
  applicationName: 'Flood Monitor',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon-192.png' },
  appleWebApp: { capable: true, title: 'น้ำท่วม', statusBarStyle: 'black-translucent' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#111111' },
    { media: '(prefers-color-scheme: light)', color: '#f2f2f0' },
  ],
}

// Apply the saved theme before first paint to avoid a light/dark flash.
const THEME_SCRIPT = `try{var t=localStorage.getItem('fm-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
