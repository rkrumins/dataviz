/**
 * The spec sheet for one feature — what it is, and precisely what changes if you touch it.
 *
 * The centre of this panel is the WHEN ON / WHEN OFF comparison, side by side. That shape is the
 * whole argument: an admin isn't choosing between "a feature" and "nothing", they're choosing
 * between two versions of their product, and the only way to choose well is to see both. A
 * paragraph headed "impact" makes you hold the before-state in your head while you read the
 * after-state. A column doesn't.
 *
 * Everything on the right of that comparison is generated from the CODE (`feature_wiring.py`) —
 * the endpoints that refuse, the controls that vanish, what keeps working. It cannot drift from
 * what the server does without a CI guard failing.
 *
 * Radix Dialog handles the portal, focus trap and escape. Deliberately NOT wrapped in
 * framer-motion's AnimatePresence with an `exit` — a portaled exit animation in this codebase
 * strands an invisible click-blocker over the page (see stranded-portal-popover-freeze).
 */
import * as Dialog from '@radix-ui/react-dialog'
import {
    ArrowRight, Ban, Check, EyeOff, Lock, ShieldCheck, ShieldAlert, Sparkles, X, ZapOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveCategoryStyle } from './constants'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureCategory, FeatureDefinition } from '@/services/featuresService'
import { blockedBy, isOn, stateOf, valueOf } from './featureState'

export function FeatureDetailSheet({
    feature,
    allFeatures,
    values,
    meta,
    saving,
    onToggle,
    onChangeOptions,
    onClose,
}: {
    feature: FeatureDefinition | null
    allFeatures: FeatureDefinition[]
    values: Record<string, unknown>
    meta: FeatureCategory | undefined
    saving: boolean
    onToggle: (next: boolean) => void
    onChangeOptions: (next: string[]) => void
    onClose: () => void
}) {
    return (
        <Dialog.Root open={Boolean(feature)} onOpenChange={open => !open && onClose()}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content
                    className={cn(
                        'fixed right-0 top-0 z-50 h-full w-full sm:max-w-[560px] overflow-y-auto',
                        'bg-canvas-elevated border-l border-glass-border shadow-2xl',
                        'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-200',
                        'focus:outline-none',
                    )}
                >
                    {feature && (
                        <Body
                            feature={feature}
                            allFeatures={allFeatures}
                            values={values}
                            meta={meta}
                            saving={saving}
                            onToggle={onToggle}
                            onChangeOptions={onChangeOptions}
                        />
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}

function Body({
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
    const selected = (Array.isArray(valueOf(feature, values)) ? valueOf(feature, values) : []) as string[]

    return (
        <>
            <header className="sticky top-0 z-10 bg-canvas-elevated/95 backdrop-blur border-b border-glass-border">
                <div className="flex items-start gap-4 p-6">
                    <div className={cn('w-11 h-11 rounded-2xl border flex items-center justify-center shrink-0', style.iconBg)}>
                        <Icon className="w-5 h-5" />
                    </div>

                    <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            {categoryLabel}
                        </p>
                        <Dialog.Title className="mt-0.5 text-xl font-bold tracking-tight text-ink">
                            {feature.name}
                        </Dialog.Title>
                        <Dialog.Description className="mt-2 text-sm text-ink-muted leading-relaxed">
                            {feature.description}
                        </Dialog.Description>
                    </div>

                    <Dialog.Close
                        className="p-2 -m-1 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </Dialog.Close>
                </div>

                <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
                    {feature.enforcedServerSide ? (
                        <Badge icon={ShieldCheck} tone="emerald">
                            Enforced by the server
                        </Badge>
                    ) : (
                        <Badge icon={ShieldAlert} tone="amber">
                            Not enforced — the endpoint still answers
                        </Badge>
                    )}
                    {feature.posture === 'security' && (
                        <Badge icon={Lock} tone="rose">
                            Fails closed if unreadable
                        </Badge>
                    )}
                </div>
            </header>

            <div className="p-6 space-y-6">
                {/* The switch, with its state stated in words. A toggle alone makes you decode an
                    orientation; a sentence does not. */}
                <div
                    className={cn(
                        'flex items-center justify-between gap-4 rounded-2xl border p-4',
                        on ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-amber-500/30 bg-amber-500/[0.06]',
                    )}
                >
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink">
                            {on ? 'Available to your users' : 'Turned off for everyone'}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted">
                            {on
                                ? 'Turning this off takes effect immediately, for everybody.'
                                : 'Turning this back on restores it immediately. Nothing was deleted.'}
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
                        <SectionTitle>Available to build with</SectionTitle>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {(feature.options ?? []).map(opt => {
                                const picked = selected.includes(opt.id)
                                // The server refuses to save an empty list, and an empty list would
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
                                                picked
                                                    ? selected.filter(id => id !== opt.id)
                                                    : [...selected, opt.id],
                                            )
                                        }
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors',
                                            picked
                                                ? 'bg-accent-lineage/10 text-accent-lineage border-accent-lineage/30'
                                                : 'text-ink-muted border-glass-border hover:text-ink hover:border-ink-muted/40',
                                            (saving || isLastOne) && 'opacity-60 cursor-not-allowed',
                                        )}
                                    >
                                        {picked ? <Check className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                                        {opt.label}
                                    </button>
                                )
                            })}
                        </div>
                        <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                            Views already built in a withdrawn layout keep working — it is withdrawn from new
                            work, not deleted.
                        </p>
                    </section>
                )}

                {/* THE POINT OF THIS PANEL. Two products, side by side. */}
                <section>
                    <SectionTitle>What changes</SectionTitle>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Column
                            active={on}
                            heading="When on"
                            tone="emerald"
                            icon={Sparkles}
                            lead={`${feature.name} is available to everyone who has permission to use it.`}
                            items={feature.uiSurfaces ?? []}
                            itemsLabel="Your users see"
                        />
                        <Column
                            active={!on}
                            heading="When off"
                            tone="amber"
                            icon={EyeOff}
                            lead={feature.impactWhenOff}
                            items={feature.serverGates ?? []}
                            itemsLabel="The server refuses"
                        />
                    </div>
                </section>

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

                {(feature.dependsOn?.length ?? 0) > 0 && (
                    <section>
                        <SectionTitle>Depends on</SectionTitle>
                        <div className="mt-2 space-y-1.5">
                            {feature.dependsOn!.map(key => {
                                const dep = allFeatures.find(f => f.key === key)
                                const depOn = dep ? isOn(dep, values) : true
                                return (
                                    <div
                                        key={key}
                                        className="flex items-center gap-2 text-xs text-ink-secondary"
                                    >
                                        <ArrowRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                                        <span className="font-medium text-ink">{dep?.name ?? key}</span>
                                        <span
                                            className={cn(
                                                'px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                                                depOn
                                                    ? 'text-emerald-700 dark:text-emerald-400 border-emerald-500/25 bg-emerald-500/10'
                                                    : 'text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/15',
                                            )}
                                        >
                                            {depOn ? 'on' : 'off'}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
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
        </>
    )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{children}</h4>
    )
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
        <span className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border', cls)}>
            <Icon className="w-3 h-3" />
            {children}
        </span>
    )
}

/** One side of the comparison. The CURRENT state is the one that's lit — so you can always see, at
 *  a glance, which of these two worlds your users are actually in. */
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
    const ring = tone === 'emerald' ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : 'border-amber-500/30 bg-amber-500/[0.06]'
    const dot = tone === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'

    return (
        <div
            className={cn(
                'rounded-2xl border p-4 transition-colors',
                active ? ring : 'border-glass-border bg-transparent opacity-70',
            )}
        >
            <div className="flex items-center gap-2">
                <Icon className={cn('w-3.5 h-3.5', tone === 'emerald' ? 'text-emerald-500' : 'text-amber-500')} />
                <p className="text-xs font-semibold text-ink">{heading}</p>
                {active && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-ink-muted">
                        <span className={cn('w-1.5 h-1.5 rounded-full', dot)} />
                        now
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
                            <li
                                key={item}
                                className="flex items-start gap-1.5 text-[11px] text-ink-muted leading-relaxed"
                            >
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
