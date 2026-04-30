import { useMemo } from 'react'
import { Plus, Minus, PenLine, X, Save, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LineageNode, LineageEdge } from '@/store/canvas'

interface GraphChangesReviewDialogProps {
  /** The baseline nodes from before edit mode started. */
  snapshotNodes: LineageNode[]
  /** The baseline edges from before edit mode started. */
  snapshotEdges: LineageEdge[]
  /** Current nodes with edits. */
  currentNodes: LineageNode[]
  /** Current edges with edits. */
  currentEdges: LineageEdge[]
  /** True while the save request is in flight. */
  isSaving: boolean
  /** Callback to persist all changes. */
  onSave: () => void
  /** Callback to close the dialog without saving. */
  onClose: () => void
}

interface DiffItem {
  id: string
  label: string
}

interface DiffResult {
  added: DiffItem[]
  modified: DiffItem[]
  removed: DiffItem[]
}

function diffNodes(snapshot: LineageNode[], current: LineageNode[]): DiffResult {
  const snapshotMap = new Map(snapshot.map(n => [n.id, n]))
  const currentMap = new Map(current.map(n => [n.id, n]))

  const added: DiffItem[] = []
  const removed: DiffItem[] = []
  const modified: DiffItem[] = []

  for (const node of current) {
    if (node.data._draftStatus === 'deleted') {
      removed.push({ id: node.id, label: node.data.label || node.id })
    } else if (!snapshotMap.has(node.id)) {
      added.push({ id: node.id, label: node.data.label || node.id })
    } else {
      const snapNode = snapshotMap.get(node.id)!
      // Basic deep comparison of data object to detect modifications
      const snapData = { ...snapNode.data, _draftStatus: undefined }
      const currData = { ...node.data, _draftStatus: undefined }
      if (JSON.stringify(snapData) !== JSON.stringify(currData)) {
        modified.push({ id: node.id, label: node.data.label || node.id })
      }
    }
  }

  for (const snapNode of snapshot) {
    if (!currentMap.has(snapNode.id)) {
       // If removed completely from array (though we usually set _draftStatus = 'deleted')
       removed.push({ id: snapNode.id, label: snapNode.data.label || snapNode.id })
    }
  }

  // Deduplicate removed items just in case
  const uniqueRemoved = Array.from(new Map(removed.map(item => [item.id, item])).values())

  return { added, modified, removed: uniqueRemoved }
}

function diffEdges(snapshot: LineageEdge[], current: LineageEdge[]): DiffResult {
  const snapshotMap = new Map(snapshot.map(e => [e.id, e]))
  const currentMap = new Map(current.map(e => [e.id, e]))

  const added: DiffItem[] = []
  const removed: DiffItem[] = []
  const modified: DiffItem[] = []

  for (const edge of current) {
    const label = edge.data?.label || `${edge.source} -> ${edge.target}`
    if (edge.data?._draftStatus === 'deleted') {
      removed.push({ id: edge.id, label })
    } else if (!snapshotMap.has(edge.id)) {
      added.push({ id: edge.id, label })
    } else {
      const snapEdge = snapshotMap.get(edge.id)!
      const snapData = { ...snapEdge.data, _draftStatus: undefined }
      const currData = { ...edge.data, _draftStatus: undefined }
      if (JSON.stringify(snapData) !== JSON.stringify(currData)) {
        modified.push({ id: edge.id, label })
      }
    }
  }

  for (const snapEdge of snapshot) {
    if (!currentMap.has(snapEdge.id)) {
       const label = snapEdge.data?.label || `${snapEdge.source} -> ${snapEdge.target}`
       removed.push({ id: snapEdge.id, label })
    }
  }

  const uniqueRemoved = Array.from(new Map(removed.map(item => [item.id, item])).values())

  return { added, modified, removed: uniqueRemoved }
}

function DiffRow({ item }: { item: DiffItem }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="font-medium text-sm text-ink">{item.label}</span>
    </div>
  )
}

function DiffSection({
  icon: Icon,
  title,
  items,
  colorClasses,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  items: DiffItem[]
  colorClasses: { bg: string; icon: string; border: string }
}) {
  if (items.length === 0) return null
  return (
    <div className={cn('rounded-xl border px-4 py-3', colorClasses.bg, colorClasses.border)}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn('w-4 h-4', colorClasses.icon)} />
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title} ({items.length})
        </span>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {items.map(item => (
          <DiffRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

export function GraphChangesReviewDialog({
  snapshotNodes,
  snapshotEdges,
  currentNodes,
  currentEdges,
  isSaving,
  onSave,
  onClose,
}: GraphChangesReviewDialogProps) {
  const nodeDiff = useMemo(() => diffNodes(snapshotNodes, currentNodes), [snapshotNodes, currentNodes])
  const edgeDiff = useMemo(() => diffEdges(snapshotEdges, currentEdges), [snapshotEdges, currentEdges])

  const totalAdded = nodeDiff.added.length + edgeDiff.added.length
  const totalModified = nodeDiff.modified.length + edgeDiff.modified.length
  const totalRemoved = nodeDiff.removed.length + edgeDiff.removed.length

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-canvas-elevated rounded-2xl shadow-lg border border-glass-border w-full max-w-lg mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
        <div className="px-6 pt-6 pb-4 flex items-center gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0 border border-indigo-500/20">
            <Sparkles className="w-5 h-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink tracking-tight">Review Graph Changes</h3>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {totalAdded} added, {totalModified} modified, {totalRemoved} removed
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-ink-muted" />
          </button>
        </div>

        <div className="px-6 pb-4 overflow-y-auto flex-1 space-y-4">
          {(nodeDiff.added.length > 0 || nodeDiff.modified.length > 0 || nodeDiff.removed.length > 0) && (
            <div>
              <p className="text-[10px] font-semibold text-ink-muted/80 uppercase tracking-wider mb-2">
                Entities
              </p>
              <div className="space-y-2">
                <DiffSection
                  icon={Plus}
                  title="Added"
                  items={nodeDiff.added}
                  colorClasses={{ bg: 'bg-emerald-500/5', icon: 'text-emerald-500', border: 'border-emerald-500/10' }}
                />
                <DiffSection
                  icon={PenLine}
                  title="Modified"
                  items={nodeDiff.modified}
                  colorClasses={{ bg: 'bg-blue-500/5', icon: 'text-blue-500', border: 'border-blue-500/10' }}
                />
                <DiffSection
                  icon={Minus}
                  title="Removed"
                  items={nodeDiff.removed}
                  colorClasses={{ bg: 'bg-red-500/5', icon: 'text-red-500', border: 'border-red-500/10' }}
                />
              </div>
            </div>
          )}

          {(edgeDiff.added.length > 0 || edgeDiff.modified.length > 0 || edgeDiff.removed.length > 0) && (
            <div>
              <p className="text-[10px] font-semibold text-ink-muted/80 uppercase tracking-wider mb-2">
                Relationships
              </p>
              <div className="space-y-2">
                <DiffSection
                  icon={Plus}
                  title="Added"
                  items={edgeDiff.added}
                  colorClasses={{ bg: 'bg-emerald-500/5', icon: 'text-emerald-500', border: 'border-emerald-500/10' }}
                />
                <DiffSection
                  icon={PenLine}
                  title="Modified"
                  items={edgeDiff.modified}
                  colorClasses={{ bg: 'bg-blue-500/5', icon: 'text-blue-500', border: 'border-blue-500/10' }}
                />
                <DiffSection
                  icon={Minus}
                  title="Removed"
                  items={edgeDiff.removed}
                  colorClasses={{ bg: 'bg-red-500/5', icon: 'text-red-500', border: 'border-red-500/10' }}
                />
              </div>
            </div>
          )}

          {totalAdded === 0 && totalModified === 0 && totalRemoved === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-ink-muted">No changes detected in this draft.</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 flex-shrink-0 bg-black/5 dark:bg-white/5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            Continue Editing
          </button>
          <button
            onClick={onSave}
            disabled={isSaving || (totalAdded === 0 && totalModified === 0 && totalRemoved === 0)}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white transition-all duration-300 disabled:opacity-50',
              'bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700',
              'shadow-lg shadow-emerald-500/20 hover:scale-[1.02] active:scale-[0.98]'
            )}
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Confirm & Save
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
