/**
 * ChoiceCards — a choice setting's options as outcome cards, chosen as one radio group
 * (ReadModePicker, generalised to every choice setting from the registry's words).
 *
 * A rich card tells the option as an outcome: its promise, what readers see before, while and after
 * a new version lands and where each read comes from (from its `frames`), what it does to each
 * dimension, its pros and cons, what it is good for and what it needs. A compact card is the title
 * and the promise.
 *
 * Only the choices allowed at this scope are offered. A value already chosen that is no longer
 * allowed stays visible and selected, and says so; the others are named in a note, not hidden
 * without a word. Below the platform, a first option inherits ("Use the workspace's choice").
 *
 * Keyboard: one tab stop; the arrow keys move the choice (`onRadioGroupKeyDown`).
 */
import { Check, CornerDownRight, Database, HardDrive, Sparkles } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/utils'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'
import { formatValue, SCOPE_LABEL, sameValue } from './format'
import { choiceImpacts } from './impacts'
import { VERDICT_META } from './meta'
import type { Choice, DimensionInfo, Frame, Setting, SettingValue, TrailScope } from './types'

const WHEN_LABEL: Record<Frame['when'], string> = { before: 'Before', while: 'During', after: 'After' }

/** Before, while and after a new version lands: what readers see and where it is read from. */
function FrameStrip({ frames }: { frames: Frame[] }) {
    const before = frames.find((f) => f.when === 'before')?.shows
    const after = frames.find((f) => f.when === 'after')?.shows
    return (
        <span className="grid grid-cols-3 gap-1.5" aria-label="What readers see">
            {frames.map((f) => {
                const tone = f.shows === after && f.shows !== before ? 'new' : f.shows === before ? 'old' : 'mix'
                const Source = f.source === 'database' ? Database : HardDrive
                return (
                    <span key={f.when} className="min-w-0 rounded-lg bg-black/[0.03] px-2 py-1.5 dark:bg-white/[0.04]">
                        <span className="block whitespace-nowrap text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{WHEN_LABEL[f.when]}</span>
                        {/* Wraps rather than truncating: "Version 5, with parts of 6" is the point of the card. */}
                        <span className={cn(
                            'mt-1 inline-flex max-w-full rounded-lg px-1.5 py-px text-[10px] font-semibold leading-4',
                            tone === 'new' ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                                : tone === 'mix' ? 'bg-gradient-to-r from-slate-500/10 to-emerald-500/15 text-ink-secondary'
                                    : 'bg-slate-500/10 text-ink-secondary',
                        )}>
                            <span className="min-w-0 break-words">{f.shows}</span>
                        </span>
                        <span className={cn('mt-1 flex items-center gap-1 text-[10px]',
                            f.source === 'database' ? 'text-amber-700 dark:text-amber-400' : 'text-ink-secondary')}>
                            <Source aria-hidden className="w-3 h-3 shrink-0" /> {f.source}
                        </span>
                    </span>
                )
            })}
        </span>
    )
}

/** A choice's verdicts, as static chips (a card is one button: nothing inside it is focusable). */
function Verdicts({ choice, setting, dimensions }: { choice: Choice; setting: Setting; dimensions: DimensionInfo[] }) {
    const impacts = choiceImpacts(choice, setting).filter((i) => i.verdict !== 'same')
    if (!impacts.length) return null
    return (
        <span className="flex flex-wrap gap-1">
            {impacts.map((i) => {
                const meta = VERDICT_META[i.verdict ?? 'same']
                const Icon = meta.icon
                return (
                    <span key={i.dimension} className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium leading-4', meta.chip)}>
                        <Icon aria-hidden className="w-2.5 h-2.5" />
                        {dimensions.find((d) => d.id === i.dimension)?.label ?? i.dimension}
                        <span className="sr-only">: {meta.label}</span>
                    </span>
                )
            })}
        </span>
    )
}

function RadioDot({ on }: { on: boolean }) {
    return (
        <span aria-hidden className={cn(
            'grid place-items-center w-[18px] h-[18px] rounded-full border-2 shrink-0 transition-colors',
            on ? 'border-accent-lineage bg-accent-lineage' : 'border-ink-muted/40',
        )}>
            {on && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
        </span>
    )
}

export interface ChoiceCardsProps {
    setting: Setting
    /** The value chosen at this scope; null: inherits. */
    value: SettingValue | null
    onChange: (value: SettingValue | null) => void
    /** What may be chosen here; all choices when absent. */
    allowed?: SettingValue[] | null
    /** Offer inheriting: what null resolves to, and from which level. */
    inherit?: { from: TrailScope; value: SettingValue } | null
    /** The value in force, badged on its card when it differs from the one chosen. */
    effective?: SettingValue
    recommended?: SettingValue
    density?: 'rich' | 'compact'
    dimensions?: DimensionInfo[]
    disabled?: boolean
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
}

export function ChoiceCards({
    setting, value, onChange, allowed, inherit, effective, recommended, density = 'rich', dimensions = [], disabled = false,
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy,
}: ChoiceCardsProps) {
    const id = useId()
    const isAllowed = (c: Choice) => !allowed || allowed.some((a) => sameValue(a, c.id))
    const offered = setting.choices.filter((c) => isAllowed(c) || sameValue(c.id, value))
    const withheld = setting.choices.filter((c) => !isAllowed(c) && !sameValue(c.id, value))
    const anyChecked = value !== null || Boolean(inherit)
    const rich = density === 'rich'

    return (
        <div className="space-y-2.5">
            <div
                role="radiogroup"
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                aria-describedby={ariaDescribedBy}
                onKeyDown={onRadioGroupKeyDown}
                className="space-y-2.5"
            >
                {inherit && (
                    <button
                        type="button"
                        role="radio"
                        aria-checked={value === null}
                        tabIndex={value === null ? 0 : -1}
                        disabled={disabled}
                        onClick={() => onChange(null)}
                        className={cn(
                            'flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                            'outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            'disabled:cursor-not-allowed disabled:opacity-55',
                            value === null ? 'border-accent-lineage/60 bg-accent-lineage/[0.04]' : 'border-glass-border/70 hover:border-accent-lineage/35',
                        )}
                    >
                        <CornerDownRight aria-hidden className="w-4 h-4 shrink-0 text-ink-muted" />
                        <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-ink">
                                {inherit.from === 'default' ? 'Use the default' : `Use the ${SCOPE_LABEL[inherit.from].toLowerCase()}’s choice`}
                            </span>
                            <span className="block text-xs text-ink-secondary">
                                Currently <span className="font-medium text-ink-secondary">{formatValue(setting, inherit.value)}</span>. Follows it if it changes.
                            </span>
                        </span>
                        <RadioDot on={value === null} />
                    </button>
                )}
                {/* As many columns as the space holds (a page, a drawer, a phone), not as the window
                    holds: a card is never squeezed below a readable width. */}
                <div className={cn('grid gap-2.5', rich
                    ? 'grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]'
                    : 'grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]')}>
                    {offered.map((c, i) => {
                        const on = sameValue(c.id, value)
                        const stale = !isAllowed(c)
                        const inForce = effective !== undefined && sameValue(c.id, effective) && !on && value !== null
                        const promiseId = `${id}-${c.id}`
                        return (
                            <button
                                key={c.id}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                aria-label={c.title}
                                aria-describedby={promiseId}
                                tabIndex={on || (!anyChecked && i === 0) ? 0 : -1}
                                disabled={disabled || (stale && !on)}
                                onClick={() => onChange(c.id)}
                                className={cn(
                                    'group relative flex flex-col gap-2.5 rounded-2xl border text-left transition-[border-color,background-color,box-shadow] duration-150',
                                    'outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                    'disabled:cursor-not-allowed',
                                    rich ? 'p-4' : 'px-3.5 py-3',
                                    on
                                        ? 'border-accent-lineage/70 bg-accent-lineage/[0.035] shadow-[0_0_0_3px_rgb(var(--nx-accent-lineage-rgb)/0.08)]'
                                        : 'border-glass-border/70 bg-canvas-elevated hover:border-accent-lineage/35',
                                )}
                            >
                                <span className="flex items-start gap-3">
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-[13px] font-semibold leading-snug text-ink">{c.title}</span>
                                        {(sameValue(c.id, recommended) || inForce || stale) && (
                                            <span className="mt-1 flex flex-wrap gap-1">
                                                {sameValue(c.id, recommended) && (
                                                    <span className="inline-flex items-center gap-0.5 rounded-full bg-black/[0.05] px-1.5 py-px text-[10px] font-semibold text-ink-secondary dark:bg-white/[0.07]">
                                                        <Sparkles aria-hidden className="w-2.5 h-2.5" /> Recommended
                                                    </span>
                                                )}
                                                {inForce && (
                                                    <span className="inline-flex rounded-full bg-amber-500/12 px-1.5 py-px text-[10px] font-semibold text-amber-800 dark:text-amber-300">In force now</span>
                                                )}
                                                {stale && (
                                                    <span className="inline-flex rounded-full bg-black/[0.05] px-1.5 py-px text-[10px] font-semibold text-ink-secondary dark:bg-white/[0.07]">No longer offered here</span>
                                                )}
                                            </span>
                                        )}
                                    </span>
                                    <RadioDot on={on} />
                                </span>
                                <span id={promiseId} className={cn('block leading-relaxed text-ink-secondary', rich ? 'text-xs' : 'text-[11.5px]')}>
                                    {c.promise}
                                </span>
                                {rich && c.frames.length > 0 && <FrameStrip frames={c.frames} />}
                                {rich && dimensions.length > 0 && <Verdicts choice={c} setting={setting} dimensions={dimensions} />}
                                {rich && (c.pros.length > 0 || c.cons.length > 0) && (
                                    <span className="grid gap-1 text-[11px] leading-snug">
                                        {c.pros.map((p) => (
                                            <span key={p} className="flex gap-1.5 text-ink-secondary">
                                                <span aria-hidden className="text-emerald-600 dark:text-emerald-400">+</span>
                                                <span><span className="sr-only">Pro: </span>{p}</span>
                                            </span>
                                        ))}
                                        {c.cons.map((x) => (
                                            <span key={x} className="flex gap-1.5 text-ink-secondary">
                                                <span aria-hidden className="text-amber-600 dark:text-amber-400">−</span>
                                                <span><span className="sr-only">Con: </span>{x}</span>
                                            </span>
                                        ))}
                                    </span>
                                )}
                                {rich && (c.goodFor || c.needs) && (
                                    <span className="mt-auto block border-t border-glass-border/60 pt-2 text-[11px] leading-snug text-ink-secondary">
                                        {c.goodFor && <><span className="font-semibold text-ink-secondary">Good for </span>{c.goodFor} </>}
                                        {c.needs && <><span className="font-semibold text-ink-secondary">Needs </span>{c.needs}</>}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            </div>
            {withheld.length > 0 && (
                <p className="text-[11px] text-ink-secondary">Not offered here: {withheld.map((c) => c.title).join(', ')}.</p>
            )}
        </div>
    )
}
