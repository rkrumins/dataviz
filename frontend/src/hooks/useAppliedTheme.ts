import { useEffect, useState } from 'react'
import { usePreferencesStore, type ThemeMode } from '@/store/preferences'

function resolveIsDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Applies the persisted theme preference to `<html class="dark">` and
 * returns the currently-applied value. Each class flip is wrapped in
 * `.theme-transitioning` so the global `* { transition: color… }` rule
 * (globals.css) does NOT cascade-animate every element in the DOM on a
 * light/dark switch — that mass transition is a visible jank spike.
 * Double-rAF: a single rAF fires before the browser flushes the new styles,
 * so the guard would stick; waiting two frames guarantees the new colours
 * have painted before transitions resume.
 *
 * Any route that renders outside `AppLayout` (which mounts this via its own
 * effect) must call this hook directly, or theme changes will silently have
 * no visual effect on that route.
 */
export function useAppliedTheme(): boolean {
  const theme = usePreferencesStore((s) => s.theme)
  const [isDark, setIsDark] = useState(() => resolveIsDark(theme))

  useEffect(() => {
    const root = document.documentElement
    const applyDark = (dark: boolean) => {
      root.classList.add('theme-transitioning')
      root.classList.toggle('dark', dark)
      setIsDark(dark)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => root.classList.remove('theme-transitioning'))
      )
    }
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(mediaQuery.matches)
      const handler = (e: MediaQueryListEvent) => applyDark(e.matches)
      mediaQuery.addEventListener('change', handler)
      return () => mediaQuery.removeEventListener('change', handler)
    } else {
      applyDark(theme === 'dark')
    }
  }, [theme])

  return isDark
}
