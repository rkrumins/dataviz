/**
 * ViewVersioningPanel — the canvas review hub for a view, as a slide-over with three tabs:
 *   • Changes — one place for everything in this branch: PENDING (unsaved canvas edits) at the top
 *     with a Review & Save action, then ALL committed branch changes cumulatively (summary-first
 *     tree). So after you save, your work doesn't "disappear" — it moves from Pending to Committed
 *     in the same view.
 *   • Commits — the branch's history commit-by-commit (this draft / this view / whole graph), each
 *     expandable to its own diff (GitHub-style).
 *   • Pull Requests — raised from this view, or the whole data source.
 */
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, FileDiff, GitPullRequest, GitCommit, PencilLine, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import * as api from '@/services/versioningApiService'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchDiffSummary } from '../hooks/useVersioning'
import { ChangeTreePanel } from './ChangeTreePanel'
import { ViewPrList } from '../../reviews/components/ViewPrList'
import { ViewHistoryTimeline } from './ViewHistoryTimeline'
import { DataHealthTab } from './DataHealthTab'
import { MOTION } from '@/lib/motion'

export type ViewPanelTab = 'changes' | 'prs' | 'history' | 'health'

const TABS: Array<{ id: ViewPanelTab; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'changes', label: 'Changes', Icon: FileDiff },
  { id: 'history', label: 'Commits', Icon: GitCommit },
  { id: 'prs', label: 'Pull Requests', Icon: GitPullRequest },
  { id: 'health', label: 'Data health', Icon: Activity },
]

/** Unsaved canvas edits for the active branch (from the staged store) — surfaced in the hub so the
 *  user always sees what's pending, with one click to the Review & Save modal. */
function PendingChanges() {
  const changes = useStagedChangesStore((s) => s.changes)
  const openReview = useStagedChangesStore((s) => s.openReviewPanel)
  if (changes.length === 0) return null
  const creates = changes.filter((c) => c.type.startsWith('create')).length
  const deletes = changes.filter((c) => c.type.startsWith('delete')).length
  const edits = changes.length - creates - deletes
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-amber-700 dark:text-amber-300">
          <PencilLine className="w-3.5 h-3.5" />
          {changes.length} unsaved {changes.length === 1 ? 'edit' : 'edits'}
        </span>
        <button
          onClick={openReview}
          className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors"
        >
          Review &amp; Save
        </button>
      </div>
      <p className="text-[11px] text-ink-muted mt-1.5">
        {[creates && `${creates} created`, edits && `${edits} edited`, deletes && `${deletes} deleted`]
          .filter(Boolean).join(' · ')} — not committed to the branch yet.
      </p>
    </div>
  )
}

export function ViewVersioningPanel({
  wsId,
  graphId,
  viewId,
  dataSourceId,
  branchId,
  viewName,
  initialTab = 'changes',
  canManage = false,
  onClose,
}: {
  wsId: string
  graphId: string
  viewId?: string | null
  dataSourceId?: string | null
  branchId?: string | null
  viewName?: string | null
  initialTab?: ViewPanelTab
  canManage?: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState<ViewPanelTab>(initialTab)

  // The "Data health" tab is a power-user (manager) surface — hidden entirely for everyone else.
  const tabs = canManage ? TABS : TABS.filter((t) => t.id !== 'health')

  // Request the backend max of top-level groups so "all branch changes" is genuinely complete —
  // the truncation advisory only appears past it (far beyond any real schema's top-level containers).
  const summaryQ = useBranchDiffSummary(wsId, graphId, branchId ?? null, 1000)
  const fetchChildren = useCallback(
    (key: string, offset: number) =>
      api.getBranchDiffChildren(wsId, graphId, branchId!, key, { offset, limit: 50 }),
    [wsId, graphId, branchId],
  )

  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/40" />
      {/* Entrance-only, and no <AnimatePresence>: the panel is mounted only
          while it is open, so its presence tree unmounted with it and the
          `exit` never ran. A viewport-height panel sitting inside a presence
          tree is the shape that strands a click-blocker in the body when an
          exit is interrupted; without one there is nothing to strand. */}
      <motion.aside
        key="panel"
        className="fixed right-0 top-0 h-full w-[560px] max-w-[94vw] z-[61] bg-canvas border-l border-glass-border flex flex-col shadow-lg"
        initial={{ x: 560 }}
        animate={{ x: 0 }}
        transition={MOTION.modalSpring}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-glass-border/60">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink leading-tight truncate">Changes & Reviews</h2>
            {viewName && <p className="text-[12px] text-ink-muted truncate mt-0.5">{viewName}</p>}
          </div>
          <button onClick={onClose} className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 pt-2 border-b border-glass-border/60">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors',
                tab === id ? 'border-accent-lineage text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-5">
          {tab === 'changes' &&
            (branchId ? (
              <div className="space-y-4">
                <PendingChanges />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2 px-0.5">
                    Committed in this branch
                  </p>
                  <ChangeTreePanel
                    summary={summaryQ.data}
                    isLoading={summaryQ.isLoading}
                    fetchChildren={fetchChildren}
                    origin={{ source: 'branch', branchId }}
                    emptyHint="Nothing committed to this branch yet — saved canvas edits show up here."
                    summaryFirst
                  />
                </div>
              </div>
            ) : (
              <div className="py-10 text-center">
                <p className="text-sm text-ink-muted">Switch to a draft to review its changes.</p>
              </div>
            ))}

          {tab === 'prs' &&
            (viewId ? (
              <ViewPrList wsId={wsId} viewId={viewId} dataSourceId={dataSourceId} />
            ) : (
              <p className="py-10 text-center text-sm text-ink-muted">No active view.</p>
            ))}

          {tab === 'history' && (
            <ViewHistoryTimeline wsId={wsId} graphId={graphId} viewId={viewId} branchId={branchId} canManage={canManage} />
          )}

          {tab === 'health' && canManage && <DataHealthTab wsId={wsId} graphId={graphId} />}
        </div>
      </motion.aside>
    </>,
    document.body,
  )
}
