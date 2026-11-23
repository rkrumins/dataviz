/**
 * SettingControl — the input a setting needs, chosen by its kind:
 *
 *   choice                cards (rich for read modes and the business lens, compact otherwise)
 *   bool                  a switch, with On / Off said in words
 *   count, days           a number with its unit noun
 *   percent, ratio        a slider and a number together; a ratio reads as a share (%)
 *   ms, seconds, bytes    a number with a unit picker, stored in base units
 *   *_or_unlimited,       "Up to a limit" / "Unlimited" (or "For a set time" / "Forever"), then the
 *   days_or_forever       number; the words are values, never a magic number
 *   identifier            Entity ID / URN / a property (named), optionally falling back to the URN
 *   refusal_budget        None / a number of rows / a share of rows / Unlimited
 *
 * `value` is what this scope chose; null means it inherits, and the control shows the inherited
 * value as a placeholder and, unless `inheritNote` is off (a row says it in a line of its own),
 * where it comes from. A switch says On or Off once: its note names where it comes from, not the
 * value again. Changing anything stages a value of this scope's own. Only `allowed` choices are
 * offered, and numbers are bounded by the setting's range narrowed by the platform's limits.
 */
import { useId } from 'react'
import { identifierLabel, MATCH_KINDS, formatIdentifier, parseIdentifier, type MatchKind } from '@/features/import-export/identifier'
import { BYTE_UNITS, DURATION_UNITS, DURATION_UNIT_NAMES, MS_UNITS, formatNumber, pluralize } from '@/lib/units'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { NumberInput } from '@/components/ui/NumberInput'
import { QuantityInput } from '@/components/ui/QuantityInput'
import { Segmented } from '@/components/ui/Segmented'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { ChoiceCards } from './ChoiceCards'
import { allowedChoices, boundsAt, formatValue, inheritedAt, SCOPE_LABEL } from './format'
import type { Lens } from './lens'
import type { DimensionInfo, ResolvedSetting, Scope, Setting, SettingValue, TrailScope } from './types'

export interface SettingControlProps {
    setting: Setting
    /** The value chosen at this scope; null: inherits. */
    value: SettingValue | null
    onChange: (value: SettingValue | null) => void
    resolved?: ResolvedSetting
    scope?: Scope
    lens?: Lens
    dimensions?: DimensionInfo[]
    disabled?: boolean
    invalid?: boolean
    /** Say under the control where an inherited value comes from (on by default). A row that says
     *  it itself passes false. */
    inheritNote?: boolean
    'aria-labelledby'?: string
    'aria-describedby'?: string
}

interface Common {
    s: Setting
    /** The scope being edited, for the words that name it. */
    scope: Scope
    value: SettingValue | null
    onChange: (value: SettingValue | null) => void
    inherit: { scope: TrailScope; value: SettingValue }
    bounds: { min?: number; max?: number }
    disabled: boolean
    invalid: boolean
    /** Say where an inherited value comes from. */
    inheritNote: boolean
    labelledBy?: string
    describedBy?: string
}

const num = (v: SettingValue | null | undefined): number | null => (typeof v === 'number' ? v : null)

/** The first number among the candidates: what a "limit" starts at when switching from a word. */
const firstNumber = (fallback: number, ...vs: Array<SettingValue | null | undefined>): number => {
    for (const v of vs) if (typeof v === 'number') return v
    return fallback
}

/** Whose own value a change sets: the scope being edited. */
const OWN: Record<Scope, string> = { platform: 'the platform’s own', workspace: 'this workspace’s own', graph: 'this graph’s own' }

function InheritNote({ c }: { c: Common }) {
    if (c.value !== null || !c.inheritNote) return null
    const from = c.inherit.scope === 'default' ? 'the default' : `the ${SCOPE_LABEL[c.inherit.scope].toLowerCase()}`
    return (
        <p className="mt-1.5 text-[12.5px] text-ink-secondary">
            {/* A switch has just said On or Off. */}
            {c.s.kind === 'bool' ? <>Follows {from}</> : (
                <>
                    {c.inherit.scope === 'default' ? 'The default' : `From ${from}`}:{' '}
                    <span className="font-medium text-ink">{formatValue(c.s, c.inherit.value)}</span>
                </>
            )}. Change it to set {OWN[c.scope]}.
        </p>
    )
}

function BoolControl({ c }: { c: Common }) {
    const on = Boolean(c.value ?? c.inherit.value)
    return (
        <div>
            <div className="flex items-center gap-2.5">
                <Switch size="sm" checked={on} onChange={(v) => c.onChange(v)} disabled={c.disabled}
                    aria-labelledby={c.labelledBy} aria-label={c.labelledBy ? undefined : c.s.label} aria-describedby={c.describedBy} />
                <span className={cn('text-[13px] font-medium', on ? 'text-ink' : 'text-ink-secondary')}>{on ? 'On' : 'Off'}</span>
            </div>
            <InheritNote c={c} />
        </div>
    )
}

function CountControl({ c, noun }: { c: Common; noun?: string }) {
    const shown = num(c.value) ?? num(c.inherit.value) ?? 0
    return (
        <div className="w-full sm:w-56">
            <NumberInput
                value={num(c.value)}
                onChange={c.onChange}
                fallback={num(c.inherit.value) ?? undefined}
                placeholder={num(c.inherit.value) !== null ? formatNumber(num(c.inherit.value) as number) : undefined}
                min={c.bounds.min}
                max={c.bounds.max}
                unit={noun ? pluralize(shown, noun) : undefined}
                name={c.s.label}
                invalid={c.invalid}
                disabled={c.disabled}
                aria-labelledby={c.labelledBy}
                // Its title names it (aria-labelledby wins); the label stands in where a title scrolled out of view isn't read.
                aria-label={c.s.label}
                aria-describedby={c.describedBy}
            />
            <InheritNote c={c} />
        </div>
    )
}

/** A level: a slider and a number together, in percent (a share is its ratio × 100). */
function LevelControl({ c, mode }: { c: Common; mode: 'percent' | 'share' }) {
    const scale = mode === 'share' ? 100 : 1
    const lo = (c.bounds.min ?? 0) * scale
    const hi = c.bounds.max !== undefined ? c.bounds.max * scale : 100
    const scaled = (v: number) => Number((v * scale).toFixed(4))
    const own = num(c.value)
    const shown = scaled(own ?? num(c.inherit.value) ?? lo / scale)
    const rec = num(c.s.guidance.recommended.value)
    const words = (v: number) => `${formatNumber(v)}%`
    const send = (v: number | null) => c.onChange(v === null ? null : Number((v / scale).toFixed(4)))
    return (
        <div className="w-full">
            <div className="flex items-center gap-3">
                <Slider
                    className="flex-1 min-w-[8rem]"
                    value={Math.min(hi, Math.max(lo, shown))}
                    onChange={send}
                    min={lo}
                    max={hi}
                    step={1}
                    format={words}
                    marks={rec !== null ? [{ value: scaled(rec), label: 'Recommended' }] : []}
                    disabled={c.disabled}
                    aria-labelledby={c.labelledBy}
                    aria-label={c.labelledBy ? undefined : c.s.label}
                    aria-describedby={c.describedBy}
                />
                <NumberInput
                    className="w-28 shrink-0"
                    value={own === null ? null : scaled(own)}
                    onChange={send}
                    fallback={shown}
                    placeholder={formatNumber(shown)}
                    min={lo}
                    max={hi}
                    step={1}
                    decimals={1}
                    unit="%"
                    steppers={false}
                    name={c.s.label}
                    invalid={c.invalid}
                    disabled={c.disabled}
                    aria-label={`${c.s.label}, exact value`}
                />
            </div>
            <InheritNote c={c} />
        </div>
    )
}

function QuantityControl({ c, units, unitNames }: { c: Common; units: typeof BYTE_UNITS; unitNames?: Record<string, string> }) {
    return (
        <div className="w-full sm:w-72">
            <QuantityInput
                value={num(c.value)}
                onChange={c.onChange}
                units={units}
                unitNames={unitNames}
                fallback={num(c.inherit.value) ?? undefined}
                min={c.bounds.min}
                max={c.bounds.max}
                name={c.s.label}
                invalid={c.invalid}
                disabled={c.disabled}
                aria-labelledby={c.labelledBy}
                aria-label={c.labelledBy ? undefined : c.s.label}
                aria-describedby={c.describedBy}
            />
            <InheritNote c={c} />
        </div>
    )
}

/** Each word's two modes: a number, or the word the kind takes instead. */
const WORD_MODES = {
    unlimited: { limit: 'Up to a limit', word: 'Unlimited' },
    forever: { limit: 'For a set time', word: 'Forever' },
    everyone: { limit: 'A set number', word: 'Everyone asked' },
} as const

/** A number, or a word that is a value of its own ("unlimited", "forever", "everyone"). */
function OrWordControl({ c, word, quantity, noun }: { c: Common; word: keyof typeof WORD_MODES; quantity?: boolean; noun?: string }) {
    const shown = c.value ?? c.inherit.value
    const isWord = shown === word
    // A limit starts at the nearest number on hand: this scope's, the inherited one, this platform's
    // recommendation, the recommendation, the default; with none, a month, a gigabyte, or one.
    const rec = c.s.guidance.recommended
    const start = firstNumber(word === 'forever' ? 30 : quantity ? 1024 ** 3 : 1,
        c.value, c.inherit.value, rec.forThisPlatform?.value, rec.value, c.s.default.code)
    const mode = isWord ? 'word' : 'limit'
    // The number has a name of its own: the group above it carries the setting's.
    const sub: Common = {
        ...c,
        s: { ...c.s, label: `${c.s.label}, ${quantity ? 'size' : noun ?? 'number'}` },
        labelledBy: undefined,
        value: isWord ? null : c.value,
        inherit: { ...c.inherit, value: isWord ? start : c.inherit.value },
    }
    return (
        <div className="space-y-2.5">
            <Segmented
                size="md"
                label={c.s.label}
                value={mode}
                onChange={(m) => c.onChange(m === 'word' ? word : start)}
                options={[
                    { value: 'limit', label: WORD_MODES[word].limit, disabled: c.disabled },
                    { value: 'word', label: WORD_MODES[word].word, disabled: c.disabled },
                ]}
            />
            {mode === 'limit' && (quantity ? <QuantityControl c={sub} units={BYTE_UNITS} /> : <CountControl c={sub} noun={noun} />)}
            {mode === 'word' && <InheritNote c={c} />}
        </div>
    )
}

function IdentifierControl({ c }: { c: Common }) {
    const id = useId()
    const current = String(c.value ?? c.inherit.value)
    const match = parseIdentifier(current)
    const set = (kind: MatchKind, name = match.name, orUrn = match.orUrn) => c.onChange(formatIdentifier({ kind, name, orUrn }))
    return (
        <div className="space-y-2.5">
            <Segmented
                size="md"
                label={c.s.label}
                value={match.kind}
                onChange={(k) => set(k)}
                options={MATCH_KINDS.map((m) => ({ value: m.kind, label: m.label, disabled: c.disabled }))}
            />
            <p className="text-[11px] leading-relaxed text-ink-secondary">{MATCH_KINDS.find((m) => m.kind === match.kind)?.help}</p>
            {match.kind === 'prop' && (
                <div className="space-y-2">
                    <Input
                        aria-label="Property name"
                        placeholder="external_id"
                        value={match.name}
                        onChange={(e) => set('prop', e.target.value)}
                        invalid={c.invalid}
                        disabled={c.disabled}
                        className="font-mono"
                        containerClassName="w-full sm:w-64"
                    />
                    <label htmlFor={`${id}-urn`} className="flex items-start gap-2 text-[11.5px] leading-snug text-ink-secondary">
                        <input id={`${id}-urn`} type="checkbox" checked={Boolean(match.orUrn)} disabled={c.disabled}
                            onChange={(e) => set('prop', match.name, e.target.checked)}
                            className="mt-0.5 accent-[rgb(var(--nx-accent-lineage-rgb))]" />
                        Rows without it: find them by their URN
                    </label>
                </div>
            )}
            {c.value === null && c.inheritNote && (
                <p className="text-[12.5px] text-ink-secondary">
                    {c.inherit.scope === 'default' ? 'The default' : `From the ${SCOPE_LABEL[c.inherit.scope].toLowerCase()}`}: {identifierLabel(String(c.inherit.value))}.
                </p>
            )}
        </div>
    )
}

type BudgetMode = 'none' | 'rows' | 'share' | 'unlimited'

function RefusalBudgetControl({ c }: { c: Common }) {
    const current = String(c.value ?? c.inherit.value)
    const mode: BudgetMode = current === 'unlimited' ? 'unlimited' : current.endsWith('%') ? 'share' : Number(current) === 0 ? 'none' : 'rows'
    const start: Record<BudgetMode, string> = { none: '0', rows: '100', share: '1%', unlimited: 'unlimited' }
    return (
        <div className="space-y-2.5">
            <Segmented
                size="md"
                label={c.s.label}
                value={mode}
                onChange={(m) => c.onChange(start[m])}
                options={[
                    { value: 'none', label: 'None', disabled: c.disabled },
                    { value: 'rows', label: 'A number', disabled: c.disabled },
                    { value: 'share', label: 'A share', disabled: c.disabled },
                    { value: 'unlimited', label: 'Unlimited', disabled: c.disabled },
                ]}
            />
            {mode === 'rows' && (
                <NumberInput className="w-full sm:w-56" value={Number(current)} onChange={(n) => c.onChange(n === null ? '0' : String(n))}
                    min={1} unit={pluralize(Number(current), 'rows')} name="Rows refused" aria-label={`${c.s.label}, rows`}
                    invalid={c.invalid} disabled={c.disabled} />
            )}
            {mode === 'share' && (
                <NumberInput className="w-full sm:w-56" value={Number(current.slice(0, -1))} onChange={(n) => c.onChange(`${n ?? 0}%`)}
                    min={0} max={100} step={0.1} decimals={2} unit="% of rows" name="Share refused" aria-label={`${c.s.label}, share of rows`}
                    invalid={c.invalid} disabled={c.disabled} />
            )}
            <InheritNote c={c} />
        </div>
    )
}

export function SettingControl({
    setting: s, value, onChange, resolved, scope = 'platform', lens = 'operator', dimensions, disabled = false, invalid = false,
    inheritNote = true, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy,
}: SettingControlProps) {
    const inherit = resolved ? inheritedAt(resolved, scope) : { scope: 'default' as const, value: s.default.code }
    const c: Common = { s, scope, value, onChange, inherit, bounds: boundsAt(s, resolved, scope), disabled, invalid, inheritNote, labelledBy, describedBy }
    const unit = s.unit ?? undefined

    switch (s.kind) {
        case 'choice':
            return (
                <ChoiceCards
                    setting={s}
                    value={value}
                    onChange={onChange}
                    allowed={allowedChoices(resolved)}
                    inherit={{ from: inherit.scope, value: inherit.value }}
                    effective={resolved?.effective}
                    recommended={s.guidance.recommended.forThisPlatform?.value ?? s.guidance.recommended.value}
                    density={lens === 'business' || s.choices.some((ch) => ch.frames.length > 0) ? 'rich' : 'compact'}
                    dimensions={dimensions}
                    disabled={disabled}
                    aria-labelledby={labelledBy}
                    aria-label={labelledBy ? undefined : s.label}
                    aria-describedby={describedBy}
                />
            )
        case 'bool': return <BoolControl c={c} />
        case 'count': return <CountControl c={c} noun={unit} />
        case 'days': return <CountControl c={c} noun="days" />
        case 'percent': return <LevelControl c={c} mode="percent" />
        case 'ratio': return <LevelControl c={c} mode="share" />
        case 'ms': return <QuantityControl c={c} units={MS_UNITS} unitNames={{ ms: 'milliseconds', s: 'seconds', min: 'minutes' }} />
        case 'seconds': return <QuantityControl c={c} units={DURATION_UNITS} unitNames={DURATION_UNIT_NAMES} />
        case 'bytes': return <QuantityControl c={c} units={BYTE_UNITS} />
        case 'days_or_forever': return <OrWordControl c={c} word="forever" noun="days" />
        case 'count_or_unlimited': return <OrWordControl c={c} word="unlimited" noun={unit} />
        case 'count_or_everyone': return <OrWordControl c={c} word="everyone" noun={unit} />
        case 'bytes_or_unlimited': return <OrWordControl c={c} word="unlimited" quantity />
        case 'identifier': return <IdentifierControl c={c} />
        case 'refusal_budget': return <RefusalBudgetControl c={c} />
        default: return <p className="text-xs text-ink-secondary">{formatValue(s, value ?? inherit.value)}</p>
    }
}
