import { useCallback, useState } from 'react'

/**
 * Remembers which sidebar sections a reader has collapsed, per surface, in
 * localStorage — so their preferred outline survives navigation and reloads.
 */
export function useCollapsedSections(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set<string>()
    }
  })

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]))
        } catch {
          /* private mode / quota — the preference simply won't persist */
        }
        return next
      })
    },
    [storageKey],
  )

  return { collapsed, toggle }
}

/** Scrolls the active sidebar link into view when it becomes active. */
export function scrollActiveIntoView(el: HTMLElement | null) {
  if (el) el.scrollIntoView({ block: 'nearest' })
}
