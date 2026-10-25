/**
 * Step 2 — what the key reaches.
 *
 * Three answers, from narrow to broad, and the narrow one is recommended
 * because it is what limits a leaked copy: particular views and data sources
 * stay the same set, while a whole workspace — or everything the keys' owner
 * can access — grows with whatever is added to it later.
 */
import { CheckCircle2, Crosshair, Globe, LayoutGrid, Target, TriangleAlert } from 'lucide-react'

import { StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import { cn } from '@/lib/utils'
import type { ApiKeyOptions } from '@/services/apiKeyService'
import type { ResourceMode } from '../../apiKeyDraft'
import { useOwnerWords } from '../../keyClient'
import { ResourcePicker, WorkspacePicker } from '../../pickers'
import type { ApiKeyWizardState } from '../useApiKeyWizard'

const MODES: { value: ResourceMode; label: string; hint: string; icon: typeof Globe; tone: string; flag?: { label: string; tone: string } }[] = [
    {
        value: 'items', label: 'Selected views & data sources', icon: Crosshair,
        hint: 'Only what you pick. Anything new stays out.',
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
        flag: { label: 'Recommended', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
    },
    {
        value: 'workspaces', label: 'Selected workspaces', icon: LayoutGrid,
        hint: 'Everything in them, including what is added later.',
        tone: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/25',
    },
    {
        value: 'all', label: 'Everything I can access', icon: Globe,
        hint: 'Every workspace you are in, now and later.',
        tone: 'text-amber-500 bg-amber-500/10 border-amber-500/25',
        flag: { label: 'Broad', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
    },
]

export function ReachStep({ w, options }: { w: ApiKeyWizardState; options: ApiKeyOptions }) {
    const mode = w.draft.resourceMode
    const owner = useOwnerWords()
    // A service account's keys reach what the account reaches, not you.
    const modes = owner.you ? MODES : MODES.map((m) => (m.value === 'all'
        ? { ...m, label: `Everything ${owner.object} can access`, hint: 'Every workspace it is in, now and later.' }
        : m))
    return (
        <StepColumn wide>
            <StepHero
                pill="Reach"
                pillIcon={Target}
                title="What should it reach?"
                subtitle="The less a key can reach, the less a leaked copy can do. Pick the narrowest thing that does the job."
            />

            <StepBlock delay={0.04}>
                <div role="radiogroup" aria-label="What it can reach" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {modes.map((m) => {
                        const Icon = m.icon
                        const on = mode === m.value
                        return (
                            <button
                                key={m.value}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                onClick={() => w.update({ resourceMode: m.value })}
                                className={cn(
                                    'group relative flex sm:flex-col items-start gap-3 p-4 rounded-2xl border-2 text-left transition-colors duration-150',
                                    on
                                        ? m.value === 'all' ? 'border-amber-500 bg-amber-500/[0.07]' : 'border-indigo-500 bg-indigo-500/[0.07]'
                                        : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40',
                                )}
                            >
                                {on && (
                                    <CheckCircle2
                                        aria-hidden
                                        className={cn('absolute top-3.5 right-3.5 w-[18px] h-[18px]', m.value === 'all' ? 'text-amber-500' : 'text-indigo-500')}
                                    />
                                )}
                                <span className={cn('w-11 h-11 rounded-xl border flex items-center justify-center shrink-0', m.tone)}>
                                    <Icon className="w-5 h-5" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-semibold text-ink pr-5">{m.label}</span>
                                    {' '}
                                    <span className="block mt-1 text-xs leading-relaxed text-ink-muted">{m.hint}</span>
                                    {m.flag && (
                                        <span className={cn('inline-block mt-2 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide', m.flag.tone)}>
                                            {m.flag.label}
                                        </span>
                                    )}
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>

            <StepBlock delay={0.08}>
                {mode === 'items' && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <ResourcePicker
                            type="view"
                            label="Views"
                            selected={w.draft.views}
                            permissions={w.draft.permissions}
                            onChange={(views) => w.update({ views })}
                        />
                        <ResourcePicker
                            type="data_source"
                            label="Data sources"
                            selected={w.draft.dataSources}
                            permissions={w.draft.permissions}
                            onChange={(dataSources) => w.update({ dataSources })}
                        />
                    </div>
                )}
                {mode === 'workspaces' && (
                    <WorkspacePicker
                        workspaces={options.workspaces}
                        selected={w.draft.workspaces}
                        permissions={w.draft.permissions}
                        onChange={(workspaces) => w.update({ workspaces })}
                    />
                )}
                {mode === 'all' && (
                    <p className="flex items-start gap-3 p-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
                        <TriangleAlert className="w-5 h-5 shrink-0 text-amber-500" aria-hidden />
                        A copy of this key could reach everything {owner.object} can — in every workspace, today and
                        as {owner.possessive} access grows. Choose it only for a tool that really needs all of it.
                    </p>
                )}
            </StepBlock>
        </StepColumn>
    )
}
