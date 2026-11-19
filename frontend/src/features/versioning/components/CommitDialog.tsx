/**
 * CommitDialog — take a draft to main. PR-by-default: the primary action opens a merge request
 * (review path); "Publish directly" is the `:manage`-gated shortcut. What it does, and what a
 * refused publish says, is the shared publish flow (`PublishForm`) — the Review & Save stepper's
 * last step is the same flow.
 */
import { X, GitPullRequest } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { ChangeSet } from '../model/changeModel'
import { PublishActions, PublishBody, usePublishFlow } from './PublishForm'

export interface CommitDialogProps {
  workspaceId: string
  graphId: string
  branchId: string
  changeSet: ChangeSet
  onClose: () => void
  /** For a host that is itself a dialog (an import's success step): called once this dialog has
   *  taken the person elsewhere (to the review, or to a view on the draft), so the host closes too. */
  onLeave?: () => void
  /** Called once the draft is published. */
  onPublished?: () => void
  /** False for an editor of a shared draft: only its owner or a maintainer publishes it directly. */
  canPublishDraft?: boolean
  /** The draft's data source: its policy may have drafts published only through a review. */
  dataSourceId?: string | null
}

export function CommitDialog(props: CommitDialogProps) {
  const flow = usePublishFlow(props)
  const { busy, inReview } = flow
  const { onClose } = props

  return (
    <>
    <Backdrop open={true} onClick={busy ? undefined : onClose} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in flex flex-col pointer-events-auto">
        <div className="px-6 pt-6 pb-4 flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center border',
            inReview
              ? 'bg-indigo-500/10 border-indigo-500/20'
              : 'bg-accent-lineage/10 border-accent-lineage/20',
          )}>
            <GitPullRequest className={cn('w-5 h-5', inReview ? 'text-indigo-500' : 'text-accent-lineage')} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink tracking-tight">
              {inReview ? 'Already in review' : 'Publish your draft'}
            </h3>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {inReview
                ? 'This draft has an open review — your changes are part of it.'
                : 'Send your changes to the Published version.'}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-lg hover:bg-canvas-overlay transition-colors disabled:opacity-50">
            <X className="w-4 h-4 text-ink-muted" />
          </button>
        </div>

        <PublishBody flow={flow} />

        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
          <PublishActions flow={flow} />
        </div>
      </div>
    </div>
    </>
  )
}
