/**
 * SymptomFinder — "Something's wrong?" Start from the problem, not the setting: type or pick a
 * symptom ("Canvases are slow while an import lands") and get the settings that drive it, each
 * with its value in force, why it is what it is, and the recommended move. "Use recommended"
 * stages it; "Show" opens the setting. Built from every setting's `symptoms`.
 */
import { useId, useMemo, useState } from 'react'
import { ArrowUpRight, Sparkles, Stethoscope } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { formatValue, sameValue } from '../format'
import { normalize, symptomIndex } from '../search'
import { StatusBadge } from '../StatusBadge'
import type { ResolvedValues, Setting, SettingValue } from '../types'

export function SymptomFinder({ settings, values, staged = {}, onStage, onShow, className }: {
    settings: Setting[]
    /** The values in force: only settings present here are offered. */
    values: ResolvedValues
    /** Values staged at this scope (null: inherit). */
    staged?: Record<string, SettingValue | null>
    onStage?: (key: string, value: SettingValue) => void
    onShow?: (key: string) => void
    className?: string
}) {
    const titleId = useId()
    const [query, setQuery] = useState('')
    const [picked, setPicked] = useState<string | null>(null)
    const index = useMemo(() => symptomIndex(settings.filter((s) => values[s.key])), [settings, values])
    const q = normalize(query)
    const shown = (q ? index.filter((e) => q.split(' ').every((w) => normalize(e.symptom).includes(w))) : index).slice(0, 10)
    const entry = index.find((e) => e.symptom === picked) ?? (q && shown.length === 1 ? shown[0] : undefined)

    return (
        <section aria-labelledby={titleId} className={cn('rounded-2xl border border-glass-border/50 bg-canvas-elevated p-5 sm:p-6', className)}>
            <div className="flex items-start gap-3">
                <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-black/[0.04] text-ink-secondary dark:bg-white/[0.06]">
                    <Stethoscope aria-hidden className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                    <h3 id={titleId} className="text-[15px] font-semibold tracking-tight text-ink">Something’s wrong?</h3>
                    <p className="mt-0.5 text-xs text-ink-muted">Start from what you see. You get the settings behind it and what to try.</p>
                </div>
            </div>

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
                    return (
                        <button
                            key={e.symptom}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setPicked(on ? null : e.symptom)}
                            className={cn(
                                'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                on ? 'border-ink/30 bg-ink text-ink-inverse' : 'border-glass-border/80 text-ink-secondary hover:border-ink/25 hover:text-ink',
                            )}
                        >
                            {e.symptom}
                        </button>
                    )
                })}
                {shown.length === 0 && <p className="text-xs text-ink-muted">No problem matches “{query.trim()}”. Try fewer words.</p>}
            </div>

            <div aria-live="polite" className="mt-4">
                {entry && (
                    <>
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
