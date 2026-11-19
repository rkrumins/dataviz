/**
 * Deciding a draft's review change by change: the controls a change list shows in a review.
 *
 * - `useDecisionFlow` decides, and says what it decided with it ("and 2 it needs", Undo); when a
 *   decision would reverse one made on a change it takes with it, it asks first; deciding every
 *   change shown asks first too, saying how many and what they take with them.
 * - `DecisionBanner` is where it says so (above the list).
 * - `DecisionFilter` narrows the list: to decide, accepted, rejected, changed since.
 * - `RowDecision` is a change's own: Accept / Reject (asking why), or what was decided, by whom,
 *   with what — and changing it.
 */
import { useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, History, Loader2, RotateCcw, X, XCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Segmented } from '@/components/ui/Segmented'
import {
  HeadMovedError, ReviewDecisionError,
  type DecisionFilter as Filter, type DecisionState, type DecisionVerdict, type ReviewDecision, type ReviewDecisionSummary,
} from '@/services/versioningApiService'
import { DECISION_KEYS, useDecideChanges } from './useReviewDecisions'

type Target = { entityIds: string[] } | { filter: Filter }
type Notice =
  | { kind: 'done'; text: string; undo?: Target }
  | { kind: 'confirm'; text: string; detail?: string; action: string; verdict: DecisionVerdict; target: Target; reason?: string | null }
  | { kind: 'error'; text: string }

const VERB: Record<DecisionVerdict, string> = { accepted: 'Accepted', rejected: 'Rejected' }
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export function useDecisionFlow(wsId: string, prId: string, headCommitId?: string | null) {
  const decide = useDecideChanges(wsId, prId)
  const qc = useQueryClient()
  const [notice, setNotice] = useState<Notice | null>(null)

  const failed = (e: unknown) => {
    if (e instanceof HeadMovedError) {
      void qc.invalidateQueries({ queryKey: DECISION_KEYS.all(wsId, prId) })
      setNotice({ kind: 'error', text: 'The draft changed since you loaded it — its changes were read again. Decide again.' })
      return
    }
    setNotice({ kind: 'error', text: (e as Error).message || 'Couldn’t save that decision.' })
  }

  const run = async (verdict: DecisionVerdict | null, target: Target, reason?: string | null, force = false) => {
    try {
      const out = await decide.mutateAsync({ verdict, ...target, reason, expectedHeadCommitId: headCommitId, force })
      if (verdict && out.impliedCount > 0) {
        setNotice({
          kind: 'done', undo: target,
          text: `${VERB[verdict]} ${plural(out.decided, 'change')}, and ${out.impliedCount.toLocaleString()} ${verdict === 'accepted' ? 'it needs' : 'that need it'}.`,
        })
      } else if (verdict && out.decided > 1) {
        setNotice({ kind: 'done', undo: target, text: `${VERB[verdict]} ${plural(out.decided, 'change')}.` })
      } else {
        setNotice(null)
      }
    } catch (e) {
      if (e instanceof ReviewDecisionError && e.type === 'decision_conflict' && verdict) {
        const n = Number(e.detail.count ?? 0)
        setNotice({
          kind: 'confirm', verdict, target, reason,
          text: `That reverses ${plural(n, 'decision')} made on changes it takes with it.`,
          detail: verdict === 'accepted' ? 'They were rejected; accepting this accepts them too.' : 'They were accepted; rejecting this rejects them too.',
          action: verdict === 'accepted' ? 'Accept anyway' : 'Reject anyway',
        })
        return
      }
      failed(e)
    }
  }

  /** Every change shown, asked first: how many, what they take with them, what it reverses. */
  const all = async (verdict: DecisionVerdict, filter: Filter) => {
    try {
      const out = await decide.mutateAsync({ verdict, filter, dryRun: true, expectedHeadCommitId: headCommitId })
      if (out.decided === 0) return
      const total = out.decided + out.impliedCount
      setNotice({
        kind: 'confirm', verdict, target: { filter },
        text: `${verdict === 'accepted' ? 'Accept' : 'Reject'} ${plural(out.decided, 'change')} shown${out.impliedCount
          ? `, and ${out.impliedCount.toLocaleString()} ${verdict === 'accepted' ? 'they need' : 'that need them'}` : ''}?`,
        detail: out.overrideCount ? `${plural(out.overrideCount, 'change')} decided otherwise will be reversed.` : undefined,
        action: `${verdict === 'accepted' ? 'Accept' : 'Reject'} ${total.toLocaleString()}`,
      })
    } catch (e) {
      failed(e)
    }
  }

  const confirm = () => {
    if (notice?.kind !== 'confirm') return
    void run(notice.verdict, notice.target, notice.reason, true)
  }
  const undo = () => {
    if (notice?.kind !== 'done' || !notice.undo) return
    void run(null, notice.undo)
  }
  return { run, all, notice, confirm, undo, dismiss: () => setNotice(null), busy: decide.isPending }
}

export function DecisionBanner({ flow }: { flow: ReturnType<typeof useDecisionFlow> }) {
  const n = flow.notice
  if (!n) return <div aria-live="polite" className="sr-only" />
  const tone = n.kind === 'error' ? 'border-rose-500/25 bg-rose-500/[0.05] text-rose-700 dark:text-rose-300'
    : n.kind === 'confirm' ? 'border-amber-500/30 bg-amber-500/[0.06] text-ink'
      : 'border-emerald-500/25 bg-emerald-500/[0.05] text-ink'
  const btn = 'inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[12px] font-semibold'
  return (
    <div role={n.kind === 'confirm' ? 'alertdialog' : 'status'} aria-live="polite"
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2 text-[12px]', tone)}>
      {n.kind === 'confirm' ? <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-300 shrink-0" aria-hidden />
        : n.kind === 'error' ? <XCircle className="w-4 h-4 shrink-0" aria-hidden />
          : <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-300 shrink-0" aria-hidden />}
      <span className="flex-1 min-w-[12rem]">
        <span className="font-medium">{n.text}</span>
        {n.kind === 'confirm' && n.detail && <span className="block text-[11.5px] text-ink-muted mt-0.5">{n.detail}</span>}
      </span>
      {n.kind === 'confirm' ? (
        <>
          <button type="button" onClick={flow.dismiss} className={cn(btn, 'text-ink-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.08]')}>Cancel</button>
          <button type="button" onClick={flow.confirm} disabled={flow.busy}
            className={cn(btn, 'text-white disabled:opacity-60', n.verdict === 'accepted' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700')}>
            {flow.busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}{n.action}
          </button>
        </>
      ) : (
        <>
          {n.kind === 'done' && n.undo && (
            <button type="button" onClick={flow.undo} disabled={flow.busy} className={cn(btn, 'text-ink-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.08]')}>
              <RotateCcw className="w-3.5 h-3.5" aria-hidden />Undo
            </button>
          )}
          <button type="button" onClick={flow.dismiss} aria-label="Dismiss" className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  )
}

export function DecisionFilter({ value, onChange, summary }: {
  value: DecisionState | null
  onChange: (v: DecisionState | null) => void
  summary?: ReviewDecisionSummary | null
}) {
  type Opt = DecisionState | 'all'
  const options: { value: Opt; label: string; count?: number }[] = [
    { value: 'all', label: 'All' },
    { value: 'undecided', label: 'To decide', count: summary?.undecided },
    { value: 'accepted', label: 'Accepted', count: summary?.accepted },
    { value: 'rejected', label: 'Rejected', count: summary?.rejected },
  ]
  if (summary?.stale) options.push({ value: 'stale', label: 'Changed since', count: summary.stale })
  return (
    <Segmented<Opt> label="Decision" value={value ?? 'all'} onChange={(v) => onChange(v === 'all' ? null : v)} options={options} />
  )
}

/** A change's decision in its row: Accept / Reject, or what was decided — and undoing it.
 *  Reject opens the row's `RejectReason` (`onAsk`). */
export function RowDecision({ decision, canDecide, busy, label, impliedLabel, names, asking, onAsk, onDecide }: {
  decision: ReviewDecision | null
  canDecide: boolean
  busy?: boolean
  /** The change, as its row names it. */
  label: string
  /** What it was decided with, by name. */
  impliedLabel?: string | null
  names?: Record<string, string>
  asking: boolean
  onAsk: (asking: boolean) => void
  onDecide: (verdict: DecisionVerdict | null, reason?: string | null) => void
}) {
  const held = decision && !decision.stale ? decision : null
  const who = decision ? (names?.[decision.actor] ?? 'a reviewer') : ''
  const iconBtn = 'w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40'

  if (held) {
    return (
      <HoverTip
        label={`${held.verdict === 'accepted' ? 'Accepted' : 'Rejected'} by ${who}${impliedLabel ? `, with ${impliedLabel}` : held.impliedBy ? ', with another change' : ''}`}
        detail={canDecide ? 'Click to undo.' : undefined}
        className="inline-flex shrink-0 mr-1">
        <button type="button" disabled={!canDecide || busy} onClick={() => onDecide(null)}
          aria-label={`${held.verdict === 'accepted' ? 'Accepted' : 'Rejected'}: undo the decision on ${label}`}
          className={cn('inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-bold uppercase tracking-wide disabled:cursor-default',
            held.verdict === 'accepted' ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/12 text-rose-700 dark:text-rose-300')}>
          {held.verdict === 'accepted' ? <Check className="w-3 h-3" aria-hidden /> : <X className="w-3 h-3" aria-hidden />}
          {held.verdict}
          {held.impliedBy && <span className="font-medium normal-case tracking-normal opacity-75">· with</span>}
        </button>
      </HoverTip>
    )
  }
  return (
    <div className="shrink-0 flex items-center gap-0.5 mr-1">
      {decision?.stale && (
        <HoverTip label={`Changed since it was ${decision.verdict}`} detail="Its decision no longer holds: decide again." className="inline-flex">
          <span className="inline-flex items-center gap-1 px-1.5 h-6 mr-0.5 rounded-md bg-amber-500/10 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
            <History className="w-3 h-3" aria-hidden />Changed
          </span>
        </HoverTip>
      )}
      {canDecide && (
        <>
          <HoverTip label="Accept" detail="Merge accepted lands it, with what it needs." className="inline-flex">
            <button type="button" disabled={busy} onClick={() => onDecide('accepted')} aria-label={`Accept ${label}`}
              className={cn(iconBtn, 'text-ink-muted hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-500/10')}>
              <Check className="w-4 h-4" />
            </button>
          </HoverTip>
          <HoverTip label="Reject…" detail="It stays on the draft. Say why, for its author." className="inline-flex">
            <button type="button" disabled={busy} onClick={() => onAsk(!asking)} aria-label={`Reject ${label}`} aria-expanded={asking}
              className={cn(iconBtn, 'text-ink-muted hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-500/10', asking && 'text-rose-700 dark:text-rose-300 bg-rose-500/10')}>
              <X className="w-4 h-4" />
            </button>
          </HoverTip>
        </>
      )}
    </div>
  )
}

/** Why a change is rejected — asked under its row, optional, for the draft's author. */
export function RejectReason({ label, onReject, onCancel }: {
  label: string
  onReject: (reason: string | null) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const reject = () => onReject(reason.trim() || null)
  return (
    <div role="group" aria-label={`Reject ${label}`} className="flex items-center gap-1.5 px-2.5 pb-2 pl-7">
      <input
        autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); reject() }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        placeholder="Why? Optional — its author sees it" aria-label="Why it is rejected"
        className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-canvas border border-rose-500/30 text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-rose-500/30"
      />
      <button type="button" onClick={onCancel} className="px-2 h-8 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">Cancel</button>
      <button type="button" onClick={reject} className="px-2.5 h-8 rounded-lg text-[12px] font-semibold text-white bg-rose-600 hover:bg-rose-700">Reject</button>
    </div>
  )
}
