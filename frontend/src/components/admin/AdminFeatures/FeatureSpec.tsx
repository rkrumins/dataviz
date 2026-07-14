/**
 * One feature, explained in full — and always on screen.
 *
 * This used to be a modal you had to go and open, which meant the page's default state answered
 * "what is this feature called?" and nothing else. Twelve names and twelve switches is not an
 * explanation; it's an inventory. The question an admin actually has — what IS this, and what
 * happens to my users if I touch it — was one click away from every single row, and a question you
 * have to ask is a question most people don't.
 *
 * So the explanation is the page now. Pick a feature on the left, read it on the right.
 *
 * The middle of the panel is the WHEN ON / WHEN OFF comparison, and the shape is the argument: an
 * admin isn't choosing between "a feature" and "nothing", they're choosing between two versions of
 * their product, and the only way to choose well is to see both at once. The current one is lit, so
 * you always know which world your users are in.
 *
 * Everything to the right of the description is generated from the CODE (`feature_wiring.py`) — the
 * endpoints that refuse, the controls that vanish, what keeps working. It cannot drift from what
 * the server does without a CI guard failing.
 */
import {
    ArrowRight, Ban, Check, EyeOff, Lock, ShieldAlert, ShieldCheck, Sparkles, ZapOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveCategoryStyle } from './constants'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureCategory, FeatureDefinition } from '@/services/featuresService'
import { blockedBy, isOn, stateOf, valueOf } from './featureState'

export function FeatureSpec({
    feature,
    allFeatures,
    values,
    meta,
    saving,
    onToggle,
    onChangeOptions,
}: {
    feature: FeatureDefinition
    allFeatures: FeatureDefinition[]
    values: Record<string, unknown>
    meta: FeatureCategory | undefined
    saving: boolean
    onToggle: (next: boolean) => void
    onChangeOptions: (next: string[]) => void
}) {
    const { Icon, style, label: categoryLabel } = resolveCategoryStyle(meta, feature.category)
    const on = isOn(feature, values)
    const state = stateOf(feature, allFeatures, values)
    const blockers = blockedBy(feature, allFeatures, values)
    const raw = valueOf(feature, values)
    const selected = (Array.isArray(raw) ? raw : []) as string[]

    return (
        <div className="rounded-3xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <header className="p-6 sm:p-7 border-b border-glass-border">
                <div className="flex items-start gap-4">
                    <div className={cn('w-12 h-12 rounded-2xl border flex items-center justify-center shrink-0', style.iconBg)}>
                        <Icon className="w-5 h-5" />
                    </div>

                    <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            {categoryLabel}
                        </p>
                        <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-ink">{feature.name}</h2>
                        <p className="mt-2 text-sm text-ink-secondary leading-relaxed max-w-2xl">
                            {feature.description}
                        </p>
                    </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                    {feature.enforcedServerSide ? (
                        <Badge icon={ShieldCheck} tone="emerald">Enforced by the server</Badge>
                    ) : (
                        <Badge icon={ShieldAlert} tone="amber">Not enforced — the endpoint still answers</Badge>
                    )}
                    {feature.posture === 'security' && (
                        <Badge icon={Lock} tone="rose">Fails closed if it can't be read</Badge>
                    )}
                </div>
            </header>

            <div className="p-6 sm:p-7 space-y-6">
                {/* The switch, with its state in words. A toggle alone asks you to decode an
                    orientation; a sentence doesn't. */}
                <div
                    className={cn(
                        'flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5',
                        on
                            ? 'border-emerald-500/25 bg-emerald-500/[0.05]'
                            : 'border-amber-500/30 bg-amber-500/[0.06]',
                    )}
                >
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink">
                            {on ? 'Available to your users' : 'Turned off for everyone'}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted leading-relaxed">
                            {on
                                ? 'Turning this off takes effect immediately, for everybody.'
                                : 'Turning it back on restores it immediately — nothing was deleted.'}
                        </p>
                    </div>
                    {feature.type === 'boolean' && (
                        <ToggleSwitch
                            checked={on}
                            onChange={onToggle}
                            disabled={saving}
                            aria-label={`Turn ${feature.name} ${on ? 'off' : 'on'}`}
                        />
                    )}
                </div>

                {state === 'inert' && (
                    <div className="flex items-start gap-2.5 rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.03] p-4">
                        <ZapOff className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
                        <p className="text-xs text-ink-secondary leading-relaxed">
                            <span className="font-semibold text-ink">This is on, but doing nothing.</span>{' '}
                            {blockers.map(b => b.name).join(' and ')} {blockers.length > 1 ? 'are' : 'is'} turned
                            off, and that already stops everyone — including admins.
                        </p>
                    </div>
                )}

                {/* A list flag is a SET, not a switch. Render the set. */}
                {feature.type === 'string[]' && (
                    <section>
                        <SectionTitle>Which ones people can use</SectionTitle>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {(feature.options ?? []).map(opt => {
                                const picked = selected.includes(opt.id)
                                // The server refuses to save an empty list — and an empty list would
                                // mean nobody can build anything at all.
                                const isLastOne = picked && selected.length === 1
                                return (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        disabled={saving || isLastOne}
                                        title={isLastOne ? 'At least one must stay available' : undefined}
                                        onClick={() =>
                                            onChangeOptions(
                                                picked ? selected.filter(id => id !== opt.id) : [...selected, opt.id],
                                            )
                                        }
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors',
                                            picked
                                                ? 'bg-accent-lineage/10 text-accent-lineage border-accent-lineage/30'
                                                : 'text-ink-muted border-glass-border hover:text-ink hover:border-ink-muted/40 line-through decoration-ink-muted/40',
                                            (saving || isLastOne) && 'opacity-60 cursor-not-allowed',
                                        )}
                                    >
                                        {picked ? <Check className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                                        {opt.label}
                                    </button>
                                )
                            })}
                        </div>
                        <p className="mt-2.5 text-[11px] text-ink-muted leading-relaxed">
                            Views already built in a withdrawn layout keep working — it's withdrawn from new
                            work, not deleted.
                        </p>
                    </section>
                )}

                {/* THE POINT OF THE PANEL. Two products, side by side, the live one lit. */}
                <section>
                    <SectionTitle>What changes</SectionTitle>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <Column
                            active={on}
                            heading="When it's on"
                            tone="emerald"
                            icon={Sparkles}
                            lead={`Anyone with permission to use ${feature.name.toLowerCase()} can.`}
                            items={feature.uiSurfaces ?? []}
                            itemsLabel="Your users get"
                        />
                        <Column
                            active={!on}
                            heading="When it's off"
                            tone="amber"
                            icon={EyeOff}
                            lead={feature.impactWhenOff}
                            items={feature.serverGates ?? []}
                            itemsLabel="The server refuses"
                        />
                    </div>
                </section>

                <div className="grid gap-4 lg:grid-cols-2">
                    {(feature.stillAllowed?.length ?? 0) > 0 && (
                        <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                                Still works when it's off
                            </p>
                            <ul className="mt-2 space-y-1.5">
                                {feature.stillAllowed!.map(item => (
                                    <li key={item} className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed">
                                        <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                                        {item}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {feature.adminHint && (
                        <section className="rounded-2xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                Worth knowing
                            </p>
                            <p className="mt-1.5 text-xs text-ink-secondary leading-relaxed">{feature.adminHint}</p>
                        </section>
                    )}
                </div>

                {(feature.dependsOn?.length ?? 0) > 0 && (
                    <section>
                        <SectionTitle>Only works while these are on</SectionTitle>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {feature.dependsOn!.map(key => {
                                const dep = allFeatures.find(f => f.key === key)
                                const depOn = dep ? isOn(dep, values) : true
                                return (
                                    <span
                                        key={key}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border',
                                            depOn
                                                ? 'border-glass-border text-ink-secondary'
                                                : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                                        )}
                                    >
                                        <ArrowRight className="w-3 h-3 opacity-60" />
                                        {dep?.name ?? key}
                                        <span className="opacity-70">· {depOn ? 'on' : 'off'}</span>
                                    </span>
                                )
                            })}
                        </div>
                    </section>
                )}
            </div>
        </div>
    )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{children}</h3>
}

function Badge({
    icon: Icon,
    tone,
    children,
}: {
    icon: React.ElementType
    tone: 'emerald' | 'amber' | 'rose'
    children: React.ReactNode
}) {
    const cls = {
        emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
        amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
        rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/25',
    }[tone]
    return (
        <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border', cls)}>
            <Icon className="w-3 h-3" />
            {children}
        </span>
    )
}

function Column({
    active,
    heading,
    tone,
    icon: Icon,
    lead,
    items,
    itemsLabel,
}: {
    active: boolean
    heading: string
    tone: 'emerald' | 'amber'
    icon: React.ElementType
    lead?: string
    items: string[]
    itemsLabel: string
}) {
    const lit = tone === 'emerald'
        ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
        : 'border-amber-500/30 bg-amber-500/[0.06]'
    const dot = tone === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'

    return (
        <div
            className={cn(
                'rounded-2xl border p-4 transition-colors',
                active ? lit : 'border-glass-border bg-transparent opacity-60',
            )}
        >
            <div className="flex items-center gap-2">
                <Icon className={cn('w-3.5 h-3.5', tone === 'emerald' ? 'text-emerald-500' : 'text-amber-500')} />
                <p className="text-xs font-semibold text-ink">{heading}</p>
                {active && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        <span className={cn('w-1.5 h-1.5 rounded-full', dot)} />
                        right now
                    </span>
                )}
            </div>

            {lead && <p className="mt-2 text-xs text-ink-secondary leading-relaxed">{lead}</p>}

            {items.length > 0 && (
                <>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        {itemsLabel}
                    </p>
                    <ul className="mt-1.5 space-y-1">
                        {items.map(item => (
                            <li key={item} className="flex items-start gap-1.5 text-[11px] text-ink-muted leading-relaxed">
                                <span className={cn('w-1 h-1 rounded-full shrink-0 mt-1.5', dot)} />
                                <span className="min-w-0">{item}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    )
}
