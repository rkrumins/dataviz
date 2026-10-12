/**
 * When an import goes live: at once, or with a draft of its version-controlled data source, after
 * review. Shown only where there is a choice (the data source is under version control); without
 * the right to open drafts there, the draft option says why it can't be chosen.
 */
import { GitPullRequestDraft, Info, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BRANCH_VOCAB } from '@/features/versioning/model/branchVocab'
import type { DraftStaging } from './useDraftStaging'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'

export function StageChoice({ staging, stage, onChange, kind, count = 1, wantsEveryone = false }: {
  staging: DraftStaging
  stage: boolean
  onChange: (stage: boolean) => void
  /** A new view (create, copy) gets a draft of its own; an update goes into the person's draft
   *  for that view. */
  kind: 'new' | 'update' | 'mixed'
  /** How many views this decides for. */
  count?: number
  /** Publishing to everyone was asked for: it waits until the view is live. */
  wantsEveryone?: boolean
}) {
  if (!staging.versioned) return null
  const several = count > 1
  const where = kind === 'new'
    ? (several ? 'Each view gets a draft of its own' : 'It gets a draft of its own')
    : kind === 'update'
      ? (several ? 'Each goes into your draft for that view' : 'It goes into your draft for this view')
      : 'Each goes into a draft for its view'
  const options = [
    {
      value: false, icon: Zap, title: 'Now',
      detail: kind === 'new' ? 'Written at once.' : 'Written at once: the view changes for everyone who can open it.',
      disabled: false,
    },
    {
      value: true, icon: GitPullRequestDraft, title: 'In a draft, after review',
      detail: `${where}, and goes live when the draft is published or its ${BRANCH_VOCAB.reviewRequest.toLowerCase()} merges.`
        + (kind !== 'update' ? ' Until then it’s private and in no list.' : ' Until then the view here is unchanged.'),
      disabled: !staging.allowed,
    },
  ]
  return (
    <div className="rounded-2xl border border-glass-border p-4 space-y-3">
      <div>
        <p className="text-sm font-bold text-ink">When {several ? 'they go' : 'it goes'} live</p>
        <p className="text-[11px] text-ink-muted mt-0.5">This data source is under version control, so {several ? 'these views' : 'this view'} can go through review like any other change to it.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="When it goes live" onKeyDown={onRadioGroupKeyDown}>
        {options.map(o => {
          const selected = stage === o.value
          const Icon = o.icon
          return (
            <button key={o.title} type="button" role="radio" aria-checked={selected} disabled={o.disabled}
              tabIndex={selected ? 0 : -1} onClick={() => onChange(o.value)}
              className={cn('text-left rounded-xl border px-3 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                selected ? 'border-indigo-500 bg-indigo-500/[0.06] ring-1 ring-indigo-500/30'
                  : 'border-glass-border hover:border-indigo-300 dark:hover:border-indigo-700')}>
              <span className="flex items-center gap-2 text-xs font-semibold text-ink">
                <Icon className={cn('w-3.5 h-3.5', selected ? 'text-indigo-500' : 'text-ink-muted')} /> {o.title}
              </span>
              <span className="block text-[11px] text-ink-muted mt-1 leading-relaxed">{o.detail}</span>
            </button>
          )
        })}
      </div>
      {!staging.allowed && (
        <p className="flex items-start gap-1.5 text-[11px] text-ink-muted">
          <Info className="w-3 h-3 mt-0.5 shrink-0" /> Opening drafts on this data source needs permission to manage it.
        </p>
      )}
      {stage && wantsEveryone && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/20 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          Publishing to everyone waits until it’s live: it goes live shared with its workspace, and you can ask to publish it from Share.
        </p>
      )}
    </div>
  )
}
