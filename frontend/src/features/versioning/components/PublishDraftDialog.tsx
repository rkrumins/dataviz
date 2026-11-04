/**
 * Publish a specific draft, or send it for review: fetches its diff lazily and reuses the standard
 * CommitDialog. Opened from the drafts manager, and from an import that waits in a draft.
 *
 * Portaled: a host inside a transformed container (a wizard) would otherwise pin the dialog's
 * fixed overlay to that container rather than the window.
 */
import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useChangeSummary } from '../hooks/useVersioning'
import { fromChangeCounts } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { CommitDialog, type CommitDialogProps } from './CommitDialog'

export function PublishDraftDialog({
  wsId, graphId, branchId, onClose, onLeave, onPublished, canPublishDraft, dataSourceId,
}: {
  wsId: string
  graphId: string
  branchId: string
  dataSourceId?: CommitDialogProps['dataSourceId']
  onClose: () => void
  onLeave?: CommitDialogProps['onLeave']
  onPublished?: CommitDialogProps['onPublished']
  canPublishDraft?: CommitDialogProps['canPublishDraft']
}) {
  // The dialog says how much the draft changes, so it reads the draft's counts — never the diff,
  // which for a 100,000-change draft was tens of megabytes to show three numbers.
  const origin = useMemo(() => ({ branchId }), [branchId])
  const summaryQ = useChangeSummary(wsId, graphId, origin)
  const changeSet = useMemo(
    () => (summaryQ.data ? fromChangeCounts(summaryQ.data.counts, branchId) : EMPTY_CHANGE_SET),
    [summaryQ.data, branchId],
  )
  if (summaryQ.isLoading) {
    return createPortal(
      <>
        <Backdrop open={summaryQ.isLoading} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl bg-canvas-elevated border border-glass-border text-sm text-ink-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Preparing publish…
          </div>
        </div>
      </>,
      document.body,
    )
  }
  return createPortal(
    <CommitDialog
      workspaceId={wsId}
      graphId={graphId}
      branchId={branchId}
      changeSet={changeSet}
      onClose={onClose}
      onLeave={onLeave}
      onPublished={onPublished}
      canPublishDraft={canPublishDraft}
      dataSourceId={dataSourceId}
    />,
    document.body,
  )
}
