/**
 * ReviewTimeline — what happened on a review, oldest first, from its history (`…/events`) and, for
 * a draft's review, the draft's own revisions between: opened; who was asked, asked again and no
 * longer asked, each one line, by name; each review given as a card — its verdict, its summary and
 * what the reviewer did (accepted, rejected, threads started); a verdict taken back; merged (or
 * published past it) or closed. Each revision opens to what it changed.
 */
import { useState } from 'react'
import {
  CheckCircle2, CornerUpLeft, GitMerge, GitPullRequestArrow, MessageSquare, RotateCw, ShieldAlert, Undo2, UserMinus,
  UserPlus, XCircle, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { DateTime } from '@/components/ui/DateTime'
import type { PullRequest, ReviewEvent, ReviewVerdict } from '@/services/versioningApiService'
import { useCommitLog, useReviewEvents } from '@/features/versioning/hooks/useVersioning'
import { CommitRow } from '@/features/versioning/components/CommitRow'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { isDraftMr, mergedAs } from '../components/PrMeta'

const VERDICT: Record<ReviewVerdict, { label: string; tone: BadgeTone; Icon: LucideIcon; tint: string }> = {
  approve: { label: 'Approved', tone: 'success', Icon: CheckCircle2, tint: 'bg-emerald-500' },
  request_changes: { label: 'Asked for changes', tone: 'danger', Icon: CornerUpLeft, tint: 'bg-rose-500' },
  comment: { label: 'Commented', tone: 'neutral', Icon: MessageSquare, tint: 'bg-ink-muted' },
}

/** "Bo", "Bo and Cy", "Bo, Cy and Finance stewards". */
function list(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

type Entry = { at: string; event: ReviewEvent } | { at: string; commit: Record<string, unknown> }

export function ReviewTimeline({ wsId, pr }: { wsId: string; pr: PullRequest }) {
  const eventsQ = useReviewEvents(wsId, pr.prId)
  const draft = isDraftMr(pr)
  const commitsQ = useCommitLog(wsId, draft ? pr.graphId : null, pr.sourceBranchId ?? null)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (eventsQ.isError) {
    return (
      <p className="text-[12px] text-ink-muted">
        Couldn’t read what happened on this review.{' '}
        <button type="button" onClick={() => void eventsQ.refetch()} className="font-semibold text-accent-lineage hover:underline">Try again</button>
      </p>
    )
  }
  if (!eventsQ.data) return <p className="text-[12px] text-ink-muted">Reading what happened…</p>

  const { userNames, groupNames } = eventsQ.data
  const person = (id?: string | null) => ownerName(id, { ...pr.userNames, ...userNames })
  const subject = (s: { type: 'user' | 'group'; id: string }) => (s.type === 'group' ? groupNames[s.id] ?? s.id : person(s.id))
  const entries: Entry[] = [
    ...eventsQ.data.events.map((event) => ({ at: event.at ?? '', event })),
    ...(draft ? commitsQ.data?.commits ?? [] : []).map((commit) => ({ at: String(commit.created_at ?? ''), commit })),
  ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))

  const line = (e: ReviewEvent): { Icon: LucideIcon; text: string; tint: string } | null => {
    const who = person(e.actor)
    const whom = list(e.subjects.map(subject))
    switch (e.kind) {
      case 'opened': return { Icon: GitPullRequestArrow, text: `Opened by ${who}`, tint: 'bg-accent-lineage' }
      case 'requested': return { Icon: UserPlus, text: `${who} asked ${whom} to review`, tint: 'bg-accent-lineage' }
      case 're_requested': return { Icon: RotateCw, text: `${who} asked ${whom} again`, tint: 'bg-accent-lineage' }
      case 'unrequested': return { Icon: UserMinus, text: `${who} no longer asks ${whom}`, tint: 'bg-ink-muted' }
      case 'withdrew': return {
        Icon: Undo2, tint: 'bg-ink-muted',
        text: `${who} took back ${e.verdict === 'request_changes' ? 'asking for changes' : e.verdict === 'approve' ? 'their approval' : 'their review'}`,
      }
      case 'merged': {
        // Published straight past the review: what it proposed landed without its reviewers seeing it.
        const bypassed = pr.mergedVia === 'direct_publish'
        const landedAs = mergedAs(pr)
        const sha = landedAs ? ` · ${landedAs.slice(0, 8)}` : ''
        return {
          Icon: bypassed ? ShieldAlert : GitMerge, tint: bypassed ? 'bg-amber-500' : 'bg-violet-500',
          text: bypassed ? `Published directly by ${who}, bypassing this review${sha}`
            : pr.mergedVia === 'review_partial' ? `What was accepted merged by ${who}${sha}; the rest stayed on the draft`
              : `Merged by ${who}${sha}`,
        }
      }
      case 'closed': return { Icon: XCircle, text: `Closed by ${who}`, tint: 'bg-ink-muted' }
      default: return null
    }
  }

  return (
    <ol aria-label="What happened" className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
      {entries.map((entry, i) => {
        if ('commit' in entry) {
          const id = (entry.commit.commit_id as string) ?? String(i)
          return (
            <CommitRow key={`c:${id}`} commit={entry.commit} wsId={wsId} graphId={pr.graphId} userNames={commitsQ.data?.userNames}
              expanded={expanded === id} onToggle={(cid) => setExpanded((p) => (p === cid ? null : cid))} />
          )
        }
        const e = entry.event
        if (e.kind === 'reviewed' && e.verdict) {
          const v = VERDICT[e.verdict]
          const tally = e.tally
          const groups = e.groups.map((g) => groupNames[g] ?? g)
          return (
            <li key={`e:${i}`} className="relative">
              <span className={cn('absolute -left-[1.36rem] top-2 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', v.tint)} />
              <article aria-label={`${person(e.actor)}: ${v.label}`} className="rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-2.5">
                <p className="flex items-center gap-1.5 flex-wrap text-[12.5px] text-ink">
                  <v.Icon className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                  <span className="font-semibold">{person(e.actor)}</span>
                  <Badge tone={v.tone} size="sm">{v.label}</Badge>
                  {groups.length > 0 && <span className="text-[11.5px] text-ink-muted">for {list(groups)}</span>}
                </p>
                {e.body && <p className="mt-1.5 text-[12.5px] text-ink-secondary whitespace-pre-wrap break-words leading-relaxed">{e.body}</p>}
                {tally && (tally.accepted > 0 || tally.rejected > 0 || tally.threads > 0) && (
                  <p className="mt-1.5 text-[11.5px] text-ink-muted tabular-nums">
                    {[`accepted ${tally.accepted.toLocaleString()}`, `rejected ${tally.rejected.toLocaleString()}`,
                      `${tally.threads.toLocaleString()} thread${tally.threads === 1 ? '' : 's'}`].join(' · ')}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-ink-muted"><DateTime at={e.at} /></p>
              </article>
            </li>
          )
        }
        const l = line(e)
        if (!l) return null
        return (
          <li key={`e:${i}`} className="relative">
            <span className={cn('absolute -left-[1.36rem] top-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', l.tint)} />
            <p className="text-[12.5px] text-ink leading-snug flex items-start gap-1.5">
              <l.Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> <span className="min-w-0 break-words">{l.text}</span>
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5"><DateTime at={e.at} /></p>
          </li>
        )
      })}
    </ol>
  )
}
