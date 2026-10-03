'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { requestRefresh, useBusy } from '@/lib/ui/bus'
import { openLocationDialog } from '@/lib/ui/dialog'
import { usePlace } from '@/lib/ui/place'
import { setTheme, useTheme } from '@/lib/ui/theme'
import { IconBell, IconHomeFlood, IconInfo, IconMapPin, IconMoon, IconRefresh, IconSun } from './icons'
import { LocationDialog } from './LocationDialog'

const TABS = [
  { href: '/', label: 'บ้าน', Icon: IconHomeFlood },
  { href: '/map', label: 'แผนที่', Icon: IconMapPin },
  { href: '/alerts', label: 'แจ้งเตือน', Icon: IconBell },
  { href: '/about', label: 'เกี่ยวกับ', Icon: IconInfo },
] as const

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' || pathname.startsWith('/dev/preview') : pathname === href || pathname.startsWith(`${href}/`)
}

/** Home Assistant-style top bar: icon tabs on the left, place chip + refresh + theme on the right. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  const { place } = usePlace()
  const busy = useBusy()
  const theme = useTheme()

  const chipLabel = !place ? 'กำลังโหลด…' : place.origin === 'default' ? 'ตั้งตำแหน่ง' : place.label
  const chipTitle = place && place.origin !== 'default' ? `${place.label} · รัศมี ${place.radiusKm} กม. — แตะเพื่อเปลี่ยน` : 'ตั้งตำแหน่งบ้านของคุณ'

  return (
    <>
      <a href="#main" className="fm-skip">
        ข้ามไปยังเนื้อหา
      </a>
      <header className="sticky top-0 z-[1100] border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
        <div className="mx-auto flex h-14 max-w-[1680px] items-stretch gap-1 px-1 sm:px-3">
          <nav aria-label="เมนูหลัก" className="flex items-stretch">
            {TABS.map(({ href, label, Icon }) => {
              const active = isActive(pathname, href)
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`fm-tab ${active ? 'fm-tab-active' : ''}`}
                  title={label}
                >
                  <Icon size={22} />
                  <span className="hidden md:inline">{label}</span>
                  <span className="sr-only md:hidden">{label}</span>
                </Link>
              )
            })}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-0.5 sm:gap-1">
            <button
              type="button"
              onClick={() => openLocationDialog()}
              className={`fm-chip min-w-0 ${place?.origin === 'default' ? 'fm-chip-accent' : ''}`}
              title={chipTitle}
              aria-label={`ตำแหน่ง: ${chipLabel} — เปลี่ยนตำแหน่ง`}
            >
              <IconMapPin size={16} className="shrink-0" />
              <span className="truncate">{chipLabel}</span>
              {place && place.origin !== 'default' && (
                <span className="hidden shrink-0 text-muted sm:inline">· {place.radiusKm} กม.</span>
              )}
            </button>
            <button type="button" className="fm-icon-btn" onClick={() => requestRefresh()} aria-label="รีเฟรชข้อมูล" title="รีเฟรชข้อมูล">
              <IconRefresh className={busy ? 'fm-spin' : ''} />
            </button>
            <button
              type="button"
              className="fm-icon-btn"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              aria-label={theme === 'light' ? 'เปลี่ยนเป็นธีมมืด' : 'เปลี่ยนเป็นธีมสว่าง'}
              title={theme === 'light' ? 'ธีมมืด' : 'ธีมสว่าง'}
            >
              {theme === 'light' ? <IconMoon /> : <IconSun />}
            </button>
          </div>
        </div>
      </header>
      <div id="main" tabIndex={-1} className="outline-none">
        {children}
      </div>
      <LocationDialog current={place} />
    </>
  )
}
