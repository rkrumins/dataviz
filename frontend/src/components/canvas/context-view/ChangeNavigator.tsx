/**
 * ChangeNavigator — steps through changed entities on the canvas, one at a time: "Change 12 of
 * 10,482 · Customer Orders · Edited", ‹ ›, and which changes — Unsaved (staged), Saved (on the
 * draft) or All. Each step reveals the entity (loading the way to it) and opens its details; one
 * this view does not hold says so, with Skip. J / K (or [ / ]) step while it is open, Esc closes.
 *
 * Saved changes are read from the server a page at a time, with their names, however many the
 * draft has; past what a change list lists, it says so rather than stepping.
 *
 * Rendered by the canvas, which hands it the reveal; started from anywhere through
 * `useChangeNavigatorStore`.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, EyeOff, Navigation, RefreshCw, SkipForward, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import {
  arraySource, changeListSource, concatSources, stopsFromGroups, useChangeNavigatorStore,
  type NavScope, type NavSource,
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

/** The stops of a scope: what is staged (in hand), what the draft has saved (read a page at a time). */
function sourceOf(scope: NavScope): NavSource | null {
  const unsaved = arraySource(stopsFromGroups(buildReviewIndex(useStagedChangesStore.getState().changes, canvasLookup()).groups))
  if (scope === 'unsaved') return unsaved
  const { workspaceId, graphId, currentBranchId } = useBranchStore.getState()
  if (!workspaceId || !graphId || !currentBranchId) return null
  const saved = changeListSource(workspaceId, graphId, { branchId: currentBranchId })
  return scope === 'saved' ? saved : concatSources(unsaved, saved)
}

export function ChangeNavigator({ reveal }: { reveal: (id: string) => Promise<RevealOutcome | void> }) {
  const active = useChangeNavigatorStore((s) => s.active)
  const source = useChangeNavigatorStore((s) => s.source)
  const index = useChangeNavigatorStore((s) => s.index)
  const scope = useChangeNavigatorStore((s) => s.scope)
  const narrowed = useChangeNavigatorStore((s) => s.narrowed)
  useChangeNavigatorStore((s) => s.version)   // a page arrived: draw what it holds
  const stagedCount = useStagedChangesStore((s) => s.changes.length)
  const savedCount = useBranchStore((s) => {
    const c = s.activeChangeSet?.counts
    return c ? c.added + c.modified + c.removed : 0
  })
  /** What the last reveal found, for the stop it was made for. */
  const [outcome, setOutcome] = useState<{ id: string; result: RevealOutcome } | null>(null)

  useEffect(() => {
    const nav = useChangeNavigatorStore.getState()
    nav.setCanReveal(true)
    return () => { nav.setCanReveal(false); nav.close() }
  }, [])

  const stop = active ? source?.at(index) : undefined
  const stopId = stop?.id
  useEffect(() => {
    if (!stopId) return
    let gone = false
    useCanvasStore.getState().openNodeDrawer(stopId)
    void reveal(stopId).then((r) => { if (!gone) setOutcome({ id: stopId, result: r ?? 'revealed' }) })
    return () => { gone = true }
  }, [stopId, reveal])

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

  if (!active || !source) return null
  const nav = useChangeNavigatorStore.getState()
  const total = source.total
  const missing = !!stop && outcome?.id === stop.id && outcome.result === 'unavailable'
  const meta = stop ? STATUS_META[stop.status] : null
  const switchTo = (next: NavScope) => {
    const src = sourceOf(next)
    if (src) nav.start(src, { scope: next })
  }
  const atEnd = total >= 0 && index >= total - 1
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
          {source.tooLarge || total === 0 ? 'Changes' : (
            <>Change <span className="font-semibold text-ink">{(index + 1).toLocaleString()}</span> of {total < 0 ? '…' : total.toLocaleString()}</>
          )}
          {narrowed && ' shown'}
        </span>
        {stop && meta ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[12.5px] font-semibold text-ink truncate max-w-[220px]">{stop.name}</span>
            <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide shrink-0', meta.bg, meta.text)}>
              {STATUS_WORD[stop.status]}{stop.saved ? ' · saved' : ''}
            </span>
          </span>
        ) : source.tooLarge ? (
          <span className="text-[12px] text-ink-secondary">Too many to step through — narrow them in Changes</span>
        ) : total === 0 ? (
          <span className="text-[12px] text-ink-secondary">Nothing here to show on the canvas</span>
        ) : source.failed(index) ? (
          <span className="flex items-center gap-1.5 text-[12px] text-rose-600 dark:text-rose-300">
            Couldn’t read this change
            <button type="button" onClick={() => nav.go(index)}
              className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <RefreshCw className="w-3 h-3" aria-hidden />Try again
            </button>
          </span>
        ) : (
          <span className="block h-3.5 w-36 my-0.5 rounded bg-black/[0.07] dark:bg-white/[0.08] animate-pulse" aria-label="Reading this change" />
        )}
      </div>

      {missing && (
        <span className="flex items-center gap-1.5 pl-2 ml-0.5 border-l border-glass-border text-[11px] text-amber-700 dark:text-amber-300 whitespace-nowrap">
          <EyeOff className="w-3.5 h-3.5" aria-hidden />Not in this view
          {!atEnd && (
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
          <button type="button" className={btn} onClick={nav.next} disabled={atEnd || source.tooLarge || total === 0} aria-label="Next change">
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
