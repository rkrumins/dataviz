/**
 * Step 1 — what the key is for.
 *
 * A job, not a permission: "read data for reporting" is something a person
 * knows the answer to before they open this, and it sets the access, the
 * reach and the lifetime that suit it. A job you cannot do yourself is shown
 * but closed, with why — a key never holds more than its owner.
 */
import { BarChart3, CheckCircle2, Clock, Lock, Rocket, Shield, SlidersHorizontal, Sparkles, Upload } from 'lucide-react'

import {
    BigInput, BigTextarea, FieldLabel, Hint, StepBlock, StepColumn, StepHero,
} from '@/components/admin/InviteWizard/ui'
import { cn } from '@/lib/utils'
import type { ApiKeyOptions } from '@/services/apiKeyService'
import { describePermissions, expiryOptions, fitExpiry } from '../../apiKeyFormat'
import { PRESETS, presetAvailability, presetById, type PresetId } from '../../presets'
import type { ApiKeyWizardState } from '../useApiKeyWizard'

const LOOK: Record<PresetId, { icon: typeof BarChart3; tone: string }> = {
    reporting: { icon: BarChart3, tone: 'text-sky-500 bg-sky-500/10 border-sky-500/25' },
    loading: { icon: Upload, tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25' },
    publishing: { icon: Rocket, tone: 'text-violet-500 bg-violet-500/10 border-violet-500/25' },
    custom: { icon: SlidersHorizontal, tone: 'text-slate-500 bg-slate-500/10 border-slate-500/25' },
}

export function PurposeStep({ w, options }: { w: ApiKeyWizardState; options: ApiKeyOptions }) {
    const chosen = presetById(w.draft.preset)
    const max = options.policy.maxLifetimeDays
    return (
        <StepColumn wide>
            <StepHero
                pill="Start here"
                pillIcon={Sparkles}
                title="What is this key for?"
                subtitle="Pick the closest job. It sets sensible access and a lifetime — every choice stays yours to change on the next steps."
            />

            <StepBlock delay={0.04}>
                <div role="radiogroup" aria-label="What the key is for" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {PRESETS.map((p) => {
                        const { icon: Icon, tone } = LOOK[p.id]
                        const selected = w.draft.preset === p.id
                        const availability = presetAvailability(p, options.workspaces)
                        const lasts = expiryOptions(max).find((o) => o.value === fitExpiry(p.expiry, max))?.label
                        return (
                            <button
                                key={p.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={!availability.available}
                                onClick={() => w.pickPreset(p)}
                                className={cn(
                                    'group relative flex flex-col gap-3 p-4 rounded-2xl border-2 text-left transition-colors duration-150',
                                    'disabled:cursor-not-allowed',
                                    selected
                                        ? 'border-indigo-500 bg-indigo-500/[0.07] shadow-sm'
                                        : availability.available
                                            ? 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40'
                                            : 'border-dashed border-black/[0.10] dark:border-white/[0.12] bg-black/[0.015] dark:bg-white/[0.02]',
                                )}
                            >
                                <span className="flex items-start gap-3">
                                    <span className={cn(
                                        'w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 transition-transform duration-150',
                                        availability.available ? cn(tone, 'group-hover:scale-105') : 'text-ink-muted bg-black/[0.03] dark:bg-white/[0.04] border-transparent',
                                    )}>
                                        {availability.available ? <Icon className="w-5 h-5" aria-hidden /> : <Lock className="w-5 h-5" aria-hidden />}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className={cn(
                                                'text-sm font-semibold',
                                                selected ? 'text-indigo-600 dark:text-indigo-400' : availability.available ? 'text-ink' : 'text-ink-muted',
                                            )}>
                                                {p.title}
                                            </span>
                                            {selected && <CheckCircle2 className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />}
                                        </span>
                                        {' '}
                                        <span className="block mt-1 text-xs leading-relaxed text-ink-muted">{p.blurb}</span>
                                    </span>
                                </span>
                                {availability.available ? (
                                    <span className={cn(
                                        'flex items-stretch gap-3 pt-3 border-t',
                                        selected ? 'border-indigo-500/20' : 'border-black/[0.07] dark:border-white/[0.09]',
                                    )}>
                                        <Meta icon={Shield} label="Can" value={describePermissions(p.permissions).replace(/ · /g, ', ')} selected={selected} />
                                        <Meta icon={Clock} label="Lasts" value={lasts ?? '—'} selected={selected} narrow />
                                    </span>
                                ) : (
                                    <span className="pt-3 border-t border-black/[0.07] dark:border-white/[0.09] text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                        {availability.reason}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            </StepBlock>

            <StepBlock delay={0.08}>
                <FieldLabel required>Name</FieldLabel>
                <BigInput
                    aria-label="Name"
                    value={w.draft.name}
                    maxLength={80}
                    placeholder={chosen ? `For example, “${chosen.example}”` : 'Where it is used, like “nightly lineage sync”'}
                    onChange={(e) => w.update({ name: e.target.value })}
                />
                <Hint>Say where it runs — you will recognise it in a year, and so will an administrator.</Hint>
            </StepBlock>

            <StepBlock delay={0.12}>
                <FieldLabel hint="optional">Description</FieldLabel>
                <BigTextarea
                    aria-label="Description"
                    rows={2}
                    maxLength={500}
                    value={w.draft.description}
                    placeholder="What it does and who to ask about it"
                    onChange={(e) => w.update({ description: e.target.value })}
                    className="font-sans"
                />
            </StepBlock>
        </StepColumn>
    )
}

function Meta({ icon: Icon, label, value, selected, narrow }: {
    icon: typeof Shield
    label: string
    value: string
    selected: boolean
    narrow?: boolean
}) {
    return (
        <span className={cn('min-w-0', narrow ? 'shrink-0' : 'flex-1')}>
            <span className="flex items-center gap-1 text-ink-muted">
                <Icon className="w-3 h-3 shrink-0" aria-hidden />
                <span className="text-[10px] font-medium">{label}</span>
            </span>
            <span className={cn(
                'block text-xs font-semibold mt-0.5 truncate',
                selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink',
            )}>
                {value}
            </span>
        </span>
    )
}
