/**
 * Turning a feature OFF asks first. Turning it back ON does not.
 *
 * The asymmetry is the point. These directions are not equally consequential: turning a feature on
 * gives a capability back, while turning one off silently removes something from every user of the
 * deployment at once — and the person doing it is, by definition, not the person who will notice.
 *
 * This dialog is the only moment an admin is GUARANTEED to be looking at the consequence, so it
 * carries the three things that decide the question, and they are three different kinds of fact:
 *
 *   THE PROSE     what the feature does when it's off. True, and from a config file — it reads the
 *                 same on an estate of four views and one of four thousand.
 *   THE COUNT     what it would touch in YOUR estate, measured right now. "38 views already use
 *                 this layout." The database knew this all along and the product never said it.
 *   THE CASCADE   which OTHER switches this one silently renders inert. Turn off "Edit semantic
 *                 layers" and "Import layers" keeps reading ON while doing nothing at all.
 *
 * And the reassurance, which is not decoration: an admin who doesn't know a switch is
 * non-destructive will avoid a switch they should feel free to use.
 *
 * WE DID NOT MEASURE ≠ THERE IS NOTHING TO MEASURE. `impact.known === false` says so out loud
 * rather than showing an empty space, because an empty space on a confirmation screen is read as
 * reassurance, and this one would not have earned it.
 */
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Check, HelpCircle, Loader2, X, ZapOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { featuresService, type FeatureDefinition, type FeatureImpact } from '@/services/featuresService'
import { dependents } from './featureState'

export function ConfirmTurnOff({
    feature,
    allFeatures,
    values,
    onCancel,
    onConfirm,
}: {
    /** null closes it. */
    feature: FeatureDefinition | null
    allFeatures: FeatureDefinition[]
    values: Record<string, unknown>
    onCancel: () => void
    onConfirm: () => void | Promise<void>
}) {
    const [busy, setBusy] = useState(false)
    const [impact, setImpact] = useState<FeatureImpact | null>(null)

    // Measured when the dialog opens, not on every render of the page: this is a COUNT query per
    // flag, and running twelve of them to draw a list nobody has clicked yet would be rude.
    useEffect(() => {
        if (!feature) {
            setImpact(null)
            return
        }
        let live = true
        setImpact(null)
        void featuresService.impact(feature.key).then(result => {
            if (live) setImpact(result)
        })
        return () => {
            live = false
        }
    }, [feature])

    const cascade = feature ? dependents(feature, allFeatures, values) : []

    const commit = async () => {
        setBusy(true)
        try {
            await onConfirm()
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog.Root
            open={Boolean(feature)}
            onOpenChange={open => {
                if (!open && !busy) onCancel()
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content
                    className={cn(
                        'fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2',
                        'max-h-[85vh] overflow-y-auto',
                        'rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl focus:outline-none',
                        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
                    )}
                >
                    {feature && (
                        <>
                            <div className="flex items-start gap-4 p-6 pb-4">
                                <div className="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <Dialog.Title className="text-lg font-bold tracking-tight text-ink">
                                        Turn off {feature.name}?
                                    </Dialog.Title>
                                    <Dialog.Description className="mt-1 text-xs text-ink-muted">
                                        This takes effect immediately, for every user.
                                    </Dialog.Description>
                                </div>
                                <Dialog.Close
                                    disabled={busy}
                                    className="p-2 -m-1 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0 disabled:opacity-50"
                                    aria-label="Cancel"
                                >
                                    <X className="w-4 h-4" />
                                </Dialog.Close>
                            </div>

                            <div className="px-6 pb-2 space-y-4">
                                {feature.impactWhenOff && (
                                    <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                            What your users lose
                                        </p>
                                        <p className="mt-1.5 text-xs text-ink-secondary leading-relaxed">
                                            {feature.impactWhenOff}
                                        </p>
                                    </div>
                                )}

                                {/* THE CASCADE. Nothing else on this page would have told you. */}
                                {cascade.length > 0 && (
                                    <div className="rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.03] p-4">
                                        <p className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                            <ZapOff className="w-3 h-3" />
                                            This also stops
                                        </p>
                                        <ul className="mt-2 space-y-1.5">
                                            {cascade.map(dep => (
                                                <li key={dep.key} className="text-xs text-ink-secondary leading-relaxed">
                                                    <span className="font-semibold text-ink">{dep.name}</span> is on, and
                                                    will keep saying so — but it depends on this, so it will do nothing.
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                <ImpactBlock impact={impact} />

                                {/* The reassurance. An admin who doesn't know a switch is
                                    non-destructive will avoid one they should feel free to use. */}
                                {(feature.stillAllowed?.length ?? 0) > 0 && (
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                            Still works
                                        </p>
                                        <ul className="mt-2 space-y-1.5">
                                            {feature.stillAllowed!.map(item => (
                                                <li
                                                    key={item}
                                                    className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed"
                                                >
                                                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                                                    {item}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>

                            <div className="sticky bottom-0 flex items-center justify-end gap-2 p-6 pt-5 bg-canvas-elevated/95 backdrop-blur">
                                <button
                                    type="button"
                                    onClick={onCancel}
                                    disabled={busy}
                                    className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                >
                                    Keep it on
                                </button>
                                <button
                                    type="button"
                                    onClick={commit}
                                    disabled={busy}
                                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 transition-colors disabled:opacity-60 shadow-lg shadow-amber-600/20"
                                >
                                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                                    Turn off for everyone
                                </button>
                            </div>
                        </>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}

/** The count. The thing that turns a description into a decision. */
function ImpactBlock({ impact }: { impact: FeatureImpact | null }) {
    if (impact === null) {
        return (
            <div className="flex items-center gap-2 rounded-2xl border border-glass-border p-4">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />
                <p className="text-xs text-ink-muted">Checking what this would touch…</p>
            </div>
        )
    }

    // WE DIDN'T LOOK — say so. An empty space here reads as "nothing to worry about", and this one
    // has not earned that. `traceEnabled` has no usage telemetry, so there is no honest count of
    // who would lose trace; inventing one would be worse than admitting it.
    if (!impact.known) {
        return (
            <div className="flex items-start gap-2.5 rounded-2xl border border-glass-border p-4">
                <HelpCircle className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
                <p className="text-xs text-ink-muted leading-relaxed">
                    <span className="font-semibold text-ink-secondary">We can't measure this one.</span>{' '}
                    There's no reliable count of who is using it, so treat the description above as the
                    whole picture — not as proof that nothing is affected.
                </p>
            </div>
        )
    }

    if (impact.facts.length === 0) {
        return (
            <div className="flex items-start gap-2.5 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
                <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <p className="text-xs text-ink-secondary leading-relaxed">
                    <span className="font-semibold text-ink">Nothing in your estate uses this yet.</span>{' '}
                    We checked — there is nothing for this to take away.
                </p>
            </div>
        )
    }

    return (
        <div className="rounded-2xl border border-glass-border p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                In your estate, right now
            </p>
            <ul className="mt-2.5 space-y-2.5">
                {impact.facts.map(fact => (
                    <li key={fact.label} className="flex items-start gap-2.5">
                        <span
                            className={cn(
                                'shrink-0 mt-px px-1.5 py-0.5 rounded-md text-xs font-bold tabular-nums border',
                                fact.tone === 'warning'
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
                                    : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary border-glass-border',
                            )}
                        >
                            {fact.count}
                        </span>
                        <div className="min-w-0">
                            <p className="text-xs text-ink-secondary leading-relaxed">
                                <span className="font-semibold text-ink">{fact.label}</span> — {fact.consequence}
                            </p>
                            {fact.detail.length > 0 && (
                                <p className="mt-1 text-[11px] text-ink-muted">{fact.detail.join(' · ')}</p>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}
