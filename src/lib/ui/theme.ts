import { useSyncExternalStore } from 'react'

// Theme = data-theme on <html> ('dark' | 'light'), persisted in localStorage 'fm-theme'.
// Without an explicit choice the OS preference applies (see globals.css).

export const THEME_KEY = 'fm-theme'
export type Theme = 'dark' | 'light'

const listeners = new Set<() => void>()

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme
  return t === 'light' || t === 'dark' ? t : systemTheme()
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
  try {
    window.localStorage.setItem(THEME_KEY, t)
  } catch {
    /* storage blocked */
  }
  for (const l of listeners) l()
}

export function useTheme(): Theme | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      const mq = window.matchMedia?.('(prefers-color-scheme: light)')
      mq?.addEventListener('change', cb)
      return () => {
        listeners.delete(cb)
        mq?.removeEventListener('change', cb)
      }
    },
    currentTheme,
    () => null,
  )
}
