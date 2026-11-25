/**
 * What the scope picker (ScopePicker.tsx) and the panels it opens in share: an entity's name as the
 * view shows it, "a" or "an", and dismissing a popover. Kept apart from the component file, so
 * fast refresh can swap it.
 */
import { useCallback, useEffect, type RefObject } from 'react'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { usePersonaMode } from '@/store/persona'
import type { LineageNode } from '@/store/canvas'

/** An entity's name as the current view shows it. */
export function useScopeName() {
  const persona = usePersonaMode()
  return useCallback((node: LineageNode | undefined, fallback: string) =>
    resolveEntityName(node?.data as Parameters<typeof resolveEntityName>[0], persona, fallback), [persona])
}

/** 'a' or 'an', for "an App". */
export const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

/** Dismiss on outside-click + Escape (matches EdgeTypePickerPopover). A click in `keep` (what the
 *  popover opens from) is not outside: its own control toggles it. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, keep?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && !keep?.current?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [ref, onClose, keep])
}
