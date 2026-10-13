/**
 * Step 3 — what the key may do where it reaches.
 *
 * Each level is a card that says what a script holding it can actually do,
 * because "write" means nothing until it reads "change graph data and tell
 * the platform a source changed". Publishing is a switch beside views, and
 * only there: it is a way of changing a view, so it needs views read & write.
 */
import { CheckCircle2, Database, Eye, Megaphone, ShieldCheck, TriangleAlert } from 'lucide-react'

import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { FieldLabel, StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import { cn } from '@/lib/utils'
import type { Level } from '@/services/apiKeyService'
import { overreach } from '../../apiKeyFormat'
import type { ApiKeyWizardState } from '../useApiKeyWizard'

const LEVELS: Record<'views' | 'data', { value: Level; label: string; says: string }[]> = {
    views: [
        { value: 'none', label: 'No access', says: 'It cannot open views.' },
        { value: 'read', label: 'Read', says: 'Open views and read their layers, layouts and lineage.' },
        { value: 'write', label: 'Read & write', says: 'Also create, change and delete views and their drafts.' },
    ],
    data: [
        { value: 'none', label: 'No access', says: 'It cannot read graphs or data sources.' },
        { value: 'read', label: 'Read', says: 'Query graphs, traces and data source details.' },
        { value: 'write', label: 'Read & write', says: 'Also change graph data and signal that a data source changed.' },
    ],
}

export function PermissionsStep({ w }: { w: ApiKeyWizardState }) {
    const p = w.draft.permissions
    const short = w.draft.resourceMode === 'items' ? overreach(p, w.draft.views, w.draft.dataSources) : []
    return (
        <StepColumn wide>
            <StepHero
                pill="Permissions"
                pillIcon={ShieldCheck}
                title="What may it do there?"
                subtitle="Each level says what a script holding the key can do. It never does more than you can."
            />

            <StepBlock delay={0.04}>
                <LevelCards kind="views" icon={Eye} title="Views" value={p.views} onChange={(views) => w.setPermissions({ views })} />
                <label
                    className={cn(
                        'mt-3 flex items-center gap-3 pl-4 pr-2 rounded-2xl border-2 transition-colors',
                        p.views === 'write'
                            ? p.publish ? 'border-violet-500/50 bg-violet-500/[0.05]' : 'border-black/[0.10] dark:border-white/[0.12]'
                            : 'border-dashed border-black/[0.08] dark:border-white/[0.10] opacity-60',
                    )}
                >
                    <Megaphone className={cn('w-5 h-5 shrink-0', p.publish ? 'text-violet-500' : 'text-ink-muted')} aria-hidden />
                    <span className="min-w-0 flex-1 py-3">
                        <span className="block text-sm font-semibold text-ink">Publish views to everyone</span>
                        <span className="block text-xs text-ink-muted leading-relaxed">
                            {p.views === 'write'
                                ? 'Make its changes visible to everyone who can see the view, without a review.'
                                : 'Needs Views: read & write.'}
                        </span>
                    </span>
                    <ToggleSwitch
                        size="sm"
                        checked={p.publish}
                        disabled={p.views !== 'write'}
                        aria-label="Publish views to everyone"
                        onChange={(publish) => w.setPermissions({ publish })}
                    />
                </label>
            </StepBlock>

            <StepBlock delay={0.08}>
                <LevelCards kind="data" icon={Database} title="Data" value={p.data} onChange={(data) => w.setPermissions({ data })} />
            </StepBlock>

            {!w.valid.permissions && (
                <StepBlock>
                    <p className="text-center text-xs text-amber-600 dark:text-amber-400">
                        Give it read on views or data — a key that can do nothing is no use to anyone.
                    </p>
                </StepBlock>
            )}

            {short.length > 0 && (
                <StepBlock delay={0.12}>
                    <p className="flex items-start gap-2.5 p-3.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                        <TriangleAlert className="w-4 h-4 shrink-0 text-amber-500" aria-hidden />
                        <span>
                            You can only read {short.map((s) => `“${s.name}”`).join(', ')} — the key will only
                            read {short.length === 1 ? 'it' : 'them'} too. A key never reaches past you.
                        </span>
                    </p>
                </StepBlock>
            )}
        </StepColumn>
    )
}

function LevelCards({ kind, icon: Icon, title, value, onChange }: {
    kind: 'views' | 'data'
    icon: typeof Eye
    title: string
    value: Level
    onChange: (level: Level) => void
}) {
    return (
        <div>
            <FieldLabel>
                <Icon className="w-4 h-4 inline-block mr-1.5 -mt-0.5 text-indigo-500" aria-hidden />
                {title}
            </FieldLabel>
            <div role="radiogroup" aria-label={title} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {LEVELS[kind].map((l) => {
                    const on = value === l.value
                    return (
                        <button
                            key={l.value}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => onChange(l.value)}
                            className={cn(
                                'p-3.5 rounded-xl border-2 text-left transition-colors duration-150',
                                on
                                    ? l.value === 'write' ? 'border-emerald-500 bg-emerald-500/[0.06]' : 'border-indigo-500 bg-indigo-500/[0.07]'
                                    : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40',
                            )}
                        >
                            <span className="flex items-center justify-between gap-2">
                                <span className={cn(
                                    'text-sm font-semibold',
                                    on ? (l.value === 'write' ? 'text-emerald-700 dark:text-emerald-300' : 'text-indigo-600 dark:text-indigo-400') : 'text-ink',
                                )}>
                                    {l.label}
                                </span>
                                {on && <CheckCircle2 className={cn('w-4 h-4 shrink-0', l.value === 'write' ? 'text-emerald-500' : 'text-indigo-500')} aria-hidden />}
                            </span>
                            {' '}
                            <span className="block mt-1 text-xs leading-relaxed text-ink-muted">{l.says}</span>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
