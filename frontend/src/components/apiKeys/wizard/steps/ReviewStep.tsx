/**
 * Step 5 — the last look.
 *
 * Sentences first, because a sentence is what a person can actually check
 * ("only answer calls from 203.0.113.0/24"), each with a way back to the step
 * that set it. Then how far a leaked copy would reach, with the reasons;
 * then the server's own preview of what the key would reach today — your
 * access as it is now, narrowed by the key — and last, confirming it's you.
 */
import {
    CalendarClock, ClipboardCheck, Network, Pencil, Shield, ShieldAlert, ShieldCheck, Target,
    TriangleAlert, Check, Activity,
} from 'lucide-react'
import { motion } from 'framer-motion'

import { StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import type { ApiKeyOptions, ApiKeyPermissions } from '@/services/apiKeyService'
import { AccessMatrix } from '../../AccessMatrix'
import { StepUpField } from '../../StepUpField'
import { expiryFields, formatDay, type ExpiryChoice } from '../../apiKeyFormat'
import type { ApiKeyDraft, WizardStep } from '../../apiKeyDraft'
import type { ApiKeyWizardState } from '../useApiKeyWizard'

/** "a and b", "a, b, and c". */
function listed(items: string[]): string {
    if (items.length < 3) return items.join(' and ')
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function does(p: ApiKeyPermissions): string {
    return `Act as you to ${listed([
        p.views === 'write' ? 'read and change views' : p.views === 'read' ? 'read views' : null,
        p.publish ? 'publish them to everyone' : null,
        p.data === 'write' ? 'read and change data' : p.data === 'read' ? 'read data' : null,
    ].filter((x): x is string => x !== null))}`
}

function names(items: { name: string }[]): string {
    const shown = items.slice(0, 3).map((i) => i.name)
    return items.length > 3 ? `${shown.join(', ')} and ${items.length - 3} more` : shown.join(', ')
}

function reaches(d: ApiKeyDraft, workspaces: ApiKeyOptions['workspaces']): string {
    if (d.resourceMode === 'all') return 'On everything you can access, including what you gain later'
    if (d.resourceMode === 'workspaces') {
        const picked = workspaces.filter((w) => d.workspaces.includes(w.id))
        return `In ${picked.length === 1 ? 'the workspace' : `${picked.length} workspaces:`} ${names(picked)} — including what is added to ${picked.length === 1 ? 'it' : 'them'}`
    }
    const items = [...d.views, ...d.dataSources]
    return `Only on the ${items.length} item${items.length === 1 ? '' : 's'} you picked: ${names(items)}`
}

function until(d: ApiKeyDraft): string {
    if (d.expiry === 'never') return 'Work until someone revokes it — it never expires'
    const { expiresAt } = expiryFields(d.expiry as ExpiryChoice, d.customDate)
    return expiresAt ? `Work until ${formatDay(expiresAt)}, then stop` : 'Work until the day you pick'
}

const BANDS = {
    low: {
        icon: ShieldCheck, fill: 'bg-emerald-500', track: 'bg-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400',
        ring: 'border-emerald-500/25 bg-emerald-500/[0.06]', blurb: 'Narrow and short-lived — a leaked copy could do little.',
    },
    moderate: {
        icon: Shield, fill: 'bg-indigo-500', track: 'bg-indigo-500/20', text: 'text-indigo-600 dark:text-indigo-400',
        ring: 'border-indigo-500/25 bg-indigo-500/[0.06]', blurb: 'Reasonable for a job you know — worth a glance at the reasons.',
    },
    high: {
        icon: ShieldAlert, fill: 'bg-amber-500', track: 'bg-amber-500/20', text: 'text-amber-600 dark:text-amber-400',
        ring: 'border-amber-500/25 bg-amber-500/[0.06]', blurb: 'A leaked copy could do a lot. Narrow it unless you meant this.',
    },
} as const

export function ReviewStep({ w, options, onEdit }: {
    w: ApiKeyWizardState
    options: ApiKeyOptions
    onEdit: (step: WizardStep) => void
}) {
    const d = w.draft
    const band = BANDS[w.exposure.band]
    const BandIcon = band.icon
    const preview = w.preview
    return (
        <StepColumn wide>
            <StepHero
                pill="Last look"
                pillIcon={ClipboardCheck}
                title="Check it, then create it"
                subtitle="This is everything the key will be able to do. Any line can be changed without losing the rest."
            />

            <StepBlock delay={0.04}>
                <div className="rounded-2xl border-2 border-black/[0.10] dark:border-white/[0.12] overflow-hidden bg-canvas-elevated">
                    <p className="px-4 pt-3.5 pb-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                        “{d.name.trim()}” will
                    </p>
                    <Sentence icon={Shield} text={does(d.permissions)} onEdit={() => onEdit('permissions')} tone={d.permissions.publish || d.permissions.data === 'write' ? 'warn' : undefined} />
                    <Sentence icon={Target} text={reaches(d, options.workspaces)} onEdit={() => onEdit('reach')} tone={d.resourceMode === 'all' ? 'warn' : undefined} />
                    <Sentence icon={CalendarClock} text={until(d)} onEdit={() => onEdit('safety')} tone={d.expiry === 'never' ? 'warn' : undefined} />
                    <Sentence
                        icon={Network}
                        text={d.cidrs.length > 0 ? `Only answer calls from ${d.cidrs.join(', ')}` : 'Answer calls from any network'}
                        onEdit={() => onEdit('safety')}
                    />
                </div>
            </StepBlock>

            <StepBlock delay={0.08}>
                <div className={cn('rounded-2xl border p-5', band.ring)}>
                    <div className="flex items-center gap-3 mb-3">
                        <span className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-canvas-elevated border', band.ring)}>
                            <BandIcon className={cn('w-5 h-5', band.text)} aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">If it leaked</p>
                                <p className={cn('text-sm font-bold', band.text)}>{w.exposure.label} exposure</p>
                            </div>
                            <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">{band.blurb}</p>
                        </div>
                    </div>
                    <div
                        role="meter"
                        aria-label="Exposure"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={w.exposure.pct}
                        aria-valuetext={w.exposure.label}
                        className={cn('h-2 w-full rounded-full overflow-hidden', band.track)}
                    >
                        <motion.div
                            className={cn('h-full rounded-full', band.fill)}
                            initial={false}
                            animate={{ width: `${w.exposure.pct}%` }}
                            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
                        />
                    </div>
                    <ul className="mt-3.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                        {w.exposure.reasons.map((r) => (
                            <li key={r} className="flex items-start gap-1.5 text-[11px] text-ink-secondary">
                                <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0 text-amber-500" aria-hidden /> {r}
                            </li>
                        ))}
                        {w.exposure.limits.map((r) => (
                            <li key={r} className="flex items-start gap-1.5 text-[11px] text-ink-secondary">
                                <Check className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-500" aria-hidden /> {r}
                            </li>
                        ))}
                    </ul>
                </div>
            </StepBlock>

            <StepBlock delay={0.12}>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                    <p className="text-sm font-semibold text-ink">What it would reach today</p>
                    {preview?.status === 'ready' && (
                        <p className="text-[11px] text-ink-muted tabular-nums">
                            Your key {preview.data.activeKeys + 1} of {preview.data.maxActiveKeys}
                        </p>
                    )}
                </div>
                {preview?.status === 'ready' ? (
                    <AccessMatrix access={preview.data.effectiveAccess} />
                ) : preview?.status === 'error' ? (
                    <p className="flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-xs text-amber-700 dark:text-amber-300">
                        <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden />
                        {preview.message}
                    </p>
                ) : (
                    <div className="space-y-2" aria-busy="true" aria-label="Checking what it would reach">
                        <Skeleton className="h-9 rounded-xl" />
                        <Skeleton className="h-9 rounded-xl" />
                        <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <Activity className="w-3 h-3" aria-hidden /> Asking the server what this key would reach…
                        </p>
                    </div>
                )}
            </StepBlock>

            <StepBlock delay={0.16}>
                <StepUpField
                    stepUp={options.stepUp}
                    available={w.stepUpAvailable}
                    password={w.password}
                    onPasswordChange={w.setPassword}
                    failed={w.passwordFailed}
                />
            </StepBlock>
        </StepColumn>
    )
}

function Sentence({ icon: Icon, text, onEdit, tone }: {
    icon: typeof Shield
    text: string
    onEdit: () => void
    tone?: 'warn'
}) {
    return (
        <div className="group flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.08] last:border-0">
            <span className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border',
                tone === 'warn'
                    ? 'bg-amber-500/10 border-amber-500/25 text-amber-500'
                    : 'bg-black/[0.03] dark:bg-white/[0.04] border-black/[0.06] dark:border-white/[0.08] text-ink-muted',
            )}>
                <Icon className="w-4 h-4" aria-hidden />
            </span>
            <p className="min-w-0 flex-1 text-sm text-ink leading-snug">{text}</p>
            <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-ink-muted group-hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
            >
                <Pencil className="w-3 h-3" aria-hidden />
                Change
            </button>
        </div>
    )
}
