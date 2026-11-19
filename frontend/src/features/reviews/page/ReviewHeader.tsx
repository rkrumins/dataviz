/**
 * ReviewHeader — the review page's top: the way back to the reviews, what this review is called
 * (a manager can rename it in place), where it stands and how many approvals it has, the one thing
 * to do next, and the rest of what can be done with it under More.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowLeft, Check, CornerUpLeft, Loader2, MoreHorizontal, Pencil, Trash2, Undo2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useFeature } from '@/store/features'
import { RevertDialog } from '@/features/versioning/components/RollbackDialogs'
import { PrKindIcon, PrStatusBadge, derivePrTitle, mergedAs } from '../components/PrMeta'
import type { ReviewActions } from '../hooks/useReviewActions'
import { approvalProgress, reviewerName, reviewerStates } from './readiness'

const MENU_ITEM = 'w-full flex items-center gap-2 px-3 py-2 text-[12.5px] rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.06]'

export function ReviewHeader({ wsId, actions, primaryAction, shortcuts }: {
  wsId: string
  actions: ReviewActions
  /** The one thing to do next (`ReviewPrimaryAction`). */
  primaryAction: ReactNode
  /** The page's keys (`ShortcutsHint`). */
  shortcuts?: ReactNode
}) {
  const { pr, user, canManage, canPublish, terminal, merging, sentBack, rejected, isAuthor, isOwner } = actions
  const versioningEnabled = useFeature('versioningEnabled')
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [dismissing, setDismissing] = useState(false)
  const [reverting, setReverting] = useState(false)
  if (!pr) return null

  const progress = approvalProgress(pr)
  const save = () => actions.saveDetails({ title, description: pr.description ?? '' }, () => setEditing(false))
  const canDismiss = canManage && !terminal && !merging
  const canWithdraw = !!sentBack && sentBack.by === user?.id
  const canDiscard = (isAuthor || isOwner) && rejected > 0 && !terminal
  const landedAs = mergedAs(pr)
  const canRevert = pr.status === 'merged' && canManage && canPublish && versioningEnabled && !!landedAs

  return (
    <header aria-label="This review" className="shrink-0 border-b border-glass-border/60 bg-canvas">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-6 py-3">
        <div className="min-w-0 flex-1">
          <Link to={`/workspaces/${wsId}/reviews`} className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> Reviews
          </Link>
          <div className="flex items-center gap-2 mt-1 min-w-0">
            <PrKindIcon pr={pr} className="w-4 h-4 text-ink-muted shrink-0" />
            {editing ? (
              <form className="flex items-center gap-1.5 min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); save() }}>
                <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Title"
                  placeholder="A short summary…"
                  onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
                  className="min-w-0 flex-1 max-w-xl h-8 rounded-lg border border-glass-border bg-canvas px-2.5 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40" />
                <button type="submit" disabled={actions.pending.update}
                  className="inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-[12.5px] font-semibold text-white bg-accent-lineage hover:opacity-90 disabled:opacity-60">
                  {actions.pending.update ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Check className="w-3.5 h-3.5" aria-hidden />}Save
                </button>
                <button type="button" onClick={() => setEditing(false)}
                  className="px-2.5 h-8 rounded-lg text-[12.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <h1 className="text-lg font-bold text-ink leading-tight truncate">{derivePrTitle(pr)}</h1>
                {canManage && (
                  <HoverTip label="Rename this review" className="inline-flex shrink-0">
                    <button type="button" aria-label="Rename this review" onClick={() => { setTitle(pr.title ?? ''); setEditing(true) }}
                      className="p-1 rounded-md text-ink-muted/70 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                      <Pencil className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </HoverTip>
                )}
              </>
            )}
            <PrStatusBadge status={pr.status} />
          </div>
        </div>

        {progress.required > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex -space-x-1.5" aria-hidden>
              {reviewerStates(pr).filter((r) => r.type === 'user').slice(0, 5).map((r) => (
                <UserAvatar key={r.id} userId={r.id} name={reviewerName(pr, r)}
                  className={cn('w-6 h-6 text-[9px] ring-2 ring-canvas', r.state !== 'approved' && 'opacity-40 grayscale')} />
              ))}
            </span>
            <span className={cn('text-[12px] font-semibold tabular-nums', progress.satisfied ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink-secondary')}>
              {progress.have.toLocaleString()} of {progress.required.toLocaleString()} approval{progress.required === 1 ? '' : 's'}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {shortcuts}
          {primaryAction}
          {(canDismiss || canWithdraw || canDiscard || canRevert) && (
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="More for this review"
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                  <MoreHorizontal className="w-4 h-4" aria-hidden />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6}
                  className="z-50 w-56 p-1 bg-canvas-elevated border border-glass-border rounded-xl shadow-lg animate-in fade-in slide-in-from-top-1 duration-100">
                  {canWithdraw && (
                    <DropdownMenu.Item onSelect={actions.withdraw} className={cn(MENU_ITEM, 'text-ink')}>
                      <CornerUpLeft className="w-3.5 h-3.5 text-ink-muted" aria-hidden /> Withdraw sending it back
                    </DropdownMenu.Item>
                  )}
                  {canDiscard && (
                    <DropdownMenu.Item onSelect={actions.discardRejected} className={cn(MENU_ITEM, 'text-rose-600 dark:text-rose-300')}>
                      <Trash2 className="w-3.5 h-3.5" aria-hidden /> Discard the rejected
                    </DropdownMenu.Item>
                  )}
                  {canRevert && (
                    <DropdownMenu.Item onSelect={() => setReverting(true)} className={cn(MENU_ITEM, 'text-rose-600 dark:text-rose-300')}>
                      <Undo2 className="w-3.5 h-3.5" aria-hidden /> Revert this merge
                    </DropdownMenu.Item>
                  )}
                  {canDismiss && (
                    <DropdownMenu.Item onSelect={() => setDismissing(true)} className={cn(MENU_ITEM, 'text-rose-600 dark:text-rose-300')}>
                      <XCircle className="w-3.5 h-3.5" aria-hidden /> Dismiss without merging
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </div>

      {/* Dismiss, asked first — plain-language, so it's clear this rejects the changes. */}
      {dismissing && canDismiss && (
        <div role="alertdialog" aria-label="Dismiss this review?" className="flex flex-wrap items-center gap-3 px-4 sm:px-6 py-3 border-t border-rose-500/25 bg-rose-500/[0.04]">
          <XCircle className="w-5 h-5 text-rose-500 shrink-0" aria-hidden />
          <p className="flex-1 min-w-[16rem] text-[12.5px] text-ink-muted leading-relaxed">
            <span className="font-semibold text-ink">Dismiss this review?</span> The proposed changes are rejected and nothing
            is applied to <span className="font-mono">main</span>. The draft itself is kept, so its author can open a new review or discard it later.
          </p>
          <button type="button" disabled={actions.busy} onClick={() => actions.dismiss(() => setDismissing(false))}
            className="inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12.5px] font-semibold text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-60">
            {actions.pending.dismiss ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <XCircle className="w-3.5 h-3.5" aria-hidden />} Dismiss
          </button>
          <button type="button" onClick={() => setDismissing(false)}
            className="px-3.5 h-8 rounded-lg text-[12.5px] font-medium text-ink-muted border border-glass-border hover:text-ink">
            Keep reviewing
          </button>
        </div>
      )}

      {landedAs && (
        <RevertDialog
          open={reverting}
          commit={{
            commit_id: landedAs, message: `Merge: ${derivePrTitle(pr)}`, kind: 'squash_publish',
            actor: pr.mergedBy ?? pr.actor, created_at: pr.mergedAt ?? pr.updatedAt, stats: {},
          }}
          wsId={wsId}
          // The merge commit is on the graph the review merged into: a fork's parent.
          graphId={pr.targetGraphId}
          userNames={pr.userNames}
          onClose={() => setReverting(false)}
        />
      )}
    </header>
  )
}
