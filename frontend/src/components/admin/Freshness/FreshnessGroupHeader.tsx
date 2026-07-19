/**
 * FreshnessGroupHeader — one provider group's header row. Collapsed, it is a
 * self-contained rollup ("«provider» · N sources · n ready · n not built ·
 * n attention"); expanded, it just names the provider and its size, with the
 * rows rendered beneath by the parent. Either way it carries the collapse
 * affordance (``aria-expanded``) and the admin-gated Refresh-provider action.
 */
import { ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FreshnessRow } from '@/services/freshnessService'
import { isGroupAttention, isNeverBuilt } from './freshnessTriage'

interface Props {
    providerId: string
    name: string
    rows: FreshnessRow[]
    expanded: boolean
    onToggle: () => void
    isSystemAdmin: boolean
    onRefreshProvider: (providerId: string, name: string) => void
    colSpan: number
}

export function FreshnessGroupHeader({
    providerId, name, rows, expanded, onToggle, isSystemAdmin, onRefreshProvider, colSpan,
}: Props) {
    const total = rows.length
    const ready = rows.filter(r => r.aggregationStatus === 'ready').length
    const notBuilt = rows.filter(isNeverBuilt).length
    const attention = rows.filter(isGroupAttention).length
    const Chevron = expanded ? ChevronDown : ChevronRight

    return (
        <tr className={cn(
            'border-t border-glass-border',
            attention > 0
                ? 'bg-amber-500/[0.04]'
                : 'bg-black/[0.02] dark:bg-white/[0.02]',
        )}>
            <td colSpan={colSpan} className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-black/[0.03] dark:hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-indigo-500/50 transition-colors"
                    >
                        <Chevron className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                        <span className="text-xs font-semibold text-ink-secondary">{name}</span>
                        <span className="text-[11px] text-ink-muted">
                            · {total} {total === 1 ? 'source' : 'sources'}
                            {!expanded && (
                                <>
                                    {ready > 0 && <> · {ready} ready</>}
                                    {notBuilt > 0 && <> · {notBuilt} not built</>}
                                </>
                            )}
                        </span>
                        {!expanded && attention > 0 && (
                            <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                                · {attention} attention
                            </span>
                        )}
                    </button>

                    {isSystemAdmin && providerId !== '—' && (
                        <button
                            type="button"
                            onClick={() => onRefreshProvider(providerId, name)}
                            className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                        >
                            <Zap className="w-3.5 h-3.5" /> Refresh provider…
                        </button>
                    )}
                </div>
            </td>
        </tr>
    )
}
