/**
 * ViewVersioningPanel — the canvas review surface for a view, as a slide-over with three
 * tabs: Changes (this draft's hierarchical diff), Pull Requests (raised from this view, or
 * the whole data source), and History (this view's change log). Reuses the diff tree, the
 * existing PR list/detail, and the commit timeline; the shell mirrors PrDetailDrawer.
 */
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileDiff, GitPullRequest, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as api from '@/services/versioningApiService'
import { useBranchDiffSummary } from '../hooks/useVersioning'
import { ChangeTreePanel } from './ChangeTreePanel'
import { ViewPrList } from '../../reviews/components/ViewPrList'
import { ViewHistoryTimeline } from './ViewHistoryTimeline'

export type ViewPanelTab = 'changes' | 'prs' | 'history'

const TABS: Array<{ id: ViewPanelTab; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'changes', label: 'Changes', Icon: FileDiff },
  { id: 'prs', label: 'Pull Requests', Icon: GitPullRequest },
  { id: 'history', label: 'History', Icon: History },
]

export function ViewVersioningPanel({
  wsId,
  graphId,
  viewId,
  dataSourceId,
  branchId,
  viewName,
  initialTab = 'changes',
  onClose,
}: {
  wsId: string
  graphId: string
  viewId?: string | null
  dataSourceId?: string | null
  branchId?: string | null
  viewName?: string | null
  initialTab?: ViewPanelTab
  onClose: () => void
}) {
  const [tab, setTab] = useState<ViewPanelTab>(initialTab)

  const summaryQ = useBranchDiffSummary(wsId, graphId, branchId ?? null)
  const fetchChildren = useCallback(
    (key: string, offset: number) =>
      api.getBranchDiffChildren(wsId, graphId, branchId!, key, { offset, limit: 50 }),
    [wsId, graphId, branchId],
  )

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="scrim"
        className="fixed inset-0 z-[60] bg-black/40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.aside
        key="panel"
        className="fixed right-0 top-0 h-full w-[560px] max-w-[94vw] z-[61] bg-canvas border-l border-glass-border flex flex-col shadow-lg"
        initial={{ x: 560 }}
        animate={{ x: 0 }}
        exit={{ x: 560 }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
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
          {TABS.map(({ id, label, Icon }) => (
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
              <ChangeTreePanel
                summary={summaryQ.data}
                isLoading={summaryQ.isLoading}
                fetchChildren={fetchChildren}
                origin={{ source: 'branch', branchId }}
                emptyHint="This draft has no changes yet."
              />
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
            <ViewHistoryTimeline wsId={wsId} graphId={graphId} viewId={viewId} branchId={branchId} />
          )}
        </div>
      </motion.aside>
    </AnimatePresence>,
    document.body,
  )
}
