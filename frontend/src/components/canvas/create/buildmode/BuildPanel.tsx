/**
 * BuildPanel — the canvas-docked "Build Mode" shell (wider than the 400px
 * `HierarchyBuilderPanel` rail — `min(720px, 55vw)` — same glass idiom).
 * Hosts the Outline/Grid/Paste tabs (stubbed placeholders here; Tasks 6-8
 * mount `BuildOutline`/`BuildGrid`/`BuildPaste`, which read/write
 * `useBuildRowsStore` directly), a live validation summary, and the Apply
 * flow. This component owns no row data itself — `useBuildRowsStore` is the
 * single source the tabs will edit; scope (parentUrn/layerId/initialMode)
 * comes from `useHierarchyBuilderStore`.
 *
 * Apply: `validateBuildRows` runs first (same as the live summary below — the
 * memo is recomputed on every render, so Apply always sees the latest rows),
 * then `filterStageableRows` drops any `status: 'error'` row and its whole
 * subtree (an unstaged parent can't be linked to), then the survivors are
 * committed via `stageBuildRows` in one O(n) pass.
 */
import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import {
  useViewEntityTypes,
  useViewRootEntityTypes,
  useViewEntityTypeHierarchyMap,
  useViewRelationshipTypes,
  useViewContainmentEdgeTypes,
} from '@/hooks/useViewSchema'
import type { EntityTypeSchema } from '@/types/schema'
import { useHierarchyBuilderStore } from '../hierarchyBuilderStore'
import { useBuildRowsStore } from './buildRowsStore'
import { validateBuildRows, summarize, type BuildOntologyCtx } from './validateBuildRows'
import { useStageBuildRows } from './stageBuildRows'
import { filterStageableRows } from './applyBuild'
import { BuildOutline } from './BuildOutline'

export interface BuildPanelProps {
  onClose: () => void
  /** Fired per staged row so the canvas can assign layers / expand parents. */
  onRowStaged?: (rowId: string, urn: string) => void
}

type BuildTab = 'outline' | 'grid' | 'paste'

const TABS: { id: BuildTab; label: string; icon: string; blurb: string }[] = [
  { id: 'outline', label: 'Outline', icon: 'List', blurb: 'Type and nest entities one at a time, keyboard-first.' },
  { id: 'grid', label: 'Grid', icon: 'LayoutGrid', blurb: 'Edit hundreds of rows at once in a spreadsheet.' },
  { id: 'paste', label: 'Paste', icon: 'ClipboardList', blurb: 'Paste an indented list or a spreadsheet column.' },
]

/** The ontology-colored icon chip shown for the scope banner's parent — matches HierarchyBuilderPanel's TypeChip. */
function TypeChip({ type }: { type?: EntityTypeSchema }) {
  return (
    <span
      className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${type?.visual?.color}20`, color: type?.visual?.color }}
    >
      <DynamicIcon name={type?.visual?.icon ?? 'Box'} className="w-2.5 h-2.5" />
    </span>
  )
}

export function BuildPanel({ onClose, onRowStaged }: BuildPanelProps) {
  const parentUrn = useHierarchyBuilderStore((s) => s.parentUrn)
  const initialMode = useHierarchyBuilderStore((s) => s.initialMode)
  const [activeTab, setActiveTab] = useState<BuildTab>(initialMode === 'paste' || initialMode === 'grid' ? initialMode : 'outline')

  const rows = useBuildRowsStore((s) => s.rows)
  const reset = useBuildRowsStore((s) => s.reset)

  const entityTypes = useViewEntityTypes()
  const rootEntityTypes = useViewRootEntityTypes()
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const ctx = useMemo<BuildOntologyCtx>(
    () => ({ entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes }),
    [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes],
  )

  // Scope banner — "Adding inside X", resolved from a real canvas node (Build's
  // parentUrn is always a real canvas urn or null, never a staged row).
  const canvasNodes = useCanvasStore((s) => s.nodes)
  const typeById = useMemo(() => new Map(entityTypes.map((t) => [t.id, t])), [entityTypes])
  const parentNode = useMemo(
    () => (parentUrn ? (canvasNodes.find((n) => n.id === parentUrn || (n.data?.urn as string) === parentUrn) ?? null) : null),
    [parentUrn, canvasNodes],
  )
  const parentType = parentNode ? typeById.get(parentNode.data?.type as string) : undefined

  // Live validation — recomputed from the latest rows/ctx on every render, so
  // Apply (which reads this same value) always validates before staging.
  const validated = useMemo(() => validateBuildRows(rows, ctx), [rows, ctx])
  const summary = useMemo(() => summarize(validated), [validated])
  const stageable = useMemo(() => filterStageableRows(validated), [validated])
  const fixes = useMemo(
    () => validated.flatMap((r) => r.fixes.map((f) => ({ rowName: r.name || '(unnamed)', note: f.note }))),
    [validated],
  )
  const [fixesOpen, setFixesOpen] = useState(false)

  const { stageBuildRows } = useStageBuildRows()
  const [applying, setApplying] = useState(false)
  const canApply = !applying && stageable.length > 0

  const handleApply = async () => {
    if (!canApply) return
    setApplying(true)
    try {
      await stageBuildRows(stageable, { rootParentUrn: parentUrn, onRowStaged })
      reset()
      onClose()
    } finally {
      setApplying(false)
    }
  }

  const activeSpec = TABS.find((t) => t.id === activeTab)!

  return (
    <AnimatePresence>
      <motion.div
        key="build-panel"
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 12 }}
        transition={{ duration: 0.15 }}
        className="relative h-full flex-shrink-0 overflow-hidden glass-panel border-l border-glass-border shadow-lg w-[min(720px,55vw)]"
      >
        <div className="h-full flex flex-col">
          {/* ── Header + scope banner ── */}
          <div className="flex-shrink-0 px-5 py-4 border-b border-glass-border bg-canvas-elevated/95">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500/15 to-violet-500/10 flex items-center justify-center">
                  <LucideIcons.LayoutGrid className="w-5 h-5 text-accent-lineage" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-ink">Build your model</h3>
                  <p className="text-xs text-ink-muted">Add a lot at once — outline, grid, or paste a list</p>
                </div>
              </div>
              <button onClick={onClose} title="Close" aria-label="Close" className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <LucideIcons.X className="w-5 h-5 text-ink-muted" />
              </button>
            </div>

            <div className="mt-3">
              {parentNode ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs">
                  <TypeChip type={parentType} />
                  <span className="min-w-0 flex-1 text-ink-muted truncate">
                    Adding inside <span className="font-semibold text-ink">{(parentNode.data?.label as string) ?? parentUrn}</span>
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-1 text-[11px] text-ink-muted">
                  <LucideIcons.Globe className="w-3 h-3 flex-shrink-0" />
                  <span>Adding at the top level</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Tab strip ── */}
          <div role="tablist" aria-label="Build mode sections" className="flex-shrink-0 flex items-center gap-1.5 px-5 pt-3 border-b border-glass-border">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  role="tab"
                  type="button"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'relative inline-flex items-center gap-2 px-3 h-8 rounded-t-lg text-sm font-medium transition-colors',
                    isActive ? 'text-accent-lineage' : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  <DynamicIcon name={tab.icon} className="w-3.5 h-3.5" />
                  {tab.label}
                  {isActive && (
                    <motion.span
                      layoutId="build-tab-indicator"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      className="absolute -bottom-px left-2 right-2 h-[2px] rounded-full bg-accent-lineage"
                    />
                  )}
                </button>
              )
            })}
          </div>

          {/* ── Body — Task 7/8 mount BuildGrid/BuildPaste here, reading/writing
              useBuildRowsStore directly (still stubbed). Task 6's BuildOutline
              reads the same `validated` view the footer summary below uses, so
              its type chips/status always match. ── */}
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {activeTab === 'outline' ? (
              <BuildOutline rows={validated} typeById={typeById} />
            ) : (
              <div className="h-full flex items-center justify-center text-center px-8">
                <div className="max-w-xs space-y-1.5">
                  <DynamicIcon name={activeSpec.icon} className="w-6 h-6 mx-auto text-ink-muted/40" />
                  <p className="text-sm text-ink-muted">{activeSpec.blurb}</p>
                  <p className="text-[11px] text-ink-muted/60">This tab is coming soon.</p>
                </div>
              </div>
            )}
          </div>

          {/* ── Live validation summary ── */}
          {rows.length > 0 && (
            <div className="flex-shrink-0 mx-5 mb-3 rounded-xl border border-glass-border bg-canvas-elevated/40 p-3 space-y-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1 text-emerald-500 font-medium">
                  <LucideIcons.CheckCircle2 className="w-3.5 h-3.5" />{summary.valid} valid
                </span>
                {summary.fixed > 0 && (
                  <span className="flex items-center gap-1 text-amber-500 font-medium">
                    <LucideIcons.Wand2 className="w-3.5 h-3.5" />{summary.fixed} auto-fixed
                  </span>
                )}
                {summary.errors > 0 && (
                  <span className="flex items-center gap-1 text-rose-500 font-medium">
                    <LucideIcons.AlertTriangle className="w-3.5 h-3.5" />{summary.errors} to fix
                  </span>
                )}
                {fixes.length > 0 && (
                  <button type="button" onClick={() => setFixesOpen((v) => !v)} className="ml-auto text-[11px] font-medium text-accent-lineage hover:underline">
                    {fixesOpen ? 'Hide fixes' : 'See fixes'}
                  </button>
                )}
              </div>
              <AnimatePresence>
                {fixesOpen && fixes.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="max-h-32 overflow-y-auto custom-scrollbar space-y-1 pt-1.5 border-t border-glass-border">
                      {fixes.map((f, i) => (
                        <div key={i} className="text-[11px] text-ink-muted">
                          <span className="font-medium text-ink">{f.rowName}</span>: {f.note}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* ── Footer ── */}
          <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
            <span className="text-[10px] text-ink-muted">
              {rows.length === 0
                ? 'Nothing to build yet'
                : stageable.length === validated.length
                  ? `${stageable.length} ready to apply`
                  // validated.length (not rows.length) — validation can add
                  // auto-inserted ancestor rows, so it's the true denominator.
                  : `${stageable.length} of ${validated.length} ready to apply`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={!canApply}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
                  canApply ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed',
                )}
              >
                {applying ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" /> : <LucideIcons.Check className="w-4 h-4" />}
                Apply
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
