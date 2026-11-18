/**
 * ReviewSide — beside the change: what the review still needs (What's next), who was asked to
 * review it and where each stands (and, for whoever may, who is asked), then its Discussion and
 * what happened on it (Activity).
 */
import type { ReactNode } from 'react'
import { CheckCircle2, Circle, Clock, MessageSquare, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { ReviewDiscussion } from '../comments/ReviewDiscussion'
import type { ReviewActions } from '../hooks/useReviewActions'
import type { ActionKind, ReadinessItem } from './readiness'
import { ReviewersEditor } from './ReviewersEditor'
import { ReviewTimeline } from './ReviewTimeline'

export type SideTab = 'discussion' | 'activity'

function Heading({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
      <Icon className="w-3.5 h-3.5" aria-hidden /> {children}
    </h2>
  )
}

/** What the review still needs, each with what to do about it. */
export function WhatsNextPanel({ items, onAct, busy, custom }: {
  items: ReadinessItem[]
  onAct: (kind: ActionKind) => void
  busy?: boolean
  /** An action that is a control of its own (Update from parent); null: none here. */
  custom?: Partial<Record<ActionKind, ReactNode>>
}) {
  if (items.length === 0) return null
  return (
    <section aria-label="What’s next">
      <Heading icon={CheckCircle2}>What’s next</Heading>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.key} className="flex items-start gap-2 rounded-lg px-2 py-1.5 bg-black/[0.02] dark:bg-white/[0.03]">
            {it.ok
              ? <CheckCircle2 className="w-4 h-4 mt-px shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Done" />
              : <Circle className="w-4 h-4 mt-px shrink-0 text-ink-muted/70" aria-label="Not yet" />}
            <div className="min-w-0 flex-1">
              <p className={cn('text-[12.5px] leading-snug', it.ok ? 'text-ink-secondary' : 'font-medium text-ink')}>{it.title}</p>
              {it.detail && <p className="text-[11.5px] text-ink-muted leading-snug mt-0.5 break-words">{it.detail}</p>}
            </div>
            {it.action && !it.ok && (custom && it.action.kind in custom ? custom[it.action.kind] : (
              <button type="button" disabled={busy} onClick={() => onAct(it.action!.kind)}
                className="shrink-0 px-2 h-6 rounded-md text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 disabled:opacity-50">
                {it.action.label}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Who was asked to review it, and where each stands. */
export function ReviewersCard({ wsId, actions }: { wsId: string; actions: ReviewActions }) {
  if (!actions.pr) return null
  return (
    <section aria-label="Reviewers">
      <Heading icon={ShieldCheck}>Reviewers</Heading>
      <ReviewersEditor wsId={wsId} actions={actions} />
    </section>
  )
}

export function ReviewSide({ wsId, prId, actions, items, onAct, custom, tab, onTab, focusThreadId }: {
  wsId: string
  prId: string
  actions: ReviewActions
  items: ReadinessItem[]
  onAct: (kind: ActionKind) => void
  custom?: Partial<Record<ActionKind, ReactNode>>
  tab: SideTab
  onTab: (tab: SideTab) => void
  /** A thread on the review as a whole a link opened. */
  focusThreadId?: string | null
}) {
  const { pr, listOrigin, discussion, rejected } = actions
  if (!pr) return null
  return (
    <div className="p-4 sm:p-5 space-y-6">
      <div className="space-y-2">
        <WhatsNextPanel items={items} onAct={onAct} busy={actions.busy} custom={custom} />
        {/* Merging what is accepted: the rejected ones can leave the draft in the same step. */}
        {actions.mergeInPart && rejected > 0 && actions.canMerge && !actions.sentBack && !actions.needsPull && (
          <label className="flex items-start gap-2 px-2 text-[12px] text-ink-secondary cursor-pointer select-none">
            <input type="checkbox" checked={actions.discardOnMerge} onChange={(e) => actions.setDiscardOnMerge(e.target.checked)}
              className="mt-0.5 rounded border-glass-border text-accent-lineage focus:ring-accent-lineage/40" />
            <span>
              Also discard the {rejected.toLocaleString()} rejected change{rejected === 1 ? '' : 's'} from the draft
              <span className="text-ink-muted"> — only what nobody decided stays on it</span>
            </span>
          </label>
        )}
      </div>
      <ReviewersCard wsId={wsId} actions={actions} />
      <Tabs value={tab} onValueChange={(v) => onTab(v as SideTab)}>
        <TabsList look="underline">
          <TabsTrigger value="discussion" icon={MessageSquare}>Discussion</TabsTrigger>
          <TabsTrigger value="activity" icon={Clock}>Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="discussion" className="pt-3">
          <ReviewDiscussion wsId={wsId} prId={prId} graphId={pr.graphId} origin={listOrigin}
            access={discussion} focusThreadId={focusThreadId} />
        </TabsContent>
        <TabsContent value="activity" className="pt-3">
          <ReviewTimeline wsId={wsId} pr={pr} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
