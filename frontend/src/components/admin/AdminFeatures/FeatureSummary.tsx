/**
 * The state of the deployment, in one line.
 *
 * This page is a list of switches. What it never told you is the thing you actually came to find
 * out: which of them are currently OFF — i.e. what your users cannot do right now. That answer was
 * only obtainable by scrolling every category and reading every toggle.
 *
 * It also says, plainly, whether these switches are real. Every flag here is refused by the server
 * when it is off; for most of this product's life eight of them were refused by nobody, and there
 * was no way to tell the difference by looking. "All server-enforced" is the sentence that makes
 * the page trustworthy, and it is computed from the code, not asserted by hand.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import type { FeatureDefinition } from '@/services/featuresService'

function isOn(feature: FeatureDefinition, values: Record<string, unknown>): boolean {
    const value = values[feature.key] ?? feature.default
    if (feature.type === 'string[]') return Array.isArray(value) && value.length > 0
    return Boolean(value)
}

export function FeatureSummary({
    features,
    values,
}: {
    features: FeatureDefinition[]
    values: Record<string, unknown>
}) {
    const live = features.filter(f => !f.deprecated)
    if (!live.length) return null

    const off = live.filter(f => !isOn(f, values))
    const decorative = live.filter(f => f.enforcedServerSide !== true)

    return (
        <div className="mb-8 rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
                <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-ink tabular-nums">{live.length - off.length}</span>
                    <span className="text-sm text-ink-muted">of {live.length} on</span>
                </div>

                <div className="h-8 w-px bg-glass-border hidden sm:block" />

                {decorative.length === 0 ? (
                    <div className="flex items-center gap-2 min-w-0">
                        <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                        <p className="text-xs text-ink-secondary leading-relaxed min-w-0">
                            <span className="font-semibold text-ink">Every switch is enforced by the server.</span>{' '}
                            Turning one off doesn't just hide a button — the endpoint refuses the call.
                        </p>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 min-w-0">
                        <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
                        <p className="text-xs text-ink-secondary leading-relaxed min-w-0">
                            <span className="font-semibold text-ink">
                                {decorative.length} {decorative.length === 1 ? 'switch is' : 'switches are'} not enforced.
                            </span>{' '}
                            Turning {decorative.length === 1 ? 'it' : 'them'} off hides the control but the endpoint still answers.
                        </p>
                    </div>
                )}
            </div>

            {off.length > 0 && (
                <div className="px-5 py-3 border-t border-glass-border bg-amber-500/[0.05]">
                    <p className="text-xs text-ink-secondary leading-relaxed">
                        <span className="font-semibold text-amber-700 dark:text-amber-300">
                            Off for everyone right now:
                        </span>{' '}
                        {off.map(f => f.name).join(' · ')}
                    </p>
                </div>
            )}
        </div>
    )
}
