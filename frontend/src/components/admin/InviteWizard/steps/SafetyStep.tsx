/**
 * Step 3 — how long the link lives and how many it admits.
 *
 * The two settings sit under a meter of what they add up to. Per the form
 * heuristic that is a meter, not a chart: one ratio against a ceiling,
 * where the fill carries severity and the unfilled track is a lighter step
 * of the same ramp, so the state reads across the whole bar rather than
 * only where the fill stops. Colour never carries it alone — the band and
 * the reasons are written beside it.
 */
import { motion } from 'framer-motion'
import { Clock, Users, ShieldCheck, ShieldAlert, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionLabel, FieldHint, ChipRow } from '../pickers'
import type { InviteWizardState, Expiry } from '../useInviteWizard'

const BANDS = {
    narrow: {
        label: 'Narrow', icon: ShieldCheck,
        fill: 'bg-emerald-500', track: 'bg-emerald-500/20',
        text: 'text-emerald-600 dark:text-emerald-400',
        ring: 'border-emerald-500/25 bg-emerald-500/[0.07]',
        blurb: 'Tightly bound — few people, and not for long.',
    },
    moderate: {
        label: 'Moderate', icon: Shield,
        fill: 'bg-indigo-500', track: 'bg-indigo-500/20',
        text: 'text-indigo-600 dark:text-indigo-400',
        ring: 'border-indigo-500/25 bg-indigo-500/[0.07]',
        blurb: 'Reasonable for a team you know — worth a glance before sending.',
    },
    wide: {
        label: 'Wide', icon: ShieldAlert,
        fill: 'bg-amber-500', track: 'bg-amber-500/20',
        text: 'text-amber-600 dark:text-amber-400',
        ring: 'border-amber-500/25 bg-amber-500/[0.07]',
        blurb: 'This link reaches a long way. Shorten it or cap it unless you meant that.',
    },
} as const

export function SafetyStep({ w }: { w: InviteWizardState }) {
    const band = BANDS[w.exposure.band]
    const BandIcon = band.icon

    // What is actually driving the number, in the user's own terms. A bar
    // with no explanation is a number to argue with, not act on.
    const drivers = [
        w.audience === 'anyone' ? 'anyone with the URL can redeem it'
            : w.audience === 'domain' ? 'anyone at the domain can redeem it'
                : 'pinned to a known address',
        w.maxUses === null ? 'no seat cap' : `${w.maxUses} seat${w.maxUses === 1 ? '' : 's'}`,
        `live for ${w.expiresIn}`,
        w.isPrivileged ? `grants ${w.roleLabel}` : null,
    ].filter(Boolean) as string[]

    return (
        <div>
            <h3 className="text-lg font-bold text-ink">How far should it reach?</h3>
            <p className="text-sm text-ink-muted mt-1 mb-5 leading-relaxed">
                A link is a credential. These two settings are what close it when you
                are not watching.
            </p>

            {/* ── Exposure meter ─────────────────────────────────────── */}
            <div className={cn('rounded-2xl border p-5 transition-colors', band.ring)}>
                <div className="flex items-center gap-3 mb-3">
                    <span className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-canvas-elevated border',
                        band.ring,
                    )}>
                        <BandIcon className={cn('w-5 h-5', band.text)} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                Reach
                            </p>
                            <p className={cn('text-sm font-bold', band.text)}>{band.label}</p>
                        </div>
                        <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                            {band.blurb}
                        </p>
                    </div>
                </div>

                <div className={cn('h-2 w-full rounded-full overflow-hidden', band.track)}>
                    <motion.div
                        className={cn('h-full rounded-full', band.fill)}
                        initial={false}
                        animate={{ width: `${w.exposure.pct}%` }}
                        transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-3">
                    {drivers.map((d, i) => (
                        <span key={d} className="text-[11px] text-ink-secondary">
                            {i > 0 && <span className="text-ink-muted/50 mr-2">·</span>}
                            {d}
                        </span>
                    ))}
                </div>
            </div>

            {/* ── Expiry ─────────────────────────────────────────────── */}
            <div className="mt-6">
                <SectionLabel>
                    <Clock className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
                    Link expires in
                </SectionLabel>
                <ChipRow
                    options={(['24h', '7d', '30d', '90d'] as const).map(v => ({ value: v as Expiry, label: v }))}
                    value={w.expiresIn}
                    onChange={w.setExpiresIn}
                />
                <FieldHint>
                    After this window the link stops working. Whoever has it will need a new one.
                </FieldHint>
            </div>

            {/* Seats are meaningless for a pinned link — one address, one
                account — so the control only appears where it can act. */}
            {(w.audience === 'domain' || w.audience === 'anyone') && (
                <div className="mt-6">
                    <SectionLabel>
                        <Users className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
                        How many people can use it
                    </SectionLabel>
                    <ChipRow
                        options={[
                            { value: 1, label: 'Just 1' },
                            { value: 5, label: 'Up to 5' },
                            { value: 25, label: 'Up to 25' },
                            { value: null, label: 'Unlimited' },
                        ]}
                        value={w.maxUses}
                        onChange={w.setMaxUses}
                    />
                    <FieldHint tone={w.maxUses === null ? 'warn' : undefined}>
                        {w.maxUses === null
                            ? 'Nothing closes this link but its expiry or a manual revoke.'
                            : `The link closes itself after ${w.maxUses} ${w.maxUses === 1 ? 'person signs' : 'people sign'} up.`}
                    </FieldHint>
                </div>
            )}

            {w.bulkMode && (
                <div className="mt-6 text-xs text-ink-muted leading-relaxed">
                    Each of the {w.bulkEmailList.length} links is pinned to one address and
                    good for one signup, so there is no seat cap to set.
                </div>
            )}
        </div>
    )
}
