'use client'

import type { ReactNode } from 'react'
import type { CameraLinkOut, PublicCamera } from '@/lib/ui/api'
import { cameraAltTh, officialLink, type FrameCopy } from '@/lib/ui/cctv'
import { IconRefresh } from '../icons'
import { IconCamera } from './CameraGlyph'
import { CameraStatusBadge } from './CameraStatusBadge'
import type { FrameState } from './hooks'

/**
 * A still in a fixed 4:3 box. `object-fit: scale-down` shows native pixels at most (never
 * enlarged); a not-current still is dimmed. Tiles get the time/state badge over the picture;
 * without a still: the camera pictogram and, in the viewer, the state text.
 */
export function CameraFrame({
  camera,
  frame,
  copy,
  size,
  overlay,
}: {
  camera: PublicCamera
  frame: Pick<FrameState, 'src' | 'meta' | 'loading'>
  copy: FrameCopy
  size: 'tile' | 'viewer'
  /** Extra overlay (angle count badge). */
  overlay?: ReactNode
}) {
  const hasStill = !!frame.src && !!frame.meta
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#101010]">
      {hasStill ? (
        // eslint-disable-next-line @next/next/no-img-element -- object URL of a same-origin still
        <img
          src={frame.src!}
          alt={cameraAltTh(camera, frame.meta!)}
          decoding="async"
          referrerPolicy="no-referrer"
          className={`h-full w-full object-scale-down transition-opacity duration-300 ${copy.dim ? 'opacity-45 grayscale' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center text-white/80">
          {frame.loading ? <IconRefresh size={size === 'tile' ? 22 : 30} className="fm-spin opacity-80" /> : <IconCamera size={size === 'tile' ? 26 : 40} className="opacity-70" />}
          {size === 'viewer' && copy.notices[0] && <p className="max-w-[28rem] text-sm leading-relaxed">{copy.notices[copy.notices.length - 1]}</p>}
        </div>
      )}
      {overlay}
      {/* The viewer prints the same facts under the picture instead of covering it. */}
      {size === 'tile' && <CameraStatusBadge text={copy.badge} warn={copy.warn} className="absolute bottom-1.5 left-1.5" />}
    </div>
  )
}

/** "เปิดเว็บทางการ": a new tab without referrer (the page URL may hold the home coordinates). */
export function OfficialLink({ camera, className = '' }: { camera: Pick<PublicCamera, 'officialUrl' | 'owner'>; className?: string }) {
  const link = officialLink(camera.officialUrl)
  if (!link) return null
  if (!link.external) {
    return (
      <a href={`${link.href}#cctv`} className={className}>
        อ่านเกี่ยวกับภาพจำลอง
      </a>
    )
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={className} title={`เปิดเว็บของ${camera.owner}ในแท็บใหม่`}>
      เปิดเว็บทางการ
    </a>
  )
}

/** Disclosure "กล้องจากหน่วยงานอื่น": agency camera pages this server only links to. */
export function CameraLinks({ links, title = 'กล้องจากหน่วยงานอื่น' }: { links: CameraLinkOut[]; title?: string }) {
  const safe = links.map((l) => ({ ...l, link: officialLink(l.url) })).filter((l) => l.link?.external)
  if (safe.length === 0) return null
  return (
    <details className="rounded-xl border border-border bg-card-2 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-text">{title}</summary>
      <p className="mt-1 text-xs text-muted">เปิดดูที่เว็บของหน่วยงานโดยตรง ระบบนี้ไม่ได้ดึงภาพจากแหล่งเหล่านี้</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {safe.map((l) => (
          <li key={l.id}>
            <a
              href={l.link!.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="text-accent-text underline underline-offset-2"
            >
              {l.title}
            </a>
            <span className="text-text-2"> · {l.owner}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
