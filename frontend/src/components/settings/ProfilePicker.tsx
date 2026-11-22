/**
 * ProfilePicker — start from a profile: one-click starting points (Balanced, Fastest reads, Always
 * exact, Least memory, Big import tonight), each told as an outcome: what it promises, when to choose
 * it, what you give up, and whom it is for. One radio group; the arrow keys move the choice. The
 * Business view lists the business profiles first; the Technical view keeps the registry's order.
 *
 * The chosen profile is previewed for this level: the trade-off compass with its values as the
 * dashed outline, and the plan, value by value: what would be staged (from → to), what is already
 * like this, and what is left out and why (`applyProfile`). Apply stages only what this person may
 * set here, one key at a time through `onStage`; it never saves. A summary then says what was staged
 * and what was left out, and Done hands back to the page (`onClose`), where the change is reviewed
 * and saved as any other.
 *
 * Labels and the compass's arithmetic come from the shipped catalogue; every value shown is the
 * resolver's (`resolved`).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, Briefcase, Check, CircleCheck, Code2, CornerDownRight, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'
import { Button } from '@/components/ui/Button'
import { CATALOGUE } from './catalogue'
import { formatValue, SCOPE_HERE, SCOPE_LABEL } from './format'
import type { Lens } from './lens'
import { applyProfile, skipWords, type ProfilePlan, type SkipReason } from './profiles'
import type { Audience, Editor, Profile, ResolvedValues, Scope, Setting, SettingValue, Values } from './types'
import { TradeoffCompass } from './visuals/TradeoffCompass'

export interface ProfilePickerProps {
    /** The registry's profiles (the schema's `profiles`). */
    profiles: Profile[]
    /** The level being edited. */
    scope: Scope
    /** The viewer's role; null: none. */
    editor: Editor | null
    /** The values resolved at this level, by key. */
    resolved: ResolvedValues
    /** Stages one value at this level; null would inherit (a profile always sets a value). */
    onStage: (key: string, value: SettingValue | null) => void
    /** Closes the host's drawer or dialog: after Done, or on Cancel. */
    onClose: () => void
    /** The app's view: Business lists the business profiles first. */
    lens?: Lens
}

const SETTINGS: Record<string, Setting> = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const ORDER = new Map(CATALOGUE.settings.map((s, i) => [s.key, i]))
const byOrder = (a: { key: string }, b: { key: string }) => (ORDER.get(a.key) ?? 999) - (ORDER.get(b.key) ?? 999)

/** Whom a profile is for, named as the app's views are (the persona switch's words and icons). */
const AUDIENCE: Record<Audience, { label: string; icon: typeof Briefcase }> = {
    business: { label: 'Business', icon: Briefcase },
    operator: { label: 'Technical', icon: Code2 },
}

/** "the platform, workspaces and graphs". */
function scopeWords(scopes: Scope[]): string {
    const words = scopes.map((s) => ({ platform: 'the platform', workspace: 'workspaces', graph: 'graphs' })[s])
    return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? ''
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Left out, the reasons someone could act on first: who may set it, then what the level has. */
const REASON_ORDER: SkipReason[] = ['not_allowed', 'locked', 'system_admin_only', 'no_permission', 'follows_root', 'not_here']

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

function ProfileCard({ profile, on, focusable, onPick }: { profile: Profile; on: boolean; focusable: boolean; onPick: () => void }) {
    const id = useId()
    const audience = AUDIENCE[profile.audience]
    const Icon = audience.icon
    const count = Object.keys(profile.values).length
    return (
        <button
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={profile.title}
            aria-describedby={`${id}-promise ${id}-caution`}
            tabIndex={focusable ? 0 : -1}
            onClick={onPick}
            className={cn(
                'flex flex-col gap-2.5 rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-150',
                'outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                on
                    ? 'border-accent-lineage/70 bg-accent-lineage/[0.035] shadow-[0_0_0_3px_rgb(var(--nx-accent-lineage-rgb)/0.08)]'
                    : 'border-glass-border/70 bg-canvas-elevated hover:border-accent-lineage/35',
            )}
        >
            <span className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold leading-snug tracking-tight text-ink">{profile.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-1.5 py-px text-[10px] font-semibold text-ink-secondary dark:bg-white/[0.07]">
                            <Icon aria-hidden className="w-2.5 h-2.5" /> {audience.label}
                        </span>
                        <span className="text-[10.5px] font-medium text-ink-muted">{plural(count, 'setting')}</span>
                    </span>
                </span>
                <RadioDot on={on} />
            </span>
            <span id={`${id}-promise`} className="block text-xs leading-relaxed text-ink-secondary">{profile.promise}</span>
            <span className="block">
                <span className="block text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted">Choose it when</span>
                {profile.when.map((w) => (
                    <span key={w} className="mt-1 flex gap-1.5 text-[11.5px] leading-snug text-ink-secondary">
                        <CornerDownRight aria-hidden className="mt-0.5 w-3 h-3 shrink-0 text-ink-muted" />
                        <span>{w}</span>
                    </span>
                ))}
            </span>
            <span className="block">
                <span className="block text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted">What you give up</span>
                <span id={`${id}-caution`} className="mt-1 flex gap-1.5 text-[11.5px] leading-snug text-ink-secondary">
                    <Minus aria-hidden className="mt-0.5 w-3 h-3 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span><span className="sr-only">What you give up:</span>{' '}{profile.caution}</span>
                </span>
            </span>
            <span className="mt-auto block border-t border-glass-border/60 pt-2 text-[11px] text-ink-muted">
                For {scopeWords(profile.scopes)}
            </span>
        </button>
    )
}

/**
 * The plan, value by value: staged (from the value chosen for this level, set here or inherited, to
 * the profile's), already like this, and left out, by why. The guided setup shows a goal's plan too.
 */
export function PlanList({ plan, scope, resolved, done }: { plan: ProfilePlan; scope: Scope; resolved: ResolvedValues; done: boolean }) {
    const label = (key: string) => SETTINGS[key]?.label ?? key
    const show = (key: string, v: SettingValue | null | undefined) => (SETTINGS[key] ? formatValue(SETTINGS[key], v) : String(v))
    const already = plan.skipped.filter((x) => x.reason === 'already')
    const leftOut = REASON_ORDER
        .map((reason) => [reason, plan.skipped.filter((x) => x.reason === reason).map((x) => x.key)] as const)
        .filter(([, keys]) => keys.length > 0)
    const heading = 'text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted'
    return (
        <div className="space-y-4">
            <div>
                <p className={heading}>{done ? 'Staged' : 'Will be staged'} · {plan.stage.length}</p>
                {plan.stage.length > 0 ? (
                    <ul className="mt-2 divide-y divide-glass-border/50 rounded-xl border border-glass-border/60">
                        {plan.stage.map(({ key, value }) => (
                            <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3.5 py-2.5">
                                <span className="text-[13px] font-medium text-ink">{label(key)}</span>
                                <span className="text-xs text-ink-secondary">
                                    {show(key, resolved[key]?.declared)}
                                    <ArrowRight aria-hidden className="mx-1.5 inline w-3 h-3 align-[-2px] text-ink-muted" />
                                    <span className="sr-only"> to </span>
                                    <span className="font-semibold text-accent-lineage">{show(key, value)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="mt-1.5 text-xs text-ink-muted">Nothing: every value either applies already or can’t be set by you here.</p>
                )}
            </div>
            {already.length > 0 && (
                <div>
                    <p className={heading}>Already like this · {already.length}</p>
                    <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-ink-secondary">
                        <CircleCheck aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span>{already.map((x) => `${label(x.key)} (${show(x.key, resolved[x.key]?.declared)})`).join(', ')}</span>
                    </p>
                </div>
            )}
            {leftOut.length > 0 && (
                <div>
                    <p className={heading}>Left out · {plan.skipped.length - already.length}</p>
                    <ul className="mt-1.5 space-y-1.5">
                        {leftOut.map(([reason, keys]) => (
                            <li key={reason} className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs leading-relaxed text-ink-secondary dark:bg-white/[0.04]">
                                <span className="font-semibold text-ink">{skipWords(reason, scope)}:</span> {keys.map(label).join(', ')}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

export function ProfilePicker({ profiles, scope, editor, resolved, onStage, onClose, lens = 'operator' }: ProfilePickerProps) {
    const id = useId()
    const atScope = profiles.filter((p) => p.scopes.includes(scope))
    const offered = lens === 'business' ? [...atScope.filter((p) => p.audience === 'business'), ...atScope.filter((p) => p.audience !== 'business')] : atScope
    const elsewhere = profiles.filter((p) => !p.scopes.includes(scope))
    const [pickedId, setPickedId] = useState<string | null>(null)
    const [applied, setApplied] = useState<ProfilePlan | null>(null)
    const summaryRef = useRef<HTMLHeadingElement>(null)
    // The first profile offered is chosen until another is.
    const picked = offered.find((p) => p.id === pickedId) ?? offered[0] ?? null
    const here = SCOPE_HERE[scope]

    // A handful of values: worked out on each render, in the catalogue's order.
    const raw = picked ? applyProfile(picked, scope, editor, resolved) : null
    const plan = raw ? { stage: [...raw.stage].sort(byOrder), skipped: [...raw.skipped].sort(byOrder) } : null
    const current = useMemo(() => Object.fromEntries(Object.values(resolved).map((r) => [r.key, r.effective])) as Values, [resolved])
    const inactive = useMemo(() => Object.values(resolved).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key), [resolved])
    const next = { ...current, ...Object.fromEntries((plan?.stage ?? []).map((s) => [s.key, s.value])) } as Values

    // Focus follows the step: once applied, the summary is what to read next.
    useEffect(() => { if (applied) summaryRef.current?.focus() }, [applied])

    const apply = () => {
        if (!plan || plan.stage.length === 0) return
        for (const { key, value } of plan.stage) onStage(key, value)
        setApplied(plan)
    }

    if (applied && picked) {
        return (
            <section aria-labelledby={`${id}-summary`} className="space-y-5">
                <div className="rounded-2xl border border-accent-lineage/30 bg-accent-lineage/[0.03] p-4 sm:p-5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Profile applied · {SCOPE_LABEL[scope]}</p>
                    <h3 id={`${id}-summary`} ref={summaryRef} tabIndex={-1} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink outline-none">
                        {picked.title}: {plural(applied.stage.length, 'change')} staged for {here}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                        Nothing is saved yet. Review the changes, give a reason and save them, or discard them.
                    </p>
                    <div className="mt-4">
                        <PlanList plan={applied} scope={scope} resolved={resolved} done />
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button variant="primary" onClick={onClose}>Done</Button>
                </div>
            </section>
        )
    }

    return (
        <div className="space-y-5">
            <p className="text-[13px] leading-relaxed text-ink-secondary">
                Each profile sets the settings it covers for one outcome. Applying one stages its values for {here}, only those you
                may set here; nothing is saved until you review the changes.
            </p>

            {offered.length > 0 ? (
                <div role="radiogroup" aria-label="Profiles" onKeyDown={onRadioGroupKeyDown}
                    className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))]">
                    {offered.map((p) => (
                        <ProfileCard key={p.id} profile={p} on={p.id === picked?.id} focusable={p.id === picked?.id}
                            onPick={() => setPickedId(p.id)} />
                    ))}
                </div>
            ) : (
                <p className="text-xs text-ink-muted">No profile applies to {here}.</p>
            )}
            {elsewhere.length > 0 && (
                <p className="text-[11px] text-ink-muted">
                    Not offered for {here}: {elsewhere.map((p) => `${p.title} (for ${scopeWords(p.scopes)})`).join('; ')}.
                </p>
            )}

            {picked && plan && (
                <section aria-labelledby={`${id}-preview`}
                    className="rounded-2xl border border-glass-border/50 bg-canvas-elevated p-4 sm:p-5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Preview · {SCOPE_LABEL[scope]}</p>
                    <h3 id={`${id}-preview`} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
                        What {picked.title} would change for {here}
                    </h3>
                    <div className="mt-4 space-y-5">
                        {plan.stage.length > 0 && (
                            <TradeoffCompass dimensions={CATALOGUE.dimensions} settings={CATALOGUE.settings} current={current} next={next}
                                inactive={inactive} title={`What ${picked.title} trades here`} />
                        )}
                        <PlanList plan={plan} scope={scope} resolved={resolved} done={false} />
                    </div>
                </section>
            )}

            {/* Pinned to the drawer's bottom edge (past its body's padding), so the list scrolls under a
                footer rather than around a box floating over it. */}
            <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-glass-border/60 bg-canvas-elevated px-5 py-3 sm:-mx-6 sm:px-6">
                <p aria-live="polite" className="mr-auto min-w-0 text-xs text-ink-secondary">
                    {picked && <span className="sr-only">{picked.title}: </span>}
                    {plan && plan.stage.length > 0
                        ? `Stages ${plural(plan.stage.length, 'change')} for ${here}. Nothing is saved yet.`
                        : 'Nothing to stage here.'}
                </p>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={onClose} className="text-ink-secondary">Cancel</Button>
                    <Button variant="primary" disabled={!plan || plan.stage.length === 0} onClick={apply}
                        className="bg-indigo-600 hover:bg-indigo-700 hover:brightness-100">
                        {picked ? `Apply ${picked.title}` : 'Apply'}
                    </Button>
                </div>
            </div>
        </div>
    )
}
