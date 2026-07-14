/**
 * One feature, and everything you need to decide whether to turn it off.
 *
 * The old row gave a name, a sentence, and a switch that affects every user of the deployment.
 * The question an admin actually has — "what breaks if I turn this off?" — had no answer anywhere
 * on the page, so the honest way to use it was to flip a switch and go and look.
 *
 * Three things are answered here, in the order a person asks them:
 *
 *   WHAT IS IT   name + description                       (always visible)
 *   IS IT REAL   "Server-enforced" + what it gates        (a badge; the detail on demand)
 *   WHAT BREAKS  impactWhenOff + what still works         (see below)
 *
 * The impact is behind a disclosure while the feature is ON, because it is hypothetical — and
 * it comes OUT from behind that disclosure the moment the feature is OFF, because then it is not
 * hypothetical, it is a description of the product your users are looking at right now. A
 * consequence you have to click to see is a consequence people stop seeing.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, Check, ChevronDown, ExternalLink, Loader2, Lock, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureDefinition } from '@/services/featuresService'

/** A flag is "on" when its boolean is true, or its list has anything selected. */
function isOn(feature: FeatureDefinition, value: unknown): boolean {
    if (feature.type === 'string[]') return Array.isArray(value) && value.length > 0
    return Boolean(value)
}

function DetailList({ title, items, tone }: {
    title: string
    items: string[]
    tone: 'refuse' | 'hide' | 'keep'
}) {
    if (!items.length) return null
    const dot = {
        refuse: 'bg-rose-500/70',
        hide: 'bg-amber-500/70',
        keep: 'bg-emerald-500/70',
    }[tone]
    return (
        <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                {title}
            </p>
            <ul className="space-y-1">
                {items.map(item => (
                    <li key={item} className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed">
                        <span className={cn('w-1 h-1 rounded-full shrink-0 mt-[7px]', dot)} />
                        <span className="min-w-0">{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    )
}

export function FeatureRow({
    feature,
    value,
    onChange,
    saving,
    /** Names of dependencies that are currently OFF — this flag can't do anything while they are. */
    inertBecauseOf,
}: {
    feature: FeatureDefinition
    value: unknown
    onChange: (v: unknown) => void
    saving: boolean
    inertBecauseOf?: string[]
}) {
    const [open, setOpen] = useState(false)
    const on = isOn(feature, value)
    const inert = Boolean(inertBecauseOf?.length)

    const selected: string[] = Array.isArray(value) ? value : []
    const options = feature.options ?? []

    const hasDetail = Boolean(
        feature.serverGates?.length ||
        feature.uiSurfaces?.length ||
        feature.stillAllowed?.length ||
        feature.adminHint ||
        feature.helpUrl,
    )

    return (
        <div className="py-5 first:pt-0 last:pb-0 border-b border-glass-border last:border-b-0">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-ink">{feature.name}</span>

                        {/* The trust signal. Without it, an admin has no way to tell a real switch
                            from a decorative one — which is precisely how eight of these came to
                            do nothing for months without anybody noticing. */}
                        {feature.enforcedServerSide && (
                            <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium
                                           bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                                title="The server refuses these calls when this is off — not just the UI hiding a button."
                            >
                                <ShieldCheck className="w-3 h-3" />
                                Enforced
                            </span>
                        )}

                        {feature.posture === 'security' && (
                            <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium
                                           bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20"
                                title="If this setting can't be read, we assume the more restrictive answer."
                            >
                                <Lock className="w-3 h-3" />
                                Security
                            </span>
                        )}

                        {!on && !inert && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold
                                             bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/25">
                                Off
                            </span>
                        )}
                    </div>

                    <p className="text-sm text-ink-muted mt-1 leading-relaxed">{feature.description}</p>

                    {hasDetail && (
                        <button
                            type="button"
                            onClick={() => setOpen(o => !o)}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-ink-muted
                                       hover:text-ink transition-colors"
                            aria-expanded={open}
                        >
                            <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
                            {open ? 'Hide details' : 'What this controls'}
                        </button>
                    )}
                </div>

                <div className="shrink-0 flex items-center gap-2 pt-0.5">
                    {saving && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
                    {feature.type === 'boolean' && (
                        <ToggleSwitch
                            checked={on}
                            onChange={v => onChange(v)}
                            disabled={saving}
                            aria-label={`Turn ${feature.name} ${on ? 'off' : 'on'}`}
                        />
                    )}
                </div>
            </div>

            {/* A list flag isn't a switch — it's a set. Render the set. */}
            {feature.type === 'string[]' && (
                <div className="flex flex-wrap gap-2 mt-3">
                    {options.map(opt => {
                        const picked = selected.includes(opt.id)
                        // At least one must stay selected — an empty list would mean nobody can
                        // build anything, and the server refuses to save it anyway.
                        const isLastOne = picked && selected.length === 1
                        return (
                            <button
                                key={opt.id}
                                type="button"
                                disabled={saving || isLastOne}
                                onClick={() => onChange(
                                    picked ? selected.filter(id => id !== opt.id) : [...selected, opt.id],
                                )}
                                title={isLastOne ? 'At least one must stay available' : undefined}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                    picked
                                        ? 'bg-accent-lineage/10 text-accent-lineage border-accent-lineage/30'
                                        : 'bg-transparent text-ink-muted border-glass-border hover:text-ink hover:border-ink-muted/40',
                                    (saving || isLastOne) && 'opacity-60 cursor-not-allowed',
                                )}
                            >
                                {picked && <Check className="w-3 h-3" />}
                                {opt.label}
                            </button>
                        )
                    })}
                </div>
            )}

            {/* Inert: the switch is on, but a dependency is off, so it changes nothing. Saying so
                is the difference between a setting and a decoration. */}
            {inert && (
                <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]
                                border border-glass-border">
                    <AlertTriangle className="w-3.5 h-3.5 text-ink-muted shrink-0 mt-0.5" />
                    <p className="text-xs text-ink-muted leading-relaxed">
                        No effect while <span className="font-medium text-ink-secondary">
                            {inertBecauseOf!.join(' and ')}
                        </span> {inertBecauseOf!.length > 1 ? 'are' : 'is'} off — that switch already stops everyone.
                    </p>
                </div>
            )}

            {/* OFF is not a hypothetical. It is what your users are looking at right now, so it is
                stated without being asked for. */}
            {!on && !inert && feature.impactWhenOff && (
                <div className="mt-3 flex items-start gap-2.5 px-3 py-2.5 rounded-lg
                                bg-amber-500/[0.07] border border-amber-500/20">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                        <span className="font-semibold">Right now, for everyone: </span>
                        {feature.impactWhenOff}
                    </p>
                </div>
            )}

            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <div className="mt-4 p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-glass-border">
                            {/* While it's ON, the impact is the thing you came here to find out. */}
                            {on && feature.impactWhenOff && (
                                <div className="mb-4 pb-4 border-b border-glass-border">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                                        If you turn this off
                                    </p>
                                    <p className="text-xs text-ink-secondary leading-relaxed">
                                        {feature.impactWhenOff}
                                    </p>
                                </div>
                            )}

                            <div className="grid gap-4 sm:grid-cols-3">
                                <DetailList title="The server refuses" items={feature.serverGates ?? []} tone="refuse" />
                                <DetailList title="The UI hides" items={feature.uiSurfaces ?? []} tone="hide" />
                                <DetailList title="Still works" items={feature.stillAllowed ?? []} tone="keep" />
                            </div>

                            {feature.adminHint && (
                                <p className="mt-4 pt-3 border-t border-glass-border text-xs text-ink-muted leading-relaxed">
                                    {feature.adminHint}
                                </p>
                            )}

                            {feature.helpUrl && (
                                <a
                                    href={feature.helpUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    Documentation
                                </a>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
