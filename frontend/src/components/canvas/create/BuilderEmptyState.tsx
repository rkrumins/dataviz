/**
 * BuilderEmptyState — shared blank-start hero for GraphCanvas and
 * HierarchyCanvas when the canvas has no nodes yet. Design sibling of
 * `context-view/BlankCanvasEmptyState.tsx` (that one covers the blank-model
 * hero on ContextViewCanvas specifically; this one is the generic "nothing
 * here" card for the other two canvases, so it carries no model/draft props).
 *
 * All three CTAs go through {@link useHierarchyBuilderStore}, whose `open()`
 * calls `ensureDraftOpen()` before setting state — the draft guard is
 * centralized there, not duplicated here.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Plus, ClipboardList, Sparkles, ChevronRight } from 'lucide-react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useViewEntityTypes, useViewRootEntityTypes } from '@/hooks/useViewSchema'
import { containmentChains } from '@/services/ontologyPreflightService'
import { useHierarchyBuilderStore } from './hierarchyBuilderStore'

const MAX_TEMPLATES = 3

export function BuilderEmptyState() {
  const entityTypes = useViewEntityTypes()
  const rootEntityTypes = useViewRootEntityTypes()
  const typeById = useMemo(() => new Map(entityTypes.map((et) => [et.id, et])), [entityTypes])

  // Up to 3 deduped, non-trivial (2+ types) containment chains — a one-click
  // scaffold to start from. containmentChains() already dedupes exact
  // duplicates and keeps only maximal paths; here we additionally drop
  // single-type "chains" (not a scaffold) and cap the offered count.
  const templates = useMemo(() => {
    const seen = new Set<string>()
    const out: string[][] = []
    for (const chain of containmentChains(entityTypes, rootEntityTypes)) {
      if (chain.length < 2) continue
      const key = chain.join('>')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(chain)
      if (out.length >= MAX_TEMPLATES) break
    }
    return out
  }, [entityTypes, rootEntityTypes])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="pointer-events-auto w-[420px] max-w-[calc(100%-3rem)] rounded-3xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-xl shadow-xl p-7 text-center"
      >
        <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-lineage/15 to-violet-500/10 border border-accent-lineage/20 mb-4">
          <Plus className="w-7 h-7 text-accent-lineage" />
        </span>
        <h2 className="text-lg font-bold text-ink leading-tight">Start your model</h2>
        <p className="text-sm text-ink-muted mt-1.5">
          Add entities, nest them into a hierarchy, or paste a list to bring in several at once.
        </p>

        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={() => useHierarchyBuilderStore.getState().open()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            Add entities
          </button>
          <button
            onClick={() => useHierarchyBuilderStore.getState().open({ mode: 'paste' })}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium text-ink border border-glass-border hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <ClipboardList className="w-4 h-4" />
            Paste a list
          </button>
        </div>

        {templates.length > 0 && (
          <div className="mt-4">
            <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-ink-muted/70 mb-2">
              <Sparkles className="w-3 h-3" />Start from a template
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {templates.map((chain) => (
                <button
                  key={chain.join('>')}
                  onClick={() => useHierarchyBuilderStore.getState().open({ template: chain })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-glass-border bg-canvas-overlay/60 hover:border-accent-lineage/60 hover:bg-accent-lineage/5 text-xs font-medium text-ink transition-colors"
                >
                  <span className="flex items-center">
                    {chain.map((id, i) => {
                      const t = typeById.get(id)
                      return (
                        <span key={id} className="flex items-center">
                          {i > 0 && <ChevronRight className="w-2.5 h-2.5 text-ink-muted/50" />}
                          <DynamicIcon name={t?.visual?.icon ?? 'Box'} className="w-3 h-3" style={{ color: t?.visual?.color }} />
                        </span>
                      )
                    })}
                  </span>
                  {chain.map((id) => typeById.get(id)?.name ?? id).join(' → ')}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-5 text-[11px] text-ink-muted/80">
          or press <kbd className="px-1.5 py-0.5 rounded border border-glass-border bg-canvas-overlay text-[10px] font-semibold">N</kbd>
        </p>
      </motion.div>
    </div>
  )
}
