/**
 * GuardMeter — what stops a mistaken replace import, tried on one.
 *
 * Two checks, as the import worker makes them on a graph of at least the guard's minimum size:
 * - THE REPLACE GUARD stops a replace that would delete at least its delete share of what it
 *   replaces AND make at least its create share as many again. A real cleanup deletes a lot but
 *   makes little; a file with the wrong identifier does both.
 * - THE EARLY STOP ends a replace whose first rows match fewer existing items than the match
 *   share, whether or not the guard is on (0 turns it off).
 *
 * The sample is the page's example import; drag its sliders to try another. Staged limits are
 * marked in the accent, with their own verdict.
 */
import { useState } from 'react'
import { ShieldCheck, ShieldOff, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount, formatRatio } from '@/lib/units'
import { Slider } from '@/components/ui/Slider'
import type { SampleImport } from '../types'
import { LegendKey, VisualFrame } from './VisualFrame'

export interface GuardLimits {
    enabled: boolean
    minLive: number
    deleteShare: number
    createShare: number
    minMatchShare: number
}

type Outcome = 'stopped' | 'early' | 'through' | 'unchecked'

interface Sample {
    live: number
    rows: number
    deletes: number
    creates: number
    matched: number
}

function verdict(l: GuardLimits, s: Sample): { outcome: Outcome; why: string } {
    const del = s.live ? s.deletes / s.live : 0
    const cre = s.live ? s.creates / s.live : 0
    const match = s.rows ? s.matched / s.rows : 1
    if (s.live < l.minLive) {
        return { outcome: 'unchecked', why: `Nothing checks it: the checks start at graphs of ${formatCount(l.minLive, 'items')}, and this one has ${formatCount(s.live)}.` }
    }
    if (l.minMatchShare > 0 && match < l.minMatchShare) {
        return { outcome: 'early', why: `It stops early: only ${formatRatio(match)} of its first rows match existing items, under ${formatRatio(l.minMatchShare)}.` }
    }
    if (!l.enabled) return { outcome: 'unchecked', why: 'It goes through: the replace guard is off, so nothing checks what it deletes.' }
    if (del >= l.deleteShare && cre >= l.createShare) {
        return { outcome: 'stopped', why: `It is stopped: it would delete ${formatRatio(del)} of what it replaces and make ${formatRatio(cre)} as many again, at or over ${formatRatio(l.deleteShare)} and ${formatRatio(l.createShare)}.` }
    }
    return {
        outcome: 'through',
        why: del >= l.deleteShare
            ? `It goes through: it deletes ${formatRatio(del)} but makes only ${formatRatio(cre)} again, under ${formatRatio(l.createShare)}: a cleanup, not a wrong identifier.`
            : `It goes through: it deletes ${formatRatio(del)} of what it replaces, under ${formatRatio(l.deleteShare)}.`,
    }
}

const BANNER: Record<Outcome, { icon: typeof ShieldCheck; words: string }> = {
    stopped: { icon: ShieldX, words: 'This replace would be stopped' },
    early: { icon: ShieldX, words: 'This replace would stop early' },
    through: { icon: ShieldCheck, words: 'This replace would go through' },
    unchecked: { icon: ShieldOff, words: 'Not checked' },
}

function Meter({ label, share, limit, nextLimit, floor = false, hit }: {
    label: string
    share: number
    limit: number
    nextLimit?: number
    /** The limit is a floor (at least), not a ceiling. */
    floor?: boolean
    /** This meter is why the replace stops. */
    hit: boolean
}) {
    const pct = (v: number) => `${Math.min(100, v * 100)}%`
    return (
        <div>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[11.5px]">
                <span className="font-semibold text-ink">{label}</span>
                <span className="tabular-nums text-ink-muted">
                    <span className={cn('font-semibold', hit ? 'text-rose-600 dark:text-rose-400' : 'text-ink-secondary')}>{formatRatio(share)}</span>
                    {' · '}{floor ? 'stops early under' : 'stopped at'} {formatRatio(limit)}
                    {nextLimit !== undefined && nextLimit !== limit && <span className="font-semibold text-accent-lineage"> → {formatRatio(nextLimit)}</span>}
                </span>
            </div>
            <div aria-hidden className="relative h-2.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none',
                    hit ? 'bg-rose-500/80' : 'bg-slate-400/75 dark:bg-slate-500')} style={{ width: pct(share) }} />
                <span className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-ink" style={{ left: pct(limit) }} />
                {nextLimit !== undefined && nextLimit !== limit && (
                    <span className="absolute -top-1.5 -bottom-1.5 w-1 -translate-x-1/2 rounded-full bg-accent-lineage" style={{ left: pct(nextLimit) }} />
                )}
            </div>
        </div>
    )
}

export function GuardMeter({ limits, next, sample, className }: {
    limits: GuardLimits
    /** The limits with staged changes applied. */
    next?: GuardLimits
    sample: SampleImport
    className?: string
}) {
    const [deletes, setDeletes] = useState(sample.deletes)
    const [creates, setCreates] = useState(sample.creates)
    const [matched, setMatched] = useState(sample.matched)
    const s: Sample = { live: sample.liveItems, rows: sample.importRows, deletes, creates, matched }
    const now = verdict(limits, s)
    const changed = next !== undefined && JSON.stringify(next) !== JSON.stringify(limits)
    const then = changed && next ? verdict(next, s) : null
    const Banner = BANNER[now.outcome]
    const step = (n: number) => Math.max(1, Math.round(n / 200))

    return (
        <VisualFrame
            title="What stops a mistaken replace"
            className={className}
            legend={(
                <>
                    <LegendKey kind="line" className="border-ink">Limit</LegendKey>
                    {changed && <LegendKey className="bg-accent-lineage">Your change</LegendKey>}
                </>
            )}
            caption={(
                <>
                    A replace of {formatCount(sample.importRows, 'rows')} into a graph of {formatCount(sample.liveItems, 'items')}. {now.why}
                    {then && <>{' '}<span className="font-medium text-accent-lineage">With your changes: {then.why}</span></>}
                </>
            )}
        >
            <div className={cn('mb-4 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-medium',
                now.outcome === 'stopped' || now.outcome === 'early'
                    ? 'bg-rose-500/[0.07] text-rose-700 dark:text-rose-300'
                    : 'bg-black/[0.03] text-ink-secondary dark:bg-white/[0.04]')}>
                <Banner.icon aria-hidden className="w-4 h-4 shrink-0" />
                {Banner.words}
            </div>
            <p className="-mt-2 mb-4 text-[11px] text-ink-muted">Drag the handles to try another replace.</p>
            <div className="space-y-4">
                <div className="space-y-1.5">
                    <Meter label="Deletes" share={deletes / s.live} limit={limits.deleteShare} nextLimit={changed ? next?.deleteShare : undefined}
                        hit={now.outcome === 'stopped'} />
                    <Slider aria-label="Items the replace deletes" value={deletes} onChange={setDeletes} min={0} max={s.live} step={step(s.live)}
                        fill={false} format={(v) => `${formatCount(v, 'items')} deleted`} ends={false} />
                </div>
                <div className="space-y-1.5">
                    <Meter label="Makes again" share={creates / s.live} limit={limits.createShare} nextLimit={changed ? next?.createShare : undefined}
                        hit={now.outcome === 'stopped'} />
                    <Slider aria-label="Items the replace makes new" value={creates} onChange={setCreates} min={0} max={s.live} step={step(s.live)}
                        fill={false} format={(v) => `${formatCount(v, 'items')} made`} ends={false} />
                </div>
                <div className="space-y-1.5">
                    <Meter label="First rows that match" share={s.rows ? matched / s.rows : 1} limit={limits.minMatchShare}
                        nextLimit={changed ? next?.minMatchShare : undefined} floor hit={now.outcome === 'early'} />
                    <Slider aria-label="Rows that match an existing item" value={matched} onChange={setMatched} min={0} max={s.rows} step={step(s.rows)}
                        fill={false} format={(v) => `${formatCount(v, 'rows')} match`} ends={false} />
                </div>
            </div>
        </VisualFrame>
    )
}
