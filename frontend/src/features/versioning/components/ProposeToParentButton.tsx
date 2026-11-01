/**
 * ProposeToParentButton — propose a fork's changes to its parent as a review (anyone who can read the
 * fork may). A small dialog asks for a title, a description and reviewers, as sending a draft for
 * review does, and the review opens in the reviews inbox — or, when the fork already has one, that
 * one does.
 *
 * Behind its parent, it says to update from parent first: the review merges only once the fork has
 * taken its parent's changes (the merge refuses `not_up_to_date` until then). Opening the review is
 * not refused, so it is not disabled: someone without the publish permission can't update the fork,
 * and may still propose it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { GitPullRequestArrow, TriangleAlert } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { PullRequestExistsError } from '@/services/versioningApiService'
import { useOpenForkPullRequest } from '../hooks/useVersioning'
import { ReviewerPicker } from './ReviewerPicker'

const INPUT_CLS = 'w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40'

export function ProposeToParentButton({ wsId, forkGraphId, parentDataSourceId, behind, className }: {
  wsId: string
  /** The fork's graph. */
  forkGraphId: string
  /** The data source the review merges into, whose policy says who may approve it. */
  parentDataSourceId?: string | null
  /** Its parent's changes the fork has not taken in. */
  behind: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <span className={className ?? 'inline-flex items-center gap-1.5'}>
        <Button size="sm" variant="secondary" leftIcon={GitPullRequestArrow} onClick={() => setOpen(true)}>
          Propose to parent
        </Button>
        {behind > 0 && (
          <HoverTip className="inline-flex"
            label="Its review merges into its parent only once the fork has taken its parent’s changes">
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              Update from parent first
            </span>
          </HoverTip>
        )}
      </span>
      {open && (
        <ProposeDialog wsId={wsId} forkGraphId={forkGraphId} parentDataSourceId={parentDataSourceId}
          behind={behind} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function ProposeDialog({ wsId, forkGraphId, parentDataSourceId, behind, onClose }: {
  wsId: string
  forkGraphId: string
  parentDataSourceId?: string | null
  behind: number
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { notify } = useAppNotifications()
  const propose = useOpenForkPullRequest(wsId, forkGraphId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [reviewers, setReviewers] = useState<string[]>([])
  const [refusal, setRefusal] = useState<string | null>(null)
  // Ref-stable close: the a11y hook re-focuses the panel whenever its callback changes identity, as
  // `onClose` does each time the row around the dialog renders. The ref is updated after each render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  const close = useCallback(() => onCloseRef.current(), [])
  const ref = useModalA11y(true, close)
  const titleId = 'propose-to-parent-title'

  const goTo = (prId: string) => {
    close()
    navigate(`/workspaces/${wsId}/reviews?pr=${prId}`)
  }

  const submit = async () => {
    setRefusal(null)
    try {
      const res = await propose.mutateAsync({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        reviewers: reviewers.length ? reviewers : undefined,
      })
      notify('success', 'Sent for review.')
      goTo(res.prId)
    } catch (e) {
      // A fork has one open review at a time: show it rather than dead-ending.
      if (e instanceof PullRequestExistsError) {
        notify('info', 'This fork is already in review.')
        goTo(e.prId)
        return
      }
      setRefusal(e instanceof Error ? e.message : 'Could not open the review.')
    }
  }

  return createPortal(
    <>
      <Backdrop open onClick={close} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in pointer-events-auto outline-none"
        >
          <div className="px-6 pt-6 pb-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shrink-0">
              <GitPullRequestArrow className="w-5 h-5 text-indigo-500" />
            </div>
            <h3 id={titleId} className="text-base font-semibold text-ink tracking-tight">Propose to parent</h3>
          </div>

          <p className="px-6 pb-4 text-[13px] text-ink-muted leading-relaxed">
            Opens a review of this fork’s changes. Once it is approved, merging it copies them into the
            data source it was forked from.
          </p>

          {behind > 0 && (
            <div className="mx-6 mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
              <span>Its parent has changed since the fork last took its changes. Update from parent first: the review merges only once the fork is up to date.</span>
            </div>
          )}

          <div className="px-6 pb-4 space-y-3">
            <div className="space-y-1">
              <label htmlFor="propose-title" className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Title</label>
              <input id="propose-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="A short summary…" className={INPUT_CLS} />
            </div>
            <div className="space-y-1">
              <label htmlFor="propose-description" className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Description</label>
              <textarea id="propose-description" value={description} onChange={(e) => setDescription(e.target.value)}
                rows={3} placeholder="Context for reviewers…" className={`${INPUT_CLS} resize-none`} />
            </div>
            <ReviewerPicker wsId={wsId} dataSourceId={parentDataSourceId} value={reviewers} onChange={setReviewers} />
          </div>

          {refusal && (
            <div role="alert" className="mx-6 mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
              <span>{refusal}</span>
            </div>
          )}

          <div className="px-6 py-4 border-t border-glass-border/60 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={propose.isPending}>Cancel</Button>
            <Button variant="primary" leftIcon={GitPullRequestArrow} loading={propose.isPending} onClick={() => { void submit() }}>
              Open review
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
