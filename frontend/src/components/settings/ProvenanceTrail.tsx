/**
 * ProvenanceTrail — where the value in force came from: Default → Platform → Workspace → Graph.
 *
 * Each level shows what it chose (or that it chose nothing). The level whose value won is drawn
 * solid with a check; a value a later level overrides is struck through; one the platform's lock
 * ignores says so. The platform carries badges for its lock and its limits (hover for what they
 * allow), a lower level for a system admin's exception, the default for the deployment's env var.
 * When the value in force differs from the one chosen, a last step says what is in force and why.
 *
 * A change being staged shows at the level being edited, in the accent: "→ Update in place". The
 * accent means "your change" across the kit, so the winning level is emphasised without it.
 */
import { ArrowRight, Check, ChevronRight, Lock, Ruler, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { formatValue, hasLimits, limitsWords, SCOPE_HERE, SCOPE_LABEL, sameValue, stepAt } from './format'
import { SCOPE_ICON } from './meta'
import type { ResolvedSetting, Scope, Setting, SettingValue, TrailStep } from './types'

type StepState = 'winner' | 'overridden' | 'ignored' | 'unset' | 'later'

function TrailBadge({ icon: Icon, label, tip, tone = 'neutral' }: {
    icon: typeof Lock
    label: string
    tip: string
    tone?: 'neutral' | 'info'
}) {
    return (
        <HoverTip label={tip} className="inline-flex">
            <span tabIndex={0} className={cn(
                'inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold leading-4 outline-none',
                'focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                tone === 'info' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-black/[0.06] text-ink-secondary dark:bg-white/[0.08]',
            )}>
                <Icon className="w-2.5 h-2.5" aria-hidden />
                {label}
            </span>
        </HoverTip>
    )
}

export function ProvenanceTrail({ setting, resolved, scope, staged, className }: {
    setting: Setting
    resolved: ResolvedSetting
    /** The level being edited. */
    scope?: Scope
    /** A value staged at `scope`; undefined when nothing is staged there. */
    staged?: SettingValue | null
    className?: string
}) {
    const platform = stepAt(resolved, 'platform')
    const locked = Boolean(platform?.locked)
    const order = resolved.trail.map((t) => t.scope)
    // A value the deployment's env var set is the Default level's.
    const winner = order.indexOf(resolved.source === 'env' ? 'default' : resolved.source)
    const platformAt = order.indexOf('platform')
    const adjusted = resolved.declared !== null && !sameValue(resolved.effective, resolved.declared)

    const stateOf = (t: TrailStep, i: number): StepState => {
        if (i === winner) return 'winner'
        if (t.value === null || t.value === undefined) return 'unset'
        if (locked && i > platformAt) return 'ignored'
        return i < winner ? 'overridden' : 'later'
    }
    const caption: Record<StepState, string> = {
        winner: adjusted ? 'Chosen' : 'In force', overridden: 'Overridden', ignored: 'Ignored: locked', unset: 'Not set', later: '',
    }

    return (
        <ol aria-label={`Where ${setting.label} comes from`} className={cn('flex flex-wrap items-stretch gap-y-1.5', className)}>
            {resolved.trail.map((t, i) => {
                const state = stateOf(t, i)
                const Icon = SCOPE_ICON[t.scope]
                const here = scope !== undefined && t.scope === scope
                const showStaged = here && staged !== undefined
                return (
                    <li key={t.scope} className="flex items-stretch">
                        {i > 0 && <ChevronRight aria-hidden className="mx-0.5 w-3.5 h-3.5 self-center text-ink-muted/70 shrink-0" />}
                        <div className={cn(
                            'min-w-0 max-w-[15rem] rounded-lg border px-2.5 py-1.5',
                            state === 'winner'
                                ? 'border-ink/20 bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.06)] dark:border-white/20'
                                : 'border-glass-border/60 border-dashed',
                            showStaged && 'border-solid border-accent-lineage/40',
                        )}>
                            <div className="flex flex-wrap items-center gap-1">
                                <Icon aria-hidden className="w-3 h-3 text-ink-muted shrink-0" />
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{SCOPE_LABEL[t.scope]}</span>
                                {here && <span className="text-[10px] text-ink-muted">· {SCOPE_HERE[t.scope as Scope]}</span>}
                                {t.scope === 'platform' && t.locked && (
                                    <TrailBadge icon={Lock} label="Locked" tip="Workspaces and graphs can’t change this value." />
                                )}
                                {t.scope === 'platform' && hasLimits(t.limits) && (
                                    <TrailBadge icon={Ruler} label="Limits" tip={`Workspaces and graphs may choose only within limits. ${limitsWords(setting, t.limits)}.`} />
                                )}
                                {t.exception && (
                                    <TrailBadge icon={ShieldAlert} label="Exception" tone="info" tip="A system admin set this outside the platform’s limits. It stays in force until changed." />
                                )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-xs leading-snug">
                                {state === 'winner' && !adjusted && <Check aria-hidden className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                                <span className={cn(
                                    'min-w-0',
                                    state === 'winner' ? 'font-semibold text-ink' : 'text-ink-muted',
                                    (state === 'overridden' || state === 'ignored') && 'line-through decoration-ink-muted/60',
                                )}>
                                    {t.value === null || t.value === undefined ? '—' : formatValue(setting, t.value)}
                                </span>
                                {caption[state] && <span className="sr-only"> ({caption[state]})</span>}
                            </div>
                            {t.scope === 'default' && setting.default.env && t.env != null && (
                                <p className={cn('mt-0.5 text-[10px]',
                                    !t.env.valid && t.env.held === undefined ? 'text-rose-600 dark:text-rose-400'
                                        : t.env.held !== undefined ? 'text-amber-700 dark:text-amber-400' : 'text-ink-muted')}>
                                    {!t.env.valid && t.env.held === undefined ? `Deployment value ignored: “${String(t.env.value)}”`
                                        : t.env.held !== undefined ? `Your deployment’s ${formatValue(setting, t.env.value)}, held to ${formatValue(setting, t.env.held)}`
                                            : 'Set by your deployment'}
                                </p>
                            )}
                            {state !== 'winner' && state !== 'later' && t.value !== null && t.value !== undefined && (
                                <p aria-hidden className="mt-0.5 text-[10px] text-ink-muted">{caption[state]}</p>
                            )}
                            {showStaged && (
                                <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-accent-lineage">
                                    <ArrowRight aria-hidden className="w-3 h-3 shrink-0" />
                                    <span className="sr-only">Your change: </span>
                                    {staged === null ? 'Not set (inherit)' : formatValue(setting, staged)}
                                </p>
                            )}
                        </div>
                    </li>
                )
            })}
            {adjusted && (
                <li className="flex items-stretch">
                    <ArrowRight aria-hidden className="mx-1 w-3.5 h-3.5 self-center text-amber-600 dark:text-amber-400 shrink-0" />
                    <div className="min-w-0 max-w-[15rem] rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">In force</span>
                        <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold leading-snug text-ink">
                            <Check aria-hidden className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            {formatValue(setting, resolved.effective)}
                            <span className="sr-only"> (adjusted from {formatValue(setting, resolved.declared)})</span>
                        </div>
                    </div>
                </li>
            )}
        </ol>
    )
}
