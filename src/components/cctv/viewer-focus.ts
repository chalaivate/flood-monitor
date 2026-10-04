// Keyboard focus inside the open camera viewer (a modal <dialog>). Kept free of React so the
// rule is unit-tested with a stand-in dialog (tests/ui-cctv-fixes.test.ts).

export interface FocusableLike {
  focus: (opts?: FocusOptions) => void
}

export interface ViewerDialogLike {
  open: boolean
  contains(node: Node | null): boolean
  querySelector(selector: string): FocusableLike | null
}

/** The viewer heading (tabIndex -1): where focus goes when the focused control went away. */
export const VIEWER_TITLE_SELECTOR = '#cam-viewer-title'

/**
 * When the open viewer no longer holds keyboard focus (the focused control was removed or
 * disabled, e.g. the chain chip replaced the request, "ลองใหม่" turned into loading text), move
 * focus to its heading so keyboard and screen-reader users keep their place. Returns whether
 * focus was moved.
 */
export function keepViewerFocus(dialog: ViewerDialogLike, active: Element | null): boolean {
  if (!dialog.open || (active !== null && dialog.contains(active))) return false
  const title = dialog.querySelector(VIEWER_TITLE_SELECTOR)
  if (!title) return false
  title.focus({ preventScroll: true })
  return true
}
