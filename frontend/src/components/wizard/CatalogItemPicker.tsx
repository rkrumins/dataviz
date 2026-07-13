/**
 * CatalogItemPicker — choosing a data source, as cards instead of a `<select>`.
 *
 * Both wizards that pick a data source (Create Workspace, Add Data Source) used a
 * native dropdown whose first option was literally "Skip for now...". A dropdown
 * shows one row at a time, hides the provider it belongs to, can't say whether an
 * item is already taken, and makes "skip" look like a data source called "Skip".
 *
 * The cards show what you actually need to choose between: which provider it comes
 * from, its source identifier, and — crucially — whether it's ALREADY attached to
 * another workspace, which the dropdown silently omitted (it just filtered those
 * rows out, so an item you were looking for simply wasn't there and nothing said
 * why).
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Search, Check, Database, SkipForward, Link2Off } from 'lucide-react'
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
}: {
    items: PickableCatalogItem[]
    providers: ProviderResponse[]
    selectedId: string
    onSelect: (id: string) => void
    allowSkip?: boolean
    skipLabel?: string
    skipHint?: string
}) {
    const [query, setQuery] = useState('')

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

    return (
        <div className="space-y-4">
            {!nothingAtAll && (
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

                {/* Already attached elsewhere. The old dropdown just dropped these,
                    so a source you knew existed was simply absent, unexplained. */}
                {filtered.taken.map(item => {
                    const Logo = getProviderLogo(providerType[item.providerId] ?? 'unknown')
                    return (
                        <PickerCard
                            key={item.id}
                            selected={false}
                            disabled
                            icon={<Logo className="w-4 h-4" />}
                            title={item.name}
                            subtitle={`Already used by ${item.boundWorkspaceName ?? 'another workspace'}`}
                            badge={<Link2Off className="w-3 h-3" />}
                        />
                    )
                })}
            </div>

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
