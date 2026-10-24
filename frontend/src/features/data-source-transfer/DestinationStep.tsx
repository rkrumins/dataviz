/**
 * DestinationStep — where the data source should go.
 *
 * Every workspace the person can see, grouped by what they may do there:
 * move it now (they run both), ask its admins (they run only this one), or
 * not at all — and then the card says why, rather than leaving a workspace
 * mysteriously missing from the list.
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Boxes, Check, ChevronDown, Clock, Loader2, MapPin, RefreshCw, Search, ShieldCheck, Send } from 'lucide-react'

import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { MOTION } from '@/lib/motion'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import type { DataSourceTransferResponse, TransferDestination } from '@/services/dataSourceTransferService'
import { WorkspaceTile } from './TransferRoute'
import { plural, workspaceLabel } from './transferCopy'

const SEARCH_FROM = 6

export function DestinationStep({
    sourceName, fromName, destinations, isLoading, error, onRetry, selectedId, onSelect,
    pending, onCancelPending, cancelling,
}: {
    sourceName: string
    fromName: string
    destinations: TransferDestination[] | undefined
    isLoading: boolean
    error: Error | null
    onRetry: () => void
    selectedId: string | null
    onSelect: (destination: TransferDestination) => void
    /** A request for this source still waiting on someone. */
    pending?: DataSourceTransferResponse | null
    onCancelPending?: () => void
    cancelling?: boolean
}) {
    const [query, setQuery] = useState('')
    const [showUnavailable, setShowUnavailable] = useState(false)
    const list = useMemo(() => destinations ?? [], [destinations])

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase()
        const match = (d: TransferDestination) => !q
            || d.name.toLowerCase().includes(q)
            || (d.description ?? '').toLowerCase().includes(q)
        const found = list.filter(match)
        return {
            direct: found.filter(d => d.mode === 'direct'),
            request: found.filter(d => d.mode === 'request'),
            unavailable: found.filter(d => !d.mode),
        }
    }, [list, query])

    return (
        <div className="space-y-5">
            <div className="flex items-start gap-3">
                <span className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                    <MapPin className="w-5 h-5" aria-hidden />
                </span>
                <div>
                    <h3 className="text-lg font-bold text-ink">Where should {sourceName} go?</h3>
                    <p className="text-sm text-ink-muted">
                        It leaves {fromName} with its views, version history and settings.
                    </p>
                </div>
            </div>

            {pending && (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
                    <Clock className="w-4 h-4 text-amber-500 shrink-0" aria-hidden />
                    <p className="flex-1 min-w-[14rem] text-sm text-ink">
                        A transfer to <span className="font-semibold">{workspaceLabel(pending.toWorkspace.name)}</span> is
                        waiting for its admins
                        <span className="text-ink-muted"> — asked {timeAgo(pending.createdAt)}. Cancel it to ask another
                            workspace; you can still move directly where you run both.</span>
                    </p>
                    {pending.canCancel && onCancelPending && (
                        <button
                            type="button"
                            onClick={onCancelPending}
                            disabled={cancelling}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/15 disabled:opacity-50"
                        >
                            {cancelling && <Loader2 className="w-3 h-3 animate-spin" />}
                            Cancel request
                        </button>
                    )}
                </div>
            )}

            {list.length > SEARCH_FROM && (
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search workspaces…"
                        aria-label="Search workspaces"
                        className="input h-10 w-full pl-10 text-sm"
                    />
                </div>
            )}

            {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-busy="true">
                    {Array.from({ length: 6 }, (_, i) => (
                        <div key={i} className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] p-4 flex gap-3">
                            <Skeleton className="w-11 h-11 rounded-xl" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-3.5 w-2/3" />
                                <Skeleton className="h-3 w-full" />
                                <Skeleton className="h-4 w-1/2" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : error ? (
                <div role="alert" className="flex items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3">
                    <p className="flex-1 text-sm text-rose-600 dark:text-rose-400">Couldn’t load workspaces: {error.message}</p>
                    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">
                        <RefreshCw className="w-3.5 h-3.5" /> Retry
                    </button>
                </div>
            ) : list.length === 0 ? (
                <EmptyState
                    icon={Boxes}
                    title="No other workspace can take it"
                    description="A source can only move to a workspace you can see. When Find a workspace is on, it lists more of them."
                />
            ) : (
                <div role="radiogroup" aria-label="Destination workspace" className="space-y-5">
                    <Group
                        title="Moves now"
                        hint="You run both workspaces"
                        destinations={groups.direct}
                        selectedId={selectedId}
                        onSelect={onSelect}
                    />
                    <Group
                        title="Needs their approval"
                        hint="Its admins review your request"
                        destinations={groups.request}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        disabled={!!pending}
                    />
                    {groups.unavailable.length > 0 && (
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowUnavailable(v => !v)}
                                aria-expanded={showUnavailable}
                                className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
                            >
                                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showUnavailable && 'rotate-180')} />
                                {plural(groups.unavailable.length, 'workspace')} can’t take it
                            </button>
                            {showUnavailable && (
                                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {groups.unavailable.map(d => (
                                        <DestinationCard key={d.id} destination={d} selected={false} disabled />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {groups.direct.length + groups.request.length + groups.unavailable.length === 0 && (
                        <p className="text-xs text-ink-muted text-center py-4">No workspace matches “{query}”.</p>
                    )}
                </div>
            )}
        </div>
    )
}

function Group({ title, hint, destinations, selectedId, onSelect, disabled }: {
    title: string
    hint: string
    destinations: TransferDestination[]
    selectedId: string | null
    onSelect: (destination: TransferDestination) => void
    disabled?: boolean
}) {
    if (destinations.length === 0) return null
    return (
        <section aria-label={title}>
            <div className="flex items-baseline gap-2 mb-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{title}</h4>
                <span className="text-[11px] text-ink-muted">{hint}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {destinations.map((d, i) => (
                    <motion.div
                        key={d.id}
                        initial={{ opacity: 0, y: MOTION.cardY }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ ...MOTION.cardEntry, delay: i * MOTION.cardStagger }}
                    >
                        <DestinationCard
                            destination={d}
                            selected={selectedId === d.id}
                            disabled={disabled}
                            onSelect={() => onSelect(d)}
                        />
                    </motion.div>
                ))}
            </div>
        </section>
    )
}

function DestinationCard({ destination: d, selected, disabled, onSelect }: {
    destination: TransferDestination
    selected: boolean
    disabled?: boolean
    onSelect?: () => void
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={onSelect}
            className={cn(
                'relative w-full flex items-start gap-3 rounded-2xl border p-4 text-left transition-colors',
                disabled
                    ? 'border-black/[0.08] dark:border-white/[0.10] opacity-60 cursor-not-allowed'
                    : selected
                        ? 'border-indigo-500/50 bg-indigo-500/[0.06] ring-2 ring-indigo-500/20'
                        : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-indigo-500/30',
            )}
        >
            <WorkspaceTile workspace={{ id: d.id, name: d.name }} />
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink truncate pr-6">{d.name}</span>
                <span className="block text-xs text-ink-muted truncate">{d.description || 'No description'}</span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary tabular-nums">
                        {plural(d.dataSourceCount, 'source')}
                    </span>
                    {d.mode === 'direct' && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck className="w-2.5 h-2.5" aria-hidden /> You run both — moves now
                        </span>
                    )}
                    {d.mode === 'request' && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                            <Send className="w-2.5 h-2.5" aria-hidden /> Its admins review it
                        </span>
                    )}
                    {!d.mode && d.reason && (
                        <span className="text-[10px] font-medium text-ink-muted">{d.reason}</span>
                    )}
                </span>
            </span>
            {selected && (
                <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center"
                >
                    <Check className="w-3 h-3 text-white" aria-hidden />
                </motion.span>
            )}
        </button>
    )
}
