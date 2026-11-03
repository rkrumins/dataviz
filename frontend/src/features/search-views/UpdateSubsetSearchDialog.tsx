/**
 * UpdateSubsetSearchDialog — change a subset view's search, seeing first what the
 * change does to each of its layers: "+120 −35". The search just run (where the
 * subset's matches are looked for) replaces the one the view keeps, against the
 * hash it was read at, with Undo.
 */
import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as LucideIcons from 'lucide-react'

import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'
import type { SearchViewStatus } from '@/types/searchView'

import { describePredicate, layerCondition } from './model'
import { useLayerCounts } from './useLayerCounts'

export interface UpdateSubsetSearchDialogProps {
  subsetName: string
  status: SearchViewStatus
  /** The search just run. */
  predicate: Predicate
  /** Where the counts are read: the subset's base, or (a whole-data-source subset) the view itself. */
  countIn: string
  onCancel: () => void
  onUpdate: () => Promise<void>
}

const number = new Intl.NumberFormat()

function and(...parts: Array<Record<string, unknown> | null>): Predicate {
  const kept = parts.filter((p): p is Record<string, unknown> => !!p && p.kind !== 'all')
  return (kept.length === 1 ? kept[0] : { kind: 'group', op: 'and', children: kept }) as unknown as Predicate
}
const not = (p: unknown) => ({ kind: 'group', op: 'not', children: [p] })

export function UpdateSubsetSearchDialog({ subsetName, status, predicate, countIn, onCancel, onUpdate }: UpdateSubsetSearchDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const was = status.definition.predicate
  const wholeDataSource = status.definition.within === 'dataSource'

  // Per layer: what it holds now, what the new search adds (it matches, the old
  // didn't) and what it takes away.
  const rules = useMemo(() => status.layers.flatMap((layer) => {
    const condition = layerCondition(layer)
    if (condition === null) return []
    return [
      { id: `${layer.id}::now`, predicate: and(condition, was as unknown as Record<string, unknown>) },
      { id: `${layer.id}::added`, predicate: and(condition, predicate as unknown as Record<string, unknown>, not(was)) },
      { id: `${layer.id}::removed`, predicate: and(condition, was as unknown as Record<string, unknown>, not(predicate)) },
    ]
  }), [status.layers, predicate, was])
  const counts = useLayerCounts(countIn, rules, wholeDataSource)
  const read = (id: string) => (counts.status === 'counting' || counts.status === 'done') ? counts.counts.get(id) : undefined

  const update = async () => {
    setBusy(true)
    setError(null)
    try {
      await onUpdate()
    } catch (err) {
      setError(narrowErrorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-2xl shadow-black/25"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void update() } }}
        >
          <Dialog.Title className="text-lg font-display font-semibold text-ink">Update “{subsetName}”</Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] text-ink-muted leading-snug">
            It will show the matches of <span className="text-ink">{describePredicate(predicate)}</span> instead of{' '}
            <span className="text-ink">{describePredicate(was)}</span>.
          </Dialog.Description>

          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70">What changes in each layer</p>
          <ul className="mt-2 rounded-xl border border-glass-border/70 divide-y divide-glass-border/50">
            {status.layers.map((layer) => {
              const now = read(`${layer.id}::now`)
              const added = read(`${layer.id}::added`)
              const removed = read(`${layer.id}::removed`)
              const held = layerCondition(layer) !== null
              const floor = !!(now && !now.complete) || !!(added && !added.complete) || !!(removed && !removed.complete)
              return (
                <li key={layer.id} className={cn('flex items-center justify-between gap-3 px-3.5 py-2', !held && 'opacity-50')}>
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full flex-none" style={{ background: layer.color ?? '#94a3b8' }} aria-hidden />
                    <span className="truncate text-[12.5px] text-ink">{layer.name}</span>
                  </span>
                  <span className="flex-none flex items-center gap-2.5 text-[12px] tabular-nums">
                    {!held ? <span className="text-ink-muted">holds nothing</span>
                      : added === undefined || removed === undefined ? <span className="text-ink-muted">…</span>
                        : (
                          <>
                            {now && (
                              <span className="text-ink-muted" title={floor ? 'Counted so far' : undefined}>
                                {number.format(now.count)}
                                <span className="mx-1 text-ink-muted/60">→</span>
                                <span className="font-semibold text-ink">{number.format(Math.max(0, now.count + added.count - removed.count))}{floor ? '+' : ''}</span>
                              </span>
                            )}
                            {added.count === 0 && removed.count === 0
                              ? <span className="text-ink-muted">no change</span>
                              : (
                                <span className="flex items-center gap-1">
                                  <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold">+{number.format(added.count)}{added.complete ? '' : '+'}</span>
                                  <span className="px-1.5 py-0.5 rounded-md bg-red-500/10 text-red-700 dark:text-red-400 font-semibold">−{number.format(removed.count)}{removed.complete ? '' : '+'}</span>
                                </span>
                              )}
                          </>
                        )}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-[12px] text-ink-muted">Recorded as a version of the view. You can undo it.</p>

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={onCancel} disabled={busy}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
              Cancel
            </button>
            <button type="button" onClick={() => { void update() }} disabled={busy}
              className="h-9 px-4 rounded-xl inline-flex items-center gap-2 text-[13px] font-semibold bg-accent-lineage text-white shadow-sm hover:brightness-110 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated">
              {busy ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" /> : <LucideIcons.Check className="w-4 h-4" />}
              Update the view
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
