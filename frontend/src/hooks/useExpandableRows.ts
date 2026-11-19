/**
 * useExpandableRows — the browsing model every change list shares: each row a summary that opens
 * to its key differences (level 1), then to all of them (level 2); one current row, moved by the
 * keyboard, and expand / collapse everything shown in one step (O(1): a base level plus the rows set
 * otherwise).
 *
 * Keys, on the list (ignored while typing in a field, or with ⌘/Ctrl/Alt held):
 *   J / ↓ next · K / ↑ previous · Home / End · PgDn / PgUp (10 rows)
 *   → open one level · ← close one level · Shift+→ open every row · Shift+← close every row
 * Enter and Space are the row's own button (it toggles). `extraKeys` adds a surface's own.
 *
 * Scrolling the current row into view and focusing it is the caller's (`onNavigate`): a
 * virtualized list knows where a row is, this does not.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

export type RowLevel = 0 | 1 | 2

const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
  || (t instanceof HTMLElement && t.isContentEditable)

export interface ExpandableRows<K> {
  current: K | null
  setCurrent: (key: K) => void
  levelOf: (key: K) => RowLevel
  setLevel: (key: K, level: RowLevel) => void
  /** Closed ↔ open (level 0 ↔ 1). */
  toggle: (key: K) => void
  expandAll: () => void
  collapseAll: () => void
  /** Whether every row shown is open (what an "Expand all" control says next). */
  allOpen: boolean
  onKeyDown: (e: KeyboardEvent) => void
}

export function useExpandableRows<K extends string>(keys: readonly K[], opts: {
  /** Bring a row into view and focus it (after a keyboard move). */
  onNavigate?: (key: K, index: number) => void
  /** A surface's own keys, given the current row: return true when handled. */
  extraKeys?: (e: KeyboardEvent, current: K | null) => boolean
  /** The level every row opens at (a single change: open). */
  initialLevel?: RowLevel
  /** A row open from the start (the one chosen elsewhere — on a map). */
  initiallyOpen?: K | null
  /** The current row, when the caller holds it (shared with another view); else held here. */
  current?: K | null
  onCurrentChange?: (key: K) => void
} = {}): ExpandableRows<K> {
  const [base, setBase] = useState<RowLevel>(opts.initialLevel ?? 0)
  const [overrides, setOverrides] = useState<ReadonlyMap<K, RowLevel>>(
    () => new Map(opts.initiallyOpen ? [[opts.initiallyOpen, 1 as RowLevel]] : []))
  const [own, setOwn] = useState<K | null>(null)
  const controlled = opts.current !== undefined
  const current = controlled ? (opts.current ?? null) : own
  const onCurrentChange = opts.onCurrentChange
  const setCurrentState = useCallback((k: K) => {
    if (controlled) onCurrentChange?.(k)
    else setOwn(k)
  }, [controlled, onCurrentChange])
  const optsRef = useRef(opts)
  useLayoutEffect(() => { optsRef.current = opts })

  const index = useMemo(() => {
    const m = new Map<K, number>()
    keys.forEach((k, i) => m.set(k, i))
    return m
  }, [keys])
  // The current row while it is still listed; else the first.
  const live = current !== null && index.has(current) ? current : (keys[0] ?? null)

  const levelOf = useCallback((k: K): RowLevel => overrides.get(k) ?? base, [overrides, base])
  const setLevel = useCallback((k: K, level: RowLevel) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(k, level)
      return next
    })
  }, [])
  const toggle = useCallback((k: K) => setLevel(k, levelOf(k) === 0 ? 1 : 0), [levelOf, setLevel])
  const expandAll = useCallback(() => { setBase(1); setOverrides(new Map()) }, [])
  const collapseAll = useCallback(() => { setBase(0); setOverrides(new Map()) }, [])

  const go = useCallback((i: number) => {
    if (keys.length === 0) return
    const at = Math.max(0, Math.min(keys.length - 1, i))
    const k = keys[at]
    setCurrentState(k)
    optsRef.current.onNavigate?.(k, at)
  }, [keys, setCurrentState])

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return
    if (optsRef.current.extraKeys?.(e, live)) { e.preventDefault(); return }
    const at = live !== null ? (index.get(live) ?? 0) : 0
    let handled = true
    switch (e.key) {
      case 'j': case 'ArrowDown': go(at + 1); break
      case 'k': case 'ArrowUp': go(at - 1); break
      case 'Home': go(0); break
      case 'End': go(keys.length - 1); break
      case 'PageDown': go(at + 10); break
      case 'PageUp': go(at - 10); break
      case 'ArrowRight':
        if (e.shiftKey) expandAll()
        else if (live !== null) setLevel(live, Math.min(2, levelOf(live) + 1) as RowLevel)
        break
      case 'ArrowLeft':
        if (e.shiftKey) collapseAll()
        else if (live !== null) setLevel(live, Math.max(0, levelOf(live) - 1) as RowLevel)
        break
      default: handled = false
    }
    if (handled) e.preventDefault()
  }, [live, index, keys.length, go, expandAll, collapseAll, setLevel, levelOf])

  const allOpen = base >= 1 && [...overrides.values()].every((l) => l >= 1)

  return {
    current: live, setCurrent: setCurrentState, levelOf, setLevel, toggle, expandAll, collapseAll, allOpen, onKeyDown,
  }
}
