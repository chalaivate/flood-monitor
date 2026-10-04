import type { SVGProps } from 'react'

// Camera pictogram (24×24, currentColor) and the map marker built from it. Cameras have no
// status, so the marker is neutral and shaped unlike the level marks (●▲◆■○).

const BODY = 'M3.5 7.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z'
const LENS = 'm15.5 11 5-3v8l-5-3'

export function IconCamera({ size = 20, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest['aria-label'] ? undefined : true}
      {...rest}
    >
      <path d={BODY} />
      <path d={LENS} />
    </svg>
  )
}

/** Marker markup for Leaflet divIcons: a neutral rounded badge with the camera pictogram. */
export function cameraMarkerSvg(size = 24): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">` +
    `<rect x="0.75" y="0.75" width="22.5" height="22.5" rx="6" fill="var(--card)" stroke="var(--text-2)" stroke-width="1.5"/>` +
    `<g transform="translate(3.6 3.6) scale(0.7)" fill="none" stroke="var(--text)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${BODY}"/><path d="${LENS}"/></g></svg>`
  )
}
