/**
 * FirstStepsChecklist — a small progress companion for brand-new blank models.
 * Tracks REAL authoring progress (derived from the canvas + publish state, never
 * hand-ticked): add an entity → nest a child → connect two entities → publish.
 * Draft-mode only, dismissible, auto-hides once everything is done; dismissal and
 * completion persist per graph (localStorage) so it never nags twice.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, ListChecks, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { useStagedChangeCount } from '@/store/stagedChangesStore'

const storageKey = (graphId: string) => `synodic-first-steps-dismissed:${graphId}`

interface FirstStepsChecklistProps {
  graphId: string
  /** Published head — > 1 means at least one publish landed. */
  mainHeadSeq: number
}

export function FirstStepsChecklist({ graphId, mainHeadSeq }: FirstStepsChecklistProps) {
  const [dismissed, setDismissed] = useState(() => !!localStorage.getItem(storageKey(graphId)))
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const containmentTypes = useContainmentEdgeTypes()
  const stagedCount = useStagedChangeCount()

  const steps = useMemo(() => {
    const cset = new Set(containmentTypes.map((t) => t.toUpperCase()))
    const edgeType = (e: (typeof edges)[number]) =>
      String(e.data?.edgeType ?? e.data?.relationship ?? '').toUpperCase()
    const hasEntity = nodes.length > 0
    // A child can arrive as a containment edge OR as a nested node (parentId) —
    // the create panel's outliner produces the latter before save.
    const hasChild =
      edges.some((e) => cset.has(edgeType(e))) || nodes.some((n) => !!n.data?.parentId)
    const hasConnection = edges.some((e) => {
      const t = edgeType(e)
      return !!t && t !== 'AGGREGATED' && !cset.has(t)
    })
    return [
      { label: 'Add your first entity', done: hasEntity },
      { label: 'Nest a child inside it', done: hasChild },
      { label: 'Connect two entities', done: hasConnection },
      { label: 'Publish your model', done: mainHeadSeq > 1 },
    ]
  }, [nodes, edges, containmentTypes, mainHeadSeq])

  const allDone = steps.every((s) => s.done)
  // Remember completion so a later visit (fresh state) doesn't resurface it.
  useEffect(() => {
    if (allDone && !localStorage.getItem(storageKey(graphId))) {
      localStorage.setItem(storageKey(graphId), 'done')
    }
  }, [allDone, graphId])
  if (dismissed || allDone) return null

  const doneCount = steps.filter((s) => s.done).length

  const dismiss = () => {
    localStorage.setItem(storageKey(graphId), '1')
    setDismissed(true)
  }

  return (
    <div className="absolute bottom-4 right-4 z-40 w-[248px] rounded-2xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-xl shadow-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-glass-border">
        <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-accent-lineage/10">
          <ListChecks className="w-3.5 h-3.5 text-accent-lineage" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-ink leading-tight">First steps</p>
          <p className="text-[10px] text-ink-muted leading-tight">{doneCount} of {steps.length} done</p>
        </div>
        <button
          onClick={dismiss}
          className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-canvas-overlay transition-colors"
          title="Hide"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <ul className="p-2 space-y-0.5">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2 px-1.5 py-1">
            <span
              className={cn(
                'flex items-center justify-center w-4 h-4 rounded-full border shrink-0 transition-colors',
                s.done
                  ? 'bg-emerald-500 border-emerald-500 text-white'
                  : 'border-glass-border text-transparent',
              )}
            >
              <Check className="w-2.5 h-2.5" strokeWidth={3} />
            </span>
            <span className={cn('text-xs', s.done ? 'text-ink-muted line-through' : 'text-ink')}>
              {s.label}
            </span>
          </li>
        ))}
      </ul>
      {stagedCount > 0 && (
        <p className="px-3.5 pb-2.5 text-[10px] text-amber-500">
          {stagedCount} unsaved change{stagedCount === 1 ? '' : 's'} — use Review &amp; Save when ready.
        </p>
      )}
    </div>
  )
}
