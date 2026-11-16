/**
 * SymptomFinder — "Something's wrong?" Start from the problem, not the setting: type or pick a
 * symptom ("Canvases are slow while an import lands") and get the settings that drive it, each
 * with its value in force, why it is what it is, and the recommended move. "Use recommended"
 * stages it; "Show" opens the setting. Built from every setting's `symptoms`.
 *
 * Given `signals`, counts of what actually happened, each problem a registry signal answers says
 * how often ("happened 12 times in the last 24 h"), marked once the count reaches the signal's
 * `warnAt`; problems with counts come first, and the settings behind each signal join its list.
 * When the server couldn't count them (`signalsUnavailable`), it says so rather than show none.
 */
import { useId, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, Sparkles, Stethoscope, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount, formatNumber } from '@/lib/units'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { CATALOGUE } from '../catalogue'
import { formatValue, sameValue } from '../format'
import { normalize, symptomIndex } from '../search'
import { StatusBadge } from '../StatusBadge'
import type { ResolvedValues, Setting, SettingValue, Signal, SignalCount } from '../types'

/** A signal's count, joined to its definition. */
interface Happened {
    signal: Signal
    count: number
    window: string
    /** The count reached the signal's `warnAt`. */
    warn: boolean
}

/** "24h" → "the last 24 h", "1h" → "the last hour", "7d" → "the last 7 days". */
function windowWords(window: string): string {
    const m = /^(\d+)\s*([hd])$/.exec(window.trim())
    if (!m) return `the last ${window}`
    const n = Number(m[1])
    if (m[2] === 'h') return n === 1 ? 'the last hour' : `the last ${n} h`
    return n === 1 ? 'the last day' : `the last ${n} days`
}

/** "happened 12 times in the last 24 h". */
function happenedWords(h: Happened): string {
    return h.count === 0
        ? `not seen in ${windowWords(h.window)}`
        : `happened ${formatCount(h.count, h.signal.unit)} in ${windowWords(h.window)}`
}

export function SymptomFinder({
    settings, values, staged = {}, onStage, onShow, onClose, signals, signalsUnavailable = false, signalDefinitions = CATALOGUE.signals, className,
}: {
    settings: Setting[]
    /** The values in force: only settings present here are offered. */
    values: ResolvedValues
    /** Values staged at this scope (null: inherit). */
    staged?: Record<string, SettingValue | null>
    onStage?: (key: string, value: SettingValue) => void
    onShow?: (key: string) => void
    /** Folds the finder away: a close button in its header. */
    onClose?: () => void
    /** Counts of what actually happened (the signals API, a graph's health). Without them, the finder lists problems only. */
    signals?: SignalCount[]
    /** The server couldn't count what happened: said, so no count reads as "nothing happened". */
    signalsUnavailable?: boolean
    /** The registry's signals, which join a count to the problem it answers: the shipped catalogue's by default. */
    signalDefinitions?: Signal[]
    className?: string
}) {
    const titleId = useId()
    const [query, setQuery] = useState('')
    const [picked, setPicked] = useState<string | null>(null)
    const happened = useMemo(() => {
        const by = new Map<string, Happened[]>()
        const defs = new Map(signalDefinitions.map((d) => [d.id, d]))
        for (const c of signals ?? []) {
            const signal = defs.get(c.id)
            if (!signal) continue
            const k = normalize(signal.symptom)
            const warn = signal.warnAt !== null && c.count >= signal.warnAt
            by.set(k, [...(by.get(k) ?? []), { signal, count: c.count, window: c.window, warn }])
        }
        return by
    }, [signals, signalDefinitions])
    const index = useMemo(() => {
        const present = settings.filter((s) => values[s.key])
        const base = symptomIndex(present)
        if (!signals) return base
        // What happened leads, and the settings behind each signal join the problem's list.
        const rank = (symptom: string) => {
            const hs = happened.get(normalize(symptom)) ?? []
            return { level: hs.some((h) => h.warn) ? 2 : hs.some((h) => h.count > 0) ? 1 : 0, total: hs.reduce((n, h) => n + h.count, 0) }
        }
        return base
            .map((e, i) => {
                const behind = new Set((happened.get(normalize(e.symptom)) ?? []).flatMap((h) => h.signal.settings))
                const more = present.filter((s) => behind.has(s.key) && !e.settings.includes(s))
                return { e: { ...e, settings: [...e.settings, ...more] }, i, ...rank(e.symptom) }
            })
            .sort((a, b) => b.level - a.level || b.total - a.total || a.i - b.i)
            .map((x) => x.e)
    }, [settings, values, signals, happened])
    const q = normalize(query)
    const shown = (q ? index.filter((e) => q.split(' ').every((w) => normalize(e.symptom).includes(w))) : index).slice(0, 10)
    const entry = index.find((e) => e.symptom === picked) ?? (q && shown.length === 1 ? shown[0] : undefined)
    const entryHappened = entry ? happened.get(normalize(entry.symptom)) ?? [] : []

    return (
        <section aria-labelledby={titleId} className={cn('rounded-2xl border border-glass-border/50 bg-canvas-elevated p-5 sm:p-6', className)}>
            <div className="flex items-start gap-3">
                <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-black/[0.04] text-ink-secondary dark:bg-white/[0.06]">
                    <Stethoscope aria-hidden className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-ink">Something’s wrong?</h2>
                    <p className="mt-0.5 text-xs text-ink-secondary">Start from what you see. You get the settings behind it and what to try.</p>
                </div>
                {onClose && <IconButton icon={X} label="Close the finder" size="sm" className="-mr-1.5 -mt-1 shrink-0" onClick={onClose} />}
            </div>

            {signalsUnavailable && (
                <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-secondary">
                    <TriangleAlert aria-hidden className="mt-0.5 w-3 h-3 shrink-0 text-amber-600 dark:text-amber-400" />
                    How often each problem happened can’t be counted right now, so no counts are shown. The problems and their settings still are.
                </p>
            )}
            <Input
                containerClassName="mt-4"
                aria-label="Describe the problem"
                placeholder="For example: slow canvases, unloads, duplicates"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPicked(null) }}
            />
            <div role="group" aria-label="Common problems" className="mt-3 flex flex-wrap gap-1.5">
                {shown.map((e) => {
                    const on = entry?.symptom === e.symptom
                    const hs = happened.get(normalize(e.symptom)) ?? []
                    const total = hs.reduce((n, h) => n + h.count, 0)
                    const warn = hs.some((h) => h.warn)
                    return (
                        <button
                            key={e.symptom}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setPicked(on ? null : e.symptom)}
                            className={cn(
                                'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                on ? 'border-ink/30 bg-ink text-ink-inverse'
                                    : warn ? 'border-amber-500/45 text-ink hover:border-amber-500/70'
                                        : 'border-glass-border/80 text-ink-secondary hover:border-ink/25 hover:text-ink',
                            )}
                        >
                            {e.symptom}
                            {total > 0 && (
                                <span aria-hidden className={cn(
                                    'ml-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 align-[1px] text-[10px] font-semibold tabular-nums',
                                    on ? 'bg-white/20 dark:bg-black/15' : warn ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'bg-black/[0.06] dark:bg-white/[0.08]',
                                )}>
                                    {warn && <TriangleAlert className="w-2.5 h-2.5" />}
                                    {formatNumber(total)}
                                </span>
                            )}
                            {hs.length > 0 && <span className="sr-only">: {hs.map(happenedWords).join('; ')}{warn ? ', worth a look' : ''}</span>}
                        </button>
                    )
                })}
                {shown.length === 0 && (
                    <p className="text-xs text-ink-secondary">
                        {index.length === 0
                            ? 'No settings to start from yet: the problems they answer are listed here once the server lists the settings.'
                            : `No problem matches “${query.trim()}”. Try fewer words.`}
                    </p>
                )}
            </div>

            <div aria-live="polite" className="mt-4">
                {entry && (
                    <>
                        {entryHappened.length > 0 && (
                            <ul aria-label="What happened" className="mb-3 space-y-1.5">
                                {entryHappened.map((h) => (
                                    <li key={h.signal.id} className={cn(
                                        'flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-relaxed',
                                        h.warn ? 'border border-amber-500/25 bg-amber-500/[0.07] text-ink-secondary' : 'bg-black/[0.03] text-ink-secondary dark:bg-white/[0.04]',
                                    )}>
                                        {h.warn
                                            ? <TriangleAlert aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                                            : <Activity aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-ink-muted" />}
                                        <span>
                                            <span className="font-semibold text-ink">{h.signal.label}:</span> {happenedWords(h)}.
                                            {h.warn && <span className="font-semibold text-amber-800 dark:text-amber-300"> Worth a look.</span>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                            {entry.settings.length === 1 ? 'One setting drives this' : `${entry.settings.length} settings drive this`}
                        </p>
                        <ul className="mt-2 space-y-2">
                            {entry.settings.map((s) => {
                                const r = values[s.key]
                                const rec = s.guidance.recommended.forThisPlatform?.value ?? s.guidance.recommended.value
                                const now = s.key in staged && staged[s.key] !== null ? (staged[s.key] as SettingValue) : r.effective
                                const atRec = sameValue(now, rec)
                                return (
                                    <li key={s.key} className="rounded-xl border border-glass-border/60 px-4 py-3">
                                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                            <p className="text-[13px] font-semibold text-ink">{s.label}</p>
                                            <StatusBadge status={r.status} />
                                        </div>
                                        <p className="mt-1 text-xs text-ink-secondary">
                                            In force: <span className="font-semibold text-ink">{formatValue(s, r.effective)}</span>
                                            {s.key in staged && <span className="font-semibold text-accent-lineage"> · staged: {formatValue(s, staged[s.key])}</span>}
                                        </p>
                                        {r.why[0] && <p className="mt-1 text-xs text-ink-muted">{r.why[0].text}</p>}
                                        <p className="mt-1.5 text-xs text-ink-secondary">
                                            {atRec ? 'Already at the recommended value.' : <>Try <span className="font-semibold text-ink">{formatValue(s, rec)}</span>: {s.guidance.recommended.forThisPlatform?.why ?? s.guidance.recommended.why}</>}
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {onStage && r.editable && !atRec && (
                                                <Button size="sm" variant="secondary" leftIcon={Sparkles} onClick={() => onStage(s.key, rec)}>Use recommended</Button>
                                            )}
                                            {onShow && <Button size="sm" variant="ghost" rightIcon={ArrowUpRight} onClick={() => onShow(s.key)}>Show {s.label.toLowerCase()}</Button>}
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    </>
                )}
            </div>
        </section>
    )
}
