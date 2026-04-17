import { useState, useEffect, useCallback } from 'react'

type Theme = 'light' | 'dark' | 'system'

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('nx-landing-theme') as Theme | null
    return stored ?? 'system'
  })

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem('nx-landing-theme', t)
    setThemeState(t)
    applyTheme(t)
  }, [])

  const toggle = useCallback(() => {
    const resolved = theme === 'system' ? getSystemTheme() : theme
    setTheme(resolved === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const resolved = theme === 'system' ? getSystemTheme() : theme

  return { theme, resolved, setTheme, toggle }
}
