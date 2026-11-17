/**
 * ChangeNavigator — steps through changed entities on the canvas, one at a time: "Change 12 of
 * 10,482 · Customer Orders · Edited", ‹ ›, and which changes — Unsaved (staged), Saved (on the
 * draft) or All. Each step reveals the entity (loading the way to it) and opens its details; one
 * this view does not hold says so, with Skip. J / K (or [ / ]) step while it is open, Esc closes.
 *
 * Rendered by the canvas, which hands it the reveal; started from anywhere through
 * `useChangeNavigatorStore`.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, EyeOff, Navigation, SkipForward, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import {
  allStops, savedStops, stopsFromGroups, useChangeNavigatorStore, type NavScope,
} from '@/store/changeNavigatorStore'
import { buildReviewIndex } from '@/features/versioning/model/reviewIndex'
import { STATUS_META } from '@/features/versioning/components/NodeDiffBadge'
import { HoverTip } from '@/components/ui/HoverTip'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import type { RevealOutcome } from '@/hooks/useRevealNode'
import { canvasLookup } from './review/canvasLookup'

const STATUS_WORD = { added: 'Added', modified: 'Edited', removed: 'Removed' } as const

const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
  || (t instanceof HTMLElement && t.isContentEditable)

/** The stops of a scope, from what is staged and what the draft has saved now. */
function stopsOf(scope: NavScope) {
  const unsaved = scope === 'saved' ? [] : stopsFromGroups(buildReviewIndex(useStagedChangesStore.getState().changes, canvasLookup()).groups)
  const saved = scope === 'unsaved' ? [] : savedStops(useBranchStore.getState().activeChangeSet)
  return scope === 'all' ? allStops(unsaved, saved) : scope === 'saved' ? saved : unsaved
}

export function ChangeNavigator({ reveal }: { reveal: (id: string) => Promise<RevealOutcome | void> }) {
  const active = useChangeNavigatorStore((s) => s.active)
  const stops = useChangeNavigatorStore((s) => s.stops)
  const index = useChangeNavigatorStore((s) => s.index)
  const scope = useChangeNavigatorStore((s) => s.scope)
  const narrowed = useChangeNavigatorStore((s) => s.narrowed)
  const stagedCount = useStagedChangesStore((s) => s.changes.length)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const savedCount = useMemo(() => savedStops(changeSet).length, [changeSet])
  /** What the last reveal found, for the stop it was made for. */
  const [outcome, setOutcome] = useState<{ id: string; result: RevealOutcome } | null>(null)

  useEffect(() => {
    const nav = useChangeNavigatorStore.getState()
    nav.setCanReveal(true)
    return () => { nav.setCanReveal(false); nav.close() }
  }, [])

  const stop = active ? stops[index] : undefined
  useEffect(() => {
    if (!stop) return
    let gone = false
    useCanvasStore.getState().openNodeDrawer(stop.id)
    void reveal(stop.id).then((r) => { if (!gone) setOutcome({ id: stop.id, result: r ?? 'revealed' }) })
    return () => { gone = true }
  }, [stop, reveal])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return
      const nav = useChangeNavigatorStore.getState()
      if (e.key === 'j' || e.key === ']') nav.next()
      else if (e.key === 'k' || e.key === '[') nav.prev()
      else if (e.key === 'Escape') nav.close()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  if (!active || !stop) return null
  const nav = useChangeNavigatorStore.getState()
  const missing = outcome?.id === stop.id && outcome.result === 'unavailable'
  const meta = STATUS_META[stop.status]
  const switchTo = (next: NavScope) => {
    const list = stopsOf(next)
    if (list.length) nav.start(list, { scope: next, at: stop.id })
  }
  const btn = 'w-8 h-8 rounded-xl flex items-center justify-center text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-35 disabled:pointer-events-none'

  return (
    <div
      role="region"
      aria-label="Change navigator"
      data-canvas-interactive
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-2rem)] flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-2xl bg-canvas-elevated/95 backdrop-blur border border-glass-border shadow-glass-lg"
    >
      <Navigation className="w-4 h-4 text-accent-lineage shrink-0" aria-hidden />
      <div className="min-w-0 flex flex-col leading-tight">
        <span className="text-[11px] text-ink-muted tabular-nums whitespace-nowrap" aria-live="polite">
          Change <span className="font-semibold text-ink">{(index + 1).toLocaleString()}</span> of {stops.length.toLocaleString()}
          {narrowed && ' shown'}
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] font-semibold text-ink truncate max-w-[220px]">{stop.name}</span>
          <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide shrink-0', meta.bg, meta.text)}>
            {STATUS_WORD[stop.status]}{stop.saved ? ' · saved' : ''}
          </span>
        </span>
      </div>

      {missing && (
        <span className="flex items-center gap-1.5 pl-2 ml-0.5 border-l border-glass-border text-[11px] text-amber-700 dark:text-amber-300 whitespace-nowrap">
          <EyeOff className="w-3.5 h-3.5" aria-hidden />Not in this view
          {index < stops.length - 1 && (
            <button type="button" onClick={nav.next}
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <SkipForward className="w-3 h-3" aria-hidden />Skip
            </button>
          )}
        </span>
      )}

      <div className="flex items-center gap-0.5 pl-1 ml-0.5 border-l border-glass-border">
        <HoverTip label="Previous change" shortcut="k" className="inline-flex">
          <button type="button" className={btn} onClick={nav.prev} disabled={index === 0} aria-label="Previous change">
            <ChevronLeft className="w-4 h-4" />
          </button>
        </HoverTip>
        <HoverTip label="Next change" shortcut="j" className="inline-flex">
          <button type="button" className={btn} onClick={nav.next} disabled={index >= stops.length - 1} aria-label="Next change">
            <ChevronRight className="w-4 h-4" />
          </button>
        </HoverTip>
      </div>

      {(stagedCount > 0 && savedCount > 0) && (
        <Segmented
          label="Which changes"
          value={scope}
          onChange={switchTo}
          options={[
            { value: 'unsaved', label: 'Unsaved' },
            { value: 'saved', label: 'Saved' },
            { value: 'all', label: 'All' },
          ]}
        />
      )}

      <span className="hidden xl:flex items-center gap-1 text-[10.5px] text-ink-muted px-1"><Kbd shortcut="esc" /></span>
      <button type="button" onClick={nav.close} aria-label="Stop stepping through changes"
        className="w-8 h-8 rounded-xl flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
