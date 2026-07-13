/**
 * CatalogItemPicker — choosing a data source, given how allocation actually works.
 *
 * THE MODEL (which the old UI hid): a catalog item belongs to exactly ONE workspace.
 * `uq_ds_catalog_item` is a UNIQUE constraint on workspace_data_sources
 * .catalog_item_id — the database enforces it. Allocation happens at ONBOARDING:
 * AssetOnboardingWizard discovers assets, creates catalog items and assigns each to
 * a workspace (it can even create the workspace inline).
 *
 * So "already taken" is not an edge case, it is the steady state. In this instance
 * all 37 catalog items are allocated and ZERO are free — which is why "none of them
 * can be selected". The picker was not broken; it was showing an empty set
 * correctly and saying nothing about why.
 *
 * Three consequences this component now handles honestly:
 *
 *   1. AVAILABLE means unallocated. That is usually an empty list, so the empty
 *      state has to explain the model and point at the real path (onboard more
 *      assets from Ingestion) rather than looking like a bug.
 *
 *   2. Items owned by ANOTHER workspace are shown, disabled, naming the owner —
 *      not silently filtered out. Worse: the workspace detail page filtered on
 *      `permittedWorkspaces` (who MAY use an item) rather than ownership (who HAS
 *      it), so it offered owned items as selectable and the POST died on the unique
 *      constraint as an unhandled 500. That is now a 409, and these cards are dead.
 *
 *   3. They are collapsed behind a disclosure. With 37 allocated and 0 free, a grid
 *      of 37 dead cards would bury the one thing you can actually do.
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Search, Check, Database, SkipForward, Link2Off, Info, ArrowRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import type { ProviderResponse } from '@/services/providerService'

/**
 * The minimum a card needs. Both CatalogItemResponse (workspace detail page) and
 * CatalogItemBindingResponse (workspaces page) satisfy it structurally — the
 * binding fields are optional, so a caller that doesn't know what's taken simply
 * doesn't mark anything taken.
 */
export interface PickableCatalogItem {
    id: string
    providerId: string
    name: string
    sourceIdentifier?: string
    boundWorkspaceId?: string | null
    boundWorkspaceName?: string | null
}

export function CatalogItemPicker({
    items,
    providers,
    selectedId,
    onSelect,
    /** Renders a first-class "skip" card. Create Workspace allows it; Add Data Source doesn't. */
    allowSkip,
    skipLabel = 'Skip for now',
    skipHint = 'Create it empty and attach data later',
    /** Lets the picker say "this workspace already has it" rather than naming it as an owner. */
    currentWorkspaceId,
}: {
    items: PickableCatalogItem[]
    providers: ProviderResponse[]
    selectedId: string
    onSelect: (id: string) => void
    allowSkip?: boolean
    skipLabel?: string
    skipHint?: string
    currentWorkspaceId?: string
}) {
    const [query, setQuery] = useState('')
    const [showTaken, setShowTaken] = useState(false)

    const providerType = useMemo(() => {
        const map: Record<string, string> = {}
        for (const p of providers) map[p.id] = p.providerType
        return map
    }, [providers])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        const available = items.filter(i => !i.boundWorkspaceId)
        const taken = items.filter(i => i.boundWorkspaceId)
        const match = (i: PickableCatalogItem) =>
            !q
            || i.name.toLowerCase().includes(q)
            || (i.sourceIdentifier ?? '').toLowerCase().includes(q)
        // Available first — but the taken ones stay VISIBLE (disabled), because
        // silently omitting them is why "where is my data source?" happens.
        return { available: available.filter(match), taken: taken.filter(match) }
    }, [items, query])

    const nothingAtAll = items.length === 0
    const noneFree = !nothingAtAll && filtered.available.length === 0 && !query.trim()

    return (
        <div className="space-y-4">
            {!nothingAtAll && !noneFree && (
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search data sources…"
                        className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                    />
                </div>
            )}

            {noneFree && (
                <div className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/[0.08] p-5">
                    <div className="flex items-start gap-3">
                        <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 dark:text-white">
                                Every data source is already allocated
                            </p>
                            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                                A data source belongs to exactly one workspace. New ones appear here
                                when you onboard assets from a provider — that's where a source is
                                assigned to its workspace.
                            </p>
                            <Link
                                to="/ingestion?tab=assets"
                                className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-blue-600 dark:text-blue-400 hover:underline"
                            >
                                Onboard assets in Ingestion
                                <ArrowRight className="w-3.5 h-3.5" />
                            </Link>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {allowSkip && (
                    <PickerCard
                        selected={selectedId === ''}
                        onClick={() => onSelect('')}
                        icon={<SkipForward className="w-4 h-4" />}
                        title={skipLabel}
                        subtitle={skipHint}
                        dashed
                    />
                )}

                {filtered.available.map(item => {
                    const Logo = getProviderLogo(providerType[item.providerId] ?? 'unknown')
                    return (
                        <PickerCard
                            key={item.id}
                            selected={selectedId === item.id}
                            onClick={() => onSelect(item.id)}
                            icon={<Logo className="w-4 h-4" />}
                            title={item.name}
                            subtitle={item.sourceIdentifier ?? 'No source identifier'}
                        />
                    )
                })}

                {showTaken && filtered.taken.map(item => {
                    const Logo = getProviderLogo(providerType[item.providerId] ?? 'unknown')
                    const isMine = currentWorkspaceId && item.boundWorkspaceId === currentWorkspaceId
                    return (
                        <PickerCard
                            key={item.id}
                            selected={false}
                            disabled
                            icon={<Logo className="w-4 h-4" />}
                            title={item.name}
                            subtitle={isMine
                                ? 'Already on this workspace'
                                : `Used by ${item.boundWorkspaceName ?? 'another workspace'}`}
                            badge={<Link2Off className="w-3 h-3" />}
                        />
                    )
                })}
            </div>

            {/* Visible, but not in the way. The old dropdown omitted these entirely,
                so a source you knew existed simply wasn't there and nothing said why. */}
            {filtered.taken.length > 0 && (
                <button
                    type="button"
                    onClick={() => setShowTaken(v => !v)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                >
                    <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showTaken && 'rotate-180')} />
                    {showTaken ? 'Hide' : 'Show'} {filtered.taken.length} source{filtered.taken.length === 1 ? '' : 's'} allocated to other workspaces
                </button>
            )}

            {nothingAtAll && (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
                    <Database className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">No data sources in the catalog</p>
                    <p className="text-xs text-slate-500 mt-1">
                        Connect a provider under Ingestion first — then its assets appear here.
                    </p>
                </div>
            )}

            {!nothingAtAll && filtered.available.length === 0 && filtered.taken.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-4">No data source matches “{query}”.</p>
            )}
        </div>
    )
}

function PickerCard({ selected, disabled, onClick, icon, title, subtitle, dashed, badge }: {
    selected: boolean
    disabled?: boolean
    onClick?: () => void
    icon: React.ReactNode
    title: string
    subtitle: string
    dashed?: boolean
    badge?: React.ReactNode
}) {
    return (
        <motion.button
            type="button"
            disabled={disabled}
            onClick={onClick}
            whileHover={disabled ? undefined : { scale: 1.01 }}
            whileTap={disabled ? undefined : { scale: 0.99 }}
            className={cn(
                'relative flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-colors',
                dashed && 'border-dashed',
                disabled
                    ? 'border-slate-200 dark:border-slate-800 opacity-55 cursor-not-allowed'
                    : selected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-4 ring-blue-500/10'
                        : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700',
            )}
        >
            <span className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 text-slate-600 dark:text-slate-300">
                {icon}
            </span>

            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-900 dark:text-white truncate">{title}</span>
                <span className="block text-xs text-slate-500 truncate mt-0.5">{subtitle}</span>
            </span>

            {badge && (
                <span className="shrink-0 text-slate-400 mt-0.5">{badge}</span>
            )}

            {selected && !disabled && (
                <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"
                >
                    <Check className="w-3 h-3 text-white" />
                </motion.span>
            )}
        </motion.button>
    )
}
