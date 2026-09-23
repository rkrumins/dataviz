/**
 * The import, summed up on the Preview step: what will happen, to what, how well it matched,
 * which choices were made on the way, and what the import will prove about itself.
 */
import { CopyPlus, Fingerprint, GitMerge, GitPullRequestDraft, Info, PlusCircle, Replace, ShieldAlert, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IntegrityBadge } from '@/features/view-transfer/BundleDropzone'
import { MatchScoreRing } from '@/features/view-transfer/reconcile/MatchScoreRing'
import { percent, pluralize, shortHash } from '@/features/view-transfer/format'
import type { ImportViewResult } from '@/services/viewTransferApiService'
import { useImportSession } from './importSession'

export function ImportSummaryCard({ targetLabel, editedSinceCheck, staged = false }: {
  targetLabel: string
  /** The design was changed in the wizard after the Match step checked it. */
  editedSinceCheck: boolean
  /** It waits in a draft, to go live with it. */
  staged?: boolean
}) {
  const session = useImportSession()
  if (!session?.reconcile || !session.action || !session.inspect) return null
  const { reconcile, action, targetView, inspect, resolutions, strategy } = session
  const summary = reconcile.report.summary
  const head = reconcile.update?.targetHead?.version ?? targetView?.headVersion ?? null
  const environment = inspect.bundle.generator.environment

  const what = {
    create: { icon: PlusCircle, text: <>Create a new view in <span className="font-semibold text-ink">{targetLabel}</span></> },
    copy: { icon: CopyPlus, text: <>Create a separate copy in <span className="font-semibold text-ink">{targetLabel}</span>, with its own identity</> },
    update: {
      icon: GitMerge,
      text: <>Update <span className="font-semibold text-ink">{targetView?.name}</span>{head ? <> from v{head} to v{head + 1}</> : null}, by {strategy === 'merge' ? 'merging' : 'replacing its design'}</>,
    },
    overwrite: {
      icon: Replace,
      text: <>Overwrite <span className="font-semibold text-ink">{targetView?.name}</span>{head ? <> (its v{head} is kept)</> : null}; it then tracks this file’s view</>,
    },
  }[action]
  const WhatIcon = what.icon
  const choices: string[] = []
  if (resolutions.drop?.length) choices.push(`${resolutions.drop.length.toLocaleString()} dropped`)
  const remapped = Object.keys(resolutions.remap ?? {}).length
  if (remapped) choices.push(`${remapped.toLocaleString()} remapped`)
  const typeChoices = Object.keys(resolutions.typeMap ?? {}).length + (resolutions.dropTypes?.length ?? 0)
    + Object.keys(resolutions.relTypeMap ?? {}).length + (resolutions.dropRelTypes?.length ?? 0)
  if (typeChoices) choices.push(pluralize(typeChoices, 'type decision'))
  const missing = summary.entities.missing

  return (
    <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/60 to-transparent dark:from-indigo-950/20 p-5 mb-6">
      <div className="flex items-center gap-5">
        <MatchScoreRing rate={summary.matchRate} verdict={summary.verdict} size={96} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="flex items-start gap-2 text-sm text-ink-secondary">
            <WhatIcon className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
            <span>{what.text}{staged ? <>, <span className="font-semibold text-ink">in a draft</span> until it’s published</> : null}.</span>
          </p>
          <p className="text-xs text-ink-muted">
            {summary.entities.found.toLocaleString()} of {summary.entities.checked.toLocaleString()} entities found ({percent(summary.matchRate)})
            {missing ? ` · ${missing.toLocaleString()} kept, marked not found` : ''}
            {choices.length ? ` · ${choices.join(', ')}` : ''}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <IntegrityBadge integrity={inspect.integrity} environment={environment} />
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary')}>
              <ShieldCheck className="w-3 h-3" /> {staged ? 'A version, with where it came from, once it’s live' : 'Saved as a version, with where it came from'}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary">
              <Fingerprint className="w-3 h-3" /> The import proves what it stored
            </span>
          </div>
          {editedSinceCheck && (
            <p className="text-[11px] text-ink-muted">
              You changed the design after it was checked; the import checks everything again and records the final result.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** After the import: what was stored, proven — or what this environment changed, and why. */
export function ImportResultNote({ result }: { result: ImportViewResult }) {
  const { integrity, notices } = result
  return (
    <div className="max-w-xl mx-auto mt-6 space-y-2">
      {result.staged && (
        <div className="flex items-start gap-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 px-4 py-3">
          <GitPullRequestDraft className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
          <div className="min-w-0 text-xs">
            <p className="font-semibold text-ink">Waiting in a draft</p>
            <p className="text-ink-secondary mt-0.5">
              {result.version
                ? 'It’s private and in no list until the draft is published or its review request merges.'
                : 'The view here is unchanged until the draft is published or its review request merges.'}
              {' '}Open the draft to look it over, then publish it or send it for review.
            </p>
          </div>
        </div>
      )}
      <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3',
        integrity.verified ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20'
          : 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20')}>
        {integrity.verified
          ? <ShieldCheck className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
          : <ShieldAlert className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />}
        <div className="min-w-0 text-xs">
          <p className="font-semibold text-ink">
            {integrity.verified ? 'Integrity verified: exactly what was sent was stored' : 'Stored with adjustments this environment requires'}
          </p>
          <p className="text-ink-muted mt-0.5 font-mono truncate" title={integrity.storedHash}>
            sha256:{shortHash(integrity.storedHash, 16)}
          </p>
          {integrity.adjustments.map(a => <p key={a} className="text-ink-secondary mt-1">{a}</p>)}
        </div>
      </div>
      {notices.map(n => (
        <p key={n} className="flex items-start gap-2 rounded-xl border border-glass-border px-4 py-2.5 text-xs text-ink-secondary">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-500" /> {n}
        </p>
      ))}
    </div>
  )
}
