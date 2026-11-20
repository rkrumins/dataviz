/**
 * LimitsEditor — on the platform, what workspaces and graphs may choose for a setting: which
 * choices, between which values, or none at all (the same value for everyone). Staged beside the
 * setting's value and saved with it, through the same review.
 *
 * Folded to one line that states the limits ("What workspaces and graphs may choose: … · Change…");
 * it opens on its own when its limits are staged or need a fix, and stays open until closed.
 *
 * The platform's own choice is always allowed, so it is ticked and can't be unticked. A workspace
 * admin sees the same limits in words (`LimitsNote`), never as controls.
 */
import { memo, useId, useState } from 'react'
import { CornerDownRight, Lock, Ruler, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { NumberInput } from '@/components/ui/NumberInput'
import { Switch } from '@/components/ui/Switch'
import { pluralize } from '@/lib/units'
import {
    describeLimits, formatValue, sameValue, stepAt,
    type Limits, type ResolvedSetting, type Setting, type SettingValue,
} from '@/components/settings'
import { ratioStyle } from '@/components/settings/format'
import { limitsNoteShown, limitsShown, rangeable } from './limits'

/** A bound as people type it: a share in percent, a count with its noun. */
function BoundInput({ s, value, onChange, label, invalid }: {
    s: Setting
    value: number
    onChange: (v: number) => void
    label: string
    invalid: boolean
}) {
    const share = s.kind === 'ratio' && ratioStyle(s) === 'share'
    const scale = share ? 100 : 1
    const [lo, hi] = s.range ?? [0, Number.MAX_SAFE_INTEGER]
    const noun = s.kind === 'days' || s.kind === 'days_or_forever' ? 'days' : s.kind === 'ratio' ? undefined : s.unit ?? undefined
    return (
        <NumberInput
            className="w-full sm:w-48"
            steppers={false}
            value={Number((value * scale).toFixed(4))}
            onChange={(v) => { if (v !== null) onChange(Number((v / scale).toFixed(6))) }}
            min={lo * scale}
            max={hi * scale}
            step={share ? 1 : s.kind === 'ratio' ? 0.05 : 1}
            unit={share ? '%' : noun ? pluralize(value, noun) : undefined}
            name={label}
            aria-label={label}
            invalid={invalid}
        />
    )
}

export const LimitsEditor = memo(function LimitsEditor({ setting: s, resolved: r, staged, platformValue, error, onStage, onUnstage }: {
    setting: Setting
    resolved: ResolvedSetting
    /** Staged limits; undefined when none are, null to go back to the defaults. */
    staged: Limits | null | undefined
    /** The platform's own value once saved: always allowed. */
    platformValue: SettingValue
    error?: string
    onStage: (key: string, limits: Limits | null) => void
    onUnstage: (key: string) => void
}) {
    const id = useId()
    const shown = limitsShown(s, r, staged)
    const isStaged = staged !== undefined
    // Opened by hand, or on its own when the limits are staged or need a fix.
    const wanted = isStaged || Boolean(error)
    const [open, setOpen] = useState(wanted)
    const [wasWanted, setWasWanted] = useState(wanted)
    if (wanted !== wasWanted) {
        setWasWanted(wanted)
        if (wanted) setOpen(true)
    }
    const set = (patch: Partial<Limits>) => onStage(s.key, { ...shown, ...patch })
    const canLock = s.limitable.includes('lock')
    const canAllow = s.limitable.includes('allowed') && s.kind === 'choice'
    const canRange = rangeable(s)
    const ids = s.choices.map((c) => c.id)
    const allowed = shown.allowed ?? ids
    const [lo, hi] = s.range ?? [0, 0]
    const before = stepAt(r, 'platform')?.limits ?? null

    const toggle = (choice: string, on: boolean) => {
        const next = ids.filter((c) => (c === choice ? on : allowed.some((a) => sameValue(a, c)) || sameValue(c, platformValue)))
        set({ allowed: next })
    }

    return (
        <section aria-labelledby={`${id}-title`} className={cn(
            'rounded-xl border',
            open ? 'px-4 py-3.5' : 'px-3.5 py-2.5',
            isStaged ? 'border-accent-lineage/35 bg-accent-lineage/[0.03]' : 'border-dashed border-glass-border/70',
        )}>
            {/* One line while folded: what they may choose now, and the way in. */}
            <div className="flex items-start gap-2">
                <Ruler aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-ink-secondary" />
                <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-secondary">
                    <span id={`${id}-title`} className="font-semibold text-ink">What workspaces and graphs may choose</span>:{' '}
                    <span className="text-ink">{describeLimits(s, before ?? s.defaultLimits)}</span>
                    {isStaged && <span className="font-semibold text-indigo-700 dark:text-indigo-300"> → {describeLimits(s, shown)}</span>}
                    {' · '}
                    <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)}
                        className="rounded font-semibold text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                        {open ? 'Done' : 'Change…'}
                    </button>
                </p>
            </div>

            <div id={`${id}-panel`} hidden={!open}>
                {(isStaged || r.limits) && (
                    <div className="mt-2 flex flex-wrap gap-1">
                        {!isStaged && r.limits && (
                            <Button size="sm" variant="ghost" className="text-ink-secondary" leftIcon={CornerDownRight} onClick={() => onStage(s.key, null)}>Use the default limits</Button>
                        )}
                        {isStaged && <Button size="sm" variant="ghost" className="text-ink-secondary" leftIcon={Undo2} onClick={() => onUnstage(s.key)}>Revert limits</Button>}
                    </div>
                )}

                {canLock && (
                    <div className="mt-3 flex items-start gap-3">
                        <Switch size="sm" checked={Boolean(shown.lock)} onChange={(on) => set({ lock: on || undefined })}
                            aria-labelledby={`${id}-lock`} aria-describedby={`${id}-lock-help`} />
                        <div className="min-w-0">
                            <p id={`${id}-lock`} className="flex items-center gap-1 text-[13px] font-medium text-ink">
                                {shown.lock && <Lock aria-hidden className="w-3 h-3 text-ink-secondary" />} Same for everyone
                            </p>
                            <p id={`${id}-lock-help`} className="text-[12.5px] text-ink-secondary">
                                {shown.lock
                                    ? `Workspaces and graphs use the platform’s value, ${formatValue(s, platformValue)}. Values they chose are kept, and apply again if this is turned off.`
                                    : 'Off: workspaces and graphs may choose their own, within the limits below.'}
                            </p>
                        </div>
                    </div>
                )}

                {!shown.lock && canAllow && (
                    <fieldset className="mt-3">
                        <legend className="text-[12.5px] font-medium text-ink-secondary">Choices they may pick</legend>
                        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
                            {s.choices.map((c) => {
                                const own = sameValue(c.id, platformValue)
                                const on = own || allowed.some((a) => sameValue(a, c.id))
                                return (
                                    <label key={c.id} className={cn(
                                        'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left',
                                        on ? 'border-ink/15 bg-black/[0.02] dark:border-white/20 dark:bg-white/[0.03]' : 'border-glass-border/70',
                                        own ? 'cursor-not-allowed' : 'cursor-pointer',
                                    )}>
                                        <input type="checkbox" checked={on} disabled={own} onChange={(e) => toggle(c.id, e.target.checked)}
                                            className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--nx-accent-lineage-rgb))]" />
                                        <span className="min-w-0">
                                            <span className="block text-[13px] font-medium text-ink">{c.title}</span>
                                            <span className="block text-[12.5px] text-ink-secondary">{own ? 'The platform’s own choice: always allowed' : c.short}</span>
                                        </span>
                                    </label>
                                )
                            })}
                        </div>
                    </fieldset>
                )}

                {!shown.lock && canRange && (
                    <fieldset className="mt-3">
                        <legend className="text-[12.5px] font-medium text-ink-secondary">Values they may set</legend>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-secondary">
                            <BoundInput s={s} label={`Lowest ${s.label}`} value={shown.range?.[0] ?? lo} invalid={Boolean(error)}
                                onChange={(v) => set({ range: [v, shown.range?.[1] ?? hi] })} />
                            <span>to</span>
                            <BoundInput s={s} label={`Highest ${s.label}`} value={shown.range?.[1] ?? hi} invalid={Boolean(error)}
                                onChange={(v) => set({ range: [shown.range?.[0] ?? lo, v] })} />
                        </div>
                        <p className="mt-1 text-[12.5px] text-ink-secondary">The setting itself allows {formatValue(s, lo)} to {formatValue(s, hi)}.</p>
                    </fieldset>
                )}
            </div>
            <p role="alert" className={cn('text-[12.5px] font-medium text-rose-700 dark:text-rose-400', error ? 'mt-2' : 'sr-only')}>{error ?? ''}</p>
        </section>
    )
})

/** Below the platform: the limits the platform set, in words, when it set any. */
export function LimitsNote({ setting: s, resolved: r }: { setting: Setting; resolved: ResolvedSetting }) {
    const platform = stepAt(r, 'platform')
    const limits = platform?.limits
    if (!limitsNoteShown(s, r)) return null
    return (
        <p className="flex items-start gap-1.5 text-[12.5px] text-ink-secondary">
            <Ruler aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            <span>
                {platform?.locked
                    ? 'The platform set this for everyone: a system admin can unlock it.'
                    : <>Workspaces and graphs may choose: <span className="font-medium text-ink">{describeLimits(s, limits)}</span>. Set by a system admin.</>}
            </span>
        </p>
    )
}
