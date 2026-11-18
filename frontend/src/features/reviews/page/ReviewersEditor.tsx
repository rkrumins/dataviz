/**
 * ReviewersEditor — who was asked to review it, and where each stands: Approved, Approved an earlier
 * version, Asked for changes, Commented or Waiting — and, for a group, who answered for it. Whoever
 * may change who reviews it (`viewerCan.editReviewers`) asks someone again, takes them off, and asks
 * more people or groups.
 */
import { RotateCw, Users, X } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonChip } from '@/components/ui/PersonChip'
import { useAppNotifications } from '@/components/ui/notifications'
import type { ReviewerState } from '@/services/versioningApiService'
import { ReviewerPicker } from '@/features/versioning/components/ReviewerPicker'
import { useReRequestReviewers, useSetReviewers } from '@/features/versioning/hooks/useVersioning'
import type { ReviewActions } from '../hooks/useReviewActions'
import { reviewerName, reviewerStates } from './readiness'

const STATE: Record<ReviewerState['state'], { label: string; tone: BadgeTone }> = {
  approved: { label: 'Approved', tone: 'success' },
  approved_earlier: { label: 'Approved an earlier version', tone: 'warning' },
  changes_requested: { label: 'Asked for changes', tone: 'danger' },
  commented: { label: 'Commented', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'neutral' },
}

const ICON_BUTTON = 'p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50'

export function ReviewersEditor({ wsId, actions }: { wsId: string; actions: ReviewActions }) {
  const { pr } = actions
  const { notify } = useAppNotifications()
  const setM = useSetReviewers(wsId)
  const againM = useReRequestReviewers(wsId)
  if (!pr) return null
  const reviewers = reviewerStates(pr)
  const editable = !!pr.viewerCan?.editReviewers
  const users = reviewers.filter((r) => r.type === 'user').map((r) => r.id)
  const groups = reviewers.filter((r) => r.type === 'group').map((r) => r.id)
  const busy = setM.isPending || againM.isPending
  const failed = (e: unknown) => notify('error', (e as Error).message)

  const set = (next: { users?: string[]; groups?: string[] }) =>
    setM.mutate({ prId: pr.prId, graphId: pr.graphId, ...next }, { onError: failed })
  const remove = (r: ReviewerState) =>
    set(r.type === 'user' ? { users: users.filter((u) => u !== r.id) } : { groups: groups.filter((g) => g !== r.id) })
  const askAgain = (r: ReviewerState) => againM.mutate(
    { prId: pr.prId, graphId: pr.graphId, ...(r.type === 'user' ? { users: [r.id] } : { groups: [r.id] }) },
    { onSuccess: () => notify('success', `Asked ${reviewerName(pr, r)} again. They’ve been told.`), onError: failed },
  )

  return (
    <div className="space-y-2">
      {reviewers.length === 0 ? (
        <p className="text-[12px] text-ink-muted">No one was asked to review this.</p>
      ) : (
        <ul className="space-y-1.5">
          {reviewers.map((r) => {
            const state = STATE[r.state] ?? STATE.waiting
            const name = reviewerName(pr, r)
            const answeredBy = r.type === 'group' && r.by && r.state !== 'waiting' ? r.by : null
            return (
              <li key={`${r.type}:${r.id}`} className="flex items-center gap-2 min-w-0">
                {r.type === 'group' ? (
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0 text-xs font-semibold text-ink">
                      <Users className="w-4 h-4 shrink-0 text-ink-muted" aria-hidden />
                      <span className="truncate">{name}</span>
                    </span>
                    {answeredBy && (
                      <span className="flex items-center gap-1 mt-0.5 pl-5 text-[11px] text-ink-muted">
                        by <PersonChip id={answeredBy} person={pr.userNames?.[answeredBy] ? { name: pr.userNames[answeredBy] } : undefined} size="xs" />
                      </span>
                    )}
                  </span>
                ) : (
                  <PersonChip id={r.id} person={pr.userNames?.[r.id] ? { name: pr.userNames[r.id] } : undefined} size="sm" className="min-w-0" />
                )}
                <Badge tone={state.tone} size="sm" className="ml-auto shrink-0">{state.label}</Badge>
                {editable && (
                  <span className="flex items-center shrink-0">
                    {r.state !== 'approved' && (
                      <HoverTip label={`Ask ${name} to review it again`} detail="It is back in their queue, and they are told" className="inline-flex">
                        <button type="button" aria-label={`Ask ${name} again`} disabled={busy} onClick={() => askAgain(r)} className={ICON_BUTTON}>
                          <RotateCw className="w-3.5 h-3.5" aria-hidden />
                        </button>
                      </HoverTip>
                    )}
                    <HoverTip label={`Stop asking ${name} to review it`} className="inline-flex">
                      <button type="button" aria-label={`Remove ${name}`} disabled={busy} onClick={() => remove(r)} className={ICON_BUTTON}>
                        <X className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    </HoverTip>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editable && (
        // One change at a time: each says the whole list of its kind.
        <ReviewerPicker wsId={wsId} value={users} onChange={(next) => { if (!busy) set({ users: next }) }}
          groups={groups} onGroupsChange={(next) => { if (!busy) set({ groups: next }) }} showChosen={false} />
      )}
    </div>
  )
}
