/**
 * BootstrapReviewSection — the enable copy is paused because the source holds what version history
 * can't keep exactly as it is. Said plainly, with the affected items, and what a manager can do:
 *
 *  • connections the source holds more than once with different properties (history keeps one
 *    connection per source, type and target): merge the copies — every property, a value picked
 *    where they disagree — or keep the first; leave properties out; or review them one by one
 *    (ConnectionCopiesResolver);
 *  • values history can't store as they are (NaN, ±Infinity, a NUL character): store them as text.
 *
 * Or fix the source and re-check it, or give up — the same as the duplicate-identifier pause. The
 * decision is bound to the list shown (its fingerprint) and recorded, with a reason, in activity.
 * Nothing goes live until it is made, and the source graph is never changed by it.
 */
import { useState } from 'react'
import {
  AlertTriangle, ArrowRight, Check, Download, GitMerge, Hourglass, ListChecks, Loader2, Plus, RefreshCw, Trash2, Type, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'
import {
  BootstrapDecisionError, bootstrapReviewCsvUrl, type BootstrapJob, type BootstrapReviewValue,
} from '@/services/versioningApiService'
import { useDecideBootstrapReview } from '../hooks/useVersioning'
import { ConnectionCopiesResolver } from './ConnectionCopiesResolver'

const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString() : '—')

const PROBLEM: Record<BootstrapReviewValue['problem'], string> = {
  nan: 'not a number (NaN)',
  infinity: 'an infinite number',
  nul: 'text with NUL characters',
  unsupported: 'a kind of value JSON has no form for',
}

function problems(byProblem: Partial<Record<BootstrapReviewValue['problem'], number>>): string {
  return (Object.entries(byProblem) as Array<[BootstrapReviewValue['problem'], number]>)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${num(n)} ${PROBLEM[p] ?? p}`)
    .join(', ')
}

function where(v: BootstrapReviewValue): string {
  if (v.entityKind === 'node') return v.name || v.entityId
  return [v.source, v.edgeType, v.target].filter(Boolean).join(' → ') || v.entityId
}

export function BootstrapReviewSection({
  job, wsId, dataSourceId, variant, canManage, confirmBox, confirming, onAsk,
}: {
  job: BootstrapJob
  wsId: string
  dataSourceId: string
  variant: 'bar' | 'card'
  canManage: boolean
  /** The progress card's own confirm (restart, give up), shown when one of them is asked. */
  confirmBox: React.ReactNode
  confirming: boolean
  onAsk: (what: 'restart' | 'abandon') => void
}) {
  const review = job.review!
  const { notify } = useAppNotifications()
  const decide = useDecideBootstrapReview(wsId, dataSourceId)
  const reason = useReasonDraft('review')
  const heldConnections = review.copies.connections
  const heldValues = review.values.count
  const [rule, setRule] = useState<'keep_first' | 'merge' | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [newExclusion, setNewExclusion] = useState('')
  const [asText, setAsText] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [confirmingContinue, setConfirmingContinue] = useState(false)
  const [listChanged, setListChanged] = useState(false)
  const ready = (!heldConnections || rule !== null) && (!heldValues || asText)
  const policy = rule ? { rule, excludeProperties: excluded } : null
  // What a manager decides, in order, each ticked once decided: the guide through the review.
  const steps = [
    ...(heldConnections ? [{ id: 'copies', label: 'Connections held more than once', done: rule !== null }] : []),
    ...(heldValues ? [{ id: 'values', label: 'Values to store as text', done: asText }] : []),
    { id: 'go', label: 'Continue', done: false },
  ]
  const current = steps.findIndex((st) => !st.done)

  const addExclusion = () => {
    const name = newExclusion.trim()
    if (name && !excluded.includes(name)) setExcluded([...excluded, name].sort())
    setNewExclusion('')
  }

  const runContinue = (why?: string) => {
    setListChanged(false)
    decide.mutate({
      fingerprint: review.fingerprint,
      ...(heldConnections && rule ? { copies: { rule, excludeProperties: excluded } } : {}),
      ...(heldValues ? { values: 'as_text' as const } : {}),
      reason: why,
    }, {
      onSuccess: () => notify('success', 'Copying them as decided — the copy carries on.'),
      onError: (e) => {
        if (e instanceof BootstrapDecisionError && e.type === 'stale_decision') setListChanged(true)
        else notify('error', e instanceof Error ? e.message : 'Could not decide.')
      },
    })
  }

  const listClass = cn(
    'mt-1.5 overflow-y-auto rounded-lg border border-glass-border divide-y divide-glass-border',
    variant === 'bar' ? 'max-h-28' : 'max-h-48',      // the canvas strip must not swallow the canvas
  )

  return (
    <>
      <div className="flex items-start gap-2.5">
        <ListChecks className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink leading-snug">Some of the source can’t be kept exactly as it is</p>
          <p className="text-[12px] text-ink-muted leading-snug">
            The copy is paused before anything goes live, so nothing is lost and the source graph is not
            changed. A manager decides how to copy what’s below — or fixes it in the source and re-checks it.
          </p>
        </div>
      </div>
      {canManage && (
        <ol className="mt-3 flex items-center gap-1.5 flex-wrap" aria-label="Review steps">
          {steps.map((st, i) => (
            <li key={st.id} className="inline-flex items-center gap-1.5"
              aria-current={i === current ? 'step' : undefined}>
              {i > 0 && <span className="w-4 h-px bg-glass-border" aria-hidden />}
              <span className={cn(
                'inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold',
                st.done ? 'bg-emerald-500 text-white'
                  : i === current ? 'bg-accent-lineage text-white' : 'bg-black/[0.06] dark:bg-white/[0.08] text-ink-muted',
              )}>
                {st.done ? <Check className="w-2.5 h-2.5" aria-hidden /> : i + 1}
              </span>
              <span className={cn('text-[11px]', i === current ? 'font-semibold text-ink' : 'text-ink-muted')}>
                {st.label}{st.done && <span className="sr-only"> (decided)</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {listChanged && (
        <p role="alert" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-ink">
          What the copy held changed — review it again before deciding.
        </p>
      )}

      {/* ── connections held more than once ─────────────────────────────────────── */}
      {heldConnections > 0 && (
        <section className="mt-3" aria-label="Connections held more than once">
          <p className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
            <GitMerge className="w-3.5 h-3.5 text-amber-500" />
            {num(heldConnections)} {heldConnections === 1 ? 'connection is' : 'connections are'} in the source more
            than once, with different properties
          </p>
          <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
            {num(review.copies.copies)} copies in {num(review.copies.versions)} versions. Version history keeps one
            connection per source, type and target, so it needs to know what to keep.
          </p>
          <ul className={listClass}>
            {review.copies.sample.map((c) => (
              <li key={c.entityId} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 truncate font-mono text-ink-secondary" title={c.source ?? ''}>{c.source}</span>
                <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
                <span className="shrink-0 text-ink-muted">{c.edgeType}</span>
                <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-ink-secondary" title={c.target ?? ''}>{c.target}</span>
                <span className="shrink-0 text-ink-muted tabular-nums">{num(c.copies)} copies · {num(c.versions)} versions</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {review.copies.sample.length < heldConnections && (
              <>Showing {num(review.copies.sample.length)} of {num(heldConnections)} · </>
            )}
            <a
              href={bootstrapReviewCsvUrl(wsId, dataSourceId, 'copies')}
              download={`connections-held-more-than-once-${dataSourceId}.csv`}
              className="inline-flex items-center gap-1 font-medium text-accent-lineage hover:underline"
            >
              <Download className="w-3 h-3" /> Download every version (CSV)
            </a>
          </p>
          {canManage && (
            <fieldset className="mt-2 space-y-1.5" disabled={decide.isPending}>
              <legend className="sr-only">How to copy these connections</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Option name="review-rule" checked={rule === 'merge'} onChange={() => setRule('merge')}
                  title="Merge the copies" badge="Keeps the most">
                  Every property any of them holds; where they disagree, the first copy’s value, unless you
                  pick another
                </Option>
                <Option name="review-rule" checked={rule === 'keep_first'} onChange={() => setRule('keep_first')}
                  title="Keep the first copy of each">
                  The other copies’ properties are not kept in history (they stay in the source graph)
                </Option>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <span className="text-[11px] text-ink-muted">Leave these properties out:</span>
                {excluded.map((name) => (
                  <span key={name} className="inline-flex items-center gap-1 rounded bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-mono text-ink-secondary">
                    {name}
                    <button type="button" aria-label={`Keep ${name}`} onClick={() => setExcluded(excluded.filter((x) => x !== name))}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={newExclusion} onChange={(e) => setNewExclusion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExclusion() } }}
                  placeholder="property name" aria-label="Property to leave out"
                  className="w-32 px-1.5 py-0.5 rounded border border-glass-border bg-canvas text-[11px] text-ink placeholder:text-ink-muted/50"
                />
                <button type="button" onClick={addExclusion} aria-label="Leave this property out"
                  className="p-0.5 rounded text-ink-muted hover:text-ink">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              <button
                type="button" onClick={() => setResolving(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-accent-lineage border border-accent-lineage/30 hover:bg-accent-lineage/[0.06] transition-colors"
              >
                <ListChecks className="w-3.5 h-3.5" /> Review the connections one by one
              </button>
            </fieldset>
          )}
        </section>
      )}

      {/* ── values history can't store as they are ──────────────────────────────── */}
      {heldValues > 0 && (
        <section className="mt-3" aria-label="Values that can't be stored as they are">
          <p className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
            <Type className="w-3.5 h-3.5 text-amber-500" />
            {num(heldValues)} {heldValues === 1 ? 'value' : 'values'} can’t be stored as {heldValues === 1 ? 'it is' : 'they are'}
          </p>
          <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
            {problems(review.values.byProblem)}. Version history stores values as JSON, which has no form for
            these — they can be stored as text, as shown.
          </p>
          <ul className={listClass}>
            {review.values.sample.map((v) => (
              <li key={`${v.entityId} ${v.seq}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink-secondary" title={v.entityId}>{where(v)}</span>
                <span className="shrink-0 font-mono text-ink-muted">{v.property}</span>
                <span className="shrink-0 text-ink-muted">{PROBLEM[v.problem] ?? v.problem}</span>
                <span className="shrink-0 text-ink">→ <span className="font-mono">{JSON.stringify(v.storedAs)}</span></span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {review.values.sample.length < heldValues && <>Showing {num(review.values.sample.length)} of {num(heldValues)} · </>}
            <a
              href={bootstrapReviewCsvUrl(wsId, dataSourceId, 'values')}
              download={`values-stored-as-text-${dataSourceId}.csv`}
              className="inline-flex items-center gap-1 font-medium text-accent-lineage hover:underline"
            >
              <Download className="w-3 h-3" /> Download every value (CSV)
            </a>
          </p>
          {canManage && (
            <div className="mt-2 sm:max-w-[50%]">
              <Option type="checkbox" checked={asText} disabled={decide.isPending}
                onChange={(on) => setAsText(on)} title="Store them as text">
                As shown — or change them in the source and re-check it
              </Option>
            </div>
          )}
        </section>
      )}

      {canManage && confirmBox}
      {canManage && confirmingContinue && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5">
          <p className="text-[12px] text-ink leading-relaxed">
            {heldConnections > 0 && rule && (
              <>
                {num(heldConnections)} connection(s) are copied {rule === 'merge' ? 'merged' : 'as their first copy'}, unless
                you chose otherwise for one{excluded.length > 0 && <>, without {excluded.join(', ')}</>}.{' '}
              </>
            )}
            {heldValues > 0 && <>{num(heldValues)} value(s) are stored as text. </>}
            <span className="font-semibold">The source graph is not changed</span>, every version stays listed as the
            record, and the decision is recorded in the workspace activity.
          </p>
          <ReasonField draft={reason} audience="workspace" className="mt-2.5" />
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => { const why = reason.take(); setConfirmingContinue(false); runContinue(why) }}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white shadow-sm transition-colors bg-amber-600 hover:bg-amber-700"
            >
              Yes, continue
            </button>
            <button
              onClick={() => { reason.reset(); setConfirmingContinue(false) }}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {canManage && !confirming && !confirmingContinue && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { reason.reset(); setConfirmingContinue(true) }}
            disabled={!ready || decide.isPending}
            title={ready ? undefined : 'Say how to copy each kind of thing held first'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
          >
            {decide.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />}
            Continue with these choices
          </button>
          <button
            onClick={() => onAsk('restart')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-ink transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Re-check source
          </button>
          <button
            onClick={() => onAsk('abandon')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted border border-glass-border hover:text-rose-500 hover:border-rose-500/30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Give up
          </button>
        </div>
      )}
      {canManage && !ready && !confirming && !confirmingContinue && (
        <p className="mt-1.5 text-[11px] text-ink-muted inline-flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 text-amber-500" />
          {heldConnections > 0 && rule === null ? 'Choose how to copy the connections' : 'Say how to store the values'} to continue.
        </p>
      )}
      {!canManage && (
        <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
          <Hourglass className="w-3.5 h-3.5 shrink-0" />
          Waiting for a workspace manager to decide how these are copied.
        </p>
      )}
      {resolving && (
        <ConnectionCopiesResolver wsId={wsId} dataSourceId={dataSourceId} policy={policy} onClose={() => setResolving(false)} />
      )}
    </>
  )
}

/** One choice a manager makes, as a card: its native radio or checkbox inside a label, so it reads
 *  and works as one (keyboard and screen readers included), with the chosen one outlined. */
function Option({
  type = 'radio', name, checked, disabled, onChange, title, badge, children,
}: {
  type?: 'radio' | 'checkbox'
  name?: string
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <label className={cn(
      'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] cursor-pointer transition-colors',
      checked ? 'border-accent-lineage/50 bg-accent-lineage/[0.06] ring-1 ring-accent-lineage/20'
        : 'border-glass-border hover:border-accent-lineage/30',
      disabled && 'opacity-60 cursor-default',
    )}>
      <input type={type} name={name} className="mt-0.5 accent-indigo-500"
        checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-medium text-ink">
          {title}
          {badge && (
            <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              {badge}
            </span>
          )}
        </span>
        <span className="block text-[11px] text-ink-muted leading-snug">{children}</span>
      </span>
    </label>
  )
}
