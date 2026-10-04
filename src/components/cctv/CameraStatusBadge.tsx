import { IconAlert } from '../icons'

/**
 * Time / state badge laid over a still ("ภาพนิ่ง · 10:42 น.", "ภาพเก่า · 10:30 น."). Fixed light
 * text on a dark scrim, so it reads on any picture in both themes. The same facts are in the alt
 * text and the notices, so it is hidden from assistive tech.
 */
export function CameraStatusBadge({ text, warn = false, className = '' }: { text: string; warn?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none inline-flex max-w-[calc(100%-12px)] items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[0.7rem] leading-snug text-white ${className}`}
    >
      {warn && <IconAlert size={12} className="shrink-0 text-[#fab219]" />}
      <span className="truncate">{text}</span>
    </span>
  )
}
