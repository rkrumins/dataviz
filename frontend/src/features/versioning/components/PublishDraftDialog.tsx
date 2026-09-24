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
import { useDiffVsMain } from '../hooks/useVersioning'
import { fromDiffVsMain } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { CommitDialog, type CommitDialogProps } from './CommitDialog'

export function PublishDraftDialog({
  wsId, graphId, branchId, onClose, onLeave, onPublished,
}: {
  wsId: string
  graphId: string
  branchId: string
  onClose: () => void
  onLeave?: CommitDialogProps['onLeave']
  onPublished?: CommitDialogProps['onPublished']
}) {
  const diffQ = useDiffVsMain(wsId, graphId, branchId)
  const changeSet = useMemo(
    () => (diffQ.data ? fromDiffVsMain(diffQ.data, branchId) : EMPTY_CHANGE_SET),
    [diffQ.data, branchId],
  )
  if (diffQ.isLoading) {
    return createPortal(
      <>
        <Backdrop open={diffQ.isLoading} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
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
    />,
    document.body,
  )
}
