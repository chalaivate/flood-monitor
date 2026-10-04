// Keyboard access to Leaflet popups (station, camera, home and picked-point popups).
//
// Leaflet opens a marker's popup on Enter but leaves focus on the marker, and the popup pane
// comes after every marker in the DOM, so reaching "ดูภาพ" took one Tab per later marker
// (hundreds with the camera layer). Here: opening a popup moves focus to its first control;
// Escape closes it and returns focus to where it came from (the marker, or the side-list
// button that opened it); Tab past the popup's last control continues with the element after
// the marker, Shift+Tab before its first control goes back to the marker — as if the popup sat
// right after its marker in the tab order. The decision is pure (popupKeyAction) and unit-tested.

export type PopupKeyAction = 'close' | 'to-opener' | 'to-next' | null

/**
 * What a key press inside an open popup does. `index` is the focused element's position among
 * the popup's focusable elements in DOM order (content controls, then Leaflet's close button),
 * `count` their number; -1 when the popup content itself has focus (a popup without controls).
 */
export function popupKeyAction(key: string, shift: boolean, index: number, count: number): PopupKeyAction {
  if (key === 'Escape' || key === 'Esc') return 'close'
  if (key !== 'Tab') return null
  if (shift) return index <= 0 ? 'to-opener' : null
  // From the content (-1) the browser moves on to the close button by itself.
  return count === 0 || index === count - 1 ? 'to-next' : null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true')
}

/** The first tabbable element after `from` (DOM order) inside `root`, skipping `skip`'s subtree. */
export function nextTabbable(root: ParentNode, from: Node, skip: Node): HTMLElement | null {
  for (const el of focusables(root)) {
    if (skip.contains(el) || el === from || from.contains(el)) continue
    if (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el
  }
  return null
}

export interface PopupLike {
  getElement: () => HTMLElement | undefined
  /** Leaflet's (private) layer the popup is bound to; a marker has getElement(). */
  _source?: { getElement?: () => HTMLElement | undefined } | null
  once: (type: string, fn: () => void) => unknown
}

const CLOSE_LABEL_TH = 'ปิด'
/** Frames to wait for react-leaflet to render the popup's content (it renders after popupopen). */
const CONTENT_WAIT_FRAMES = 30

/**
 * Wire one opened popup: Thai label on Leaflet's close button, focus into the popup once its
 * content is rendered, Escape/Tab handling, and focus back to the opener when it closes while
 * focus was inside it. `close` closes this popup.
 */
export function managePopupFocus(popup: PopupLike, mapContainer: HTMLElement, close: () => void): void {
  const el = popup.getElement()
  if (!el || typeof document === 'undefined') return
  const source = popup._source?.getElement?.() ?? null
  const active = document.activeElement
  // Return to what had focus when the popup opened (marker, or the side-list button that flew
  // the map there); a mouse click on the map leaves the map itself focused.
  const opener = active instanceof HTMLElement && active !== document.body && !el.contains(active) ? active : source

  const closeBtn = el.querySelector<HTMLElement>('.leaflet-popup-close-button')
  if (closeBtn) {
    closeBtn.setAttribute('aria-label', CLOSE_LABEL_TH)
    closeBtn.setAttribute('title', CLOSE_LABEL_TH)
  }

  let frames = 0
  let raf = 0
  const focusIn = () => {
    const content = el.querySelector<HTMLElement>('.leaflet-popup-content')
    if (!el.isConnected) return
    if ((!content || content.childElementCount === 0) && frames++ < CONTENT_WAIT_FRAMES) {
      raf = requestAnimationFrame(focusIn)
      return
    }
    // Someone else took focus meanwhile (e.g. the user tabbed on): leave it.
    const now = document.activeElement
    if (now !== active && now !== document.body && !(now && el.contains(now))) return
    const target = (content && focusables(content)[0]) ?? content
    if (!target) return
    if (target === content && !content.hasAttribute('tabindex')) content.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  }
  raf = requestAnimationFrame(focusIn)

  const onKey = (e: KeyboardEvent) => {
    const list = focusables(el)
    const index = list.indexOf(document.activeElement as HTMLElement)
    const action = popupKeyAction(e.key, e.shiftKey, index, list.length)
    if (!action) return
    if (action === 'close') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    const target = action === 'to-opener' ? (source ?? opener) : nextTabbable(mapContainer, source ?? opener ?? el, el)
    if (!target) return
    e.preventDefault()
    target.focus({ preventScroll: true })
  }
  el.addEventListener('keydown', onKey)

  popup.once('remove', () => {
    cancelAnimationFrame(raf)
    el.removeEventListener('keydown', onKey)
    const now = document.activeElement
    // Only when focus would otherwise be lost (it was inside the closing popup).
    if (opener && opener.isConnected && (now === document.body || now === null || el.contains(now))) {
      opener.focus({ preventScroll: true })
    }
  })
}
