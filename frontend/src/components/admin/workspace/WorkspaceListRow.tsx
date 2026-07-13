import { memo } from 'react'
import { Database, Shield, Trash2, ChevronRight, CircleDot, ArrowRightLeft, Layers, Users, Check } from 'lucide-react'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge, type WorkspaceHealth } from './WorkspaceHealthBadge'
import { getProviderLogo } from '../ProviderLogos'
import { accentFor, monogram, type WsDataSourceProviderInfo } from '../WorkspaceCard'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { TimeStamp } from '@/components/ui/TimeStamp'

/**
 * The list grid — ONE definition, used by the header in WorkspacesPage and by every
 * row here. They were two separate literals, and when a Created column was added to
 * one and not the other the row silently wrapped its last cell onto an implicit
 * second line: every value sat under the wrong heading, and each row grew a band of
 * dead space. A shared constant makes that impossible.
 */
export const WORKSPACE_LIST_GRID =
    'grid-cols-[20px_16px_32px_minmax(0,2fr)_100px_70px_80px_80px_60px_92px_92px_72px]'

/** "13 Jun 2026" — unambiguous, and short enough for a column. */
function shortDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'
import { useIntentPrefetch } from '@/hooks/useIntentPrefetch'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

interface WorkspaceListRowProps {
    ws: WorkspaceResponse
    index: number
    /** Bulk selection — same contract as the card. */
    isSelected?: boolean
    onToggleSelect?: () => void
    stats: { nodes: number; edges: number; types: number }
    healthStatus: WorkspaceHealth
    dsProviders: WsDataSourceProviderInfo[]
    onOpen: () => void
    onDelete: () => void
    onSetDefault: () => void
    /** Optional — when provided, the row exposes a "Members" action
     *  that jumps to the workspace's Members tab. */
    onManageMembers?: () => void
    /** Optional — warms the workspace-detail cache on hover intent. */
    onPrefetch?: () => void
}

function WorkspaceListRowBase({ ws, index: _index, isSelected = false, onToggleSelect, stats, healthStatus, dsProviders, onOpen, onDelete, onSetDefault, onManageMembers, onPrefetch }: WorkspaceListRowProps) {
    const uniqueProviderTypes = Array.from(new Set(dsProviders.map(p => p.providerType).filter(t => t !== 'unknown')))
    const prefetchHandlers = useIntentPrefetch(onPrefetch)

    return (
        <div
            {...prefetchHandlers}
            onClick={onOpen}
            className={cn(
                'group grid gap-3 items-center px-4 py-3 border-b border-glass-border cursor-pointer transition-colors',
                WORKSPACE_LIST_GRID,
                isSelected
                    ? "bg-indigo-500/[0.06] hover:bg-indigo-500/[0.09]"
                    : "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]",
            )}
        >
            {onToggleSelect ? (
                <button
                    type="button"
                    onClick={e => { e.stopPropagation(); onToggleSelect() }}
                    aria-label={isSelected ? 'Deselect workspace' : 'Select workspace'}
                    aria-pressed={isSelected}
                    title={isSelected ? 'Deselect' : 'Select for bulk actions'}
                    className="group/check"
                >
                    {/* Always drawn — it used to be invisible until hover. */}
                    <span className={cn(
                        'block w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center transition-all',
                        isSelected
                            ? 'bg-indigo-500 border-indigo-500'
                            : 'border-ink-muted/35 bg-canvas/60 group-hover/check:!border-indigo-500 group-hover/check:bg-indigo-500/10',
                    )}>
                        {isSelected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                    </span>
                </button>
            ) : <span />}

            <WorkspaceHealthBadge status={healthStatus} size="sm" />

            {/* Same monogram as the card — one identity, two layouts. */}
            <div className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center text-white text-[10px] font-black tracking-tight bg-gradient-to-br',
                accentFor(ws.id),
            )}>
                {monogram(ws.name)}
            </div>

            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink truncate">{ws.name}</span>
                    {ws.isDefault && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[9px] font-bold rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">DEFAULT</span>
                    )}
                </div>
                {ws.description && <p className="text-[11px] text-ink-muted truncate">{ws.description}</p>}
            </div>

            {/* Provider badges */}
            <div className="flex items-center gap-1 flex-wrap">
                {uniqueProviderTypes.slice(0, 2).map(pt => {
                    const Logo = getProviderLogo(pt)
                    return (
                        <span key={pt} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border">
                            <Logo className="w-3 h-3" />
                            <span className="text-[9px] font-medium text-ink-muted">
                                {pt === 'neo4j' ? 'Neo4j' : pt === 'falkordb' ? 'FDB' : pt === 'datahub' ? 'DH' : pt}
                            </span>
                        </span>
                    )
                })}
                {uniqueProviderTypes.length > 2 && (
                    <span className="text-[9px] text-ink-muted">+{uniqueProviderTypes.length - 2}</span>
                )}
            </div>

            <div className="flex items-center gap-1 text-xs text-ink-secondary">
                <Database className="w-3 h-3 text-indigo-500" />
                <span className="font-semibold">{ws.dataSources?.length || 0}</span>
            </div>

            <div className="flex items-center gap-1 text-xs text-ink-secondary">
                <CircleDot className="w-3 h-3 text-emerald-500" />
                <span className="font-semibold">{stats.nodes > 0 ? compactNum(stats.nodes) : '\u2014'}</span>
            </div>

            <div className="flex items-center gap-1 text-xs text-ink-secondary">
                <ArrowRightLeft className="w-3 h-3 text-violet-500" />
                <span className="font-semibold">{stats.edges > 0 ? compactNum(stats.edges) : '\u2014'}</span>
            </div>

            <div className="flex items-center gap-1 text-xs text-ink-secondary">
                <Layers className="w-3 h-3 text-amber-500" />
                <span className="font-semibold">{stats.types > 0 ? stats.types : '\u2014'}</span>
            </div>

            {/* Created is an exact date — you look it up, you don't scan it. */}
            <span
                className="text-[11px] text-ink-secondary tabular-nums truncate"
                title={`Created ${new Date(ws.createdAt).toLocaleString()}`}
            >
                {shortDate(ws.createdAt)}
            </span>

            {/* Updated is the age-coloured chip, so a stale workspace shows up while
                you're scanning the column rather than only when you read it. */}
            <TimeStamp
                at={ws.updatedAt}
                icon={null}
                tooltipLines={[`Last updated ${timeAgo(ws.updatedAt)}`]}
                className="truncate"
            />

            <WorkspaceRowActions
                ws={ws}
                onManageMembers={onManageMembers}
                onSetDefault={onSetDefault}
                onDelete={onDelete}
            />
        </div>
    )
}

// Row-level action buttons are split out so the permission hooks
// run per row WITHOUT cluttering the main component. Hidden when the
// user lacks the relevant permission so the row stays focused on
// what the viewer can actually do.
function WorkspaceRowActions({
    ws, onManageMembers, onSetDefault, onDelete,
}: {
    ws: WorkspaceResponse
    onManageMembers?: () => void
    onSetDefault: () => void
    onDelete: () => void
}) {
    // Workspace mutations require system:admin (delete + set default
    // are platform-level). Membership management is workspace:admin
    // on the specific workspace.
    const isPlatformAdmin = usePermission('system:admin')
    const wsAdminAnywhere = useAnyWorkspacePermission('workspace:admin')
    const canManageMembers = isPlatformAdmin || wsAdminAnywhere
    const canMutateWorkspace = isPlatformAdmin
    return (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onManageMembers && canManageMembers && (
                <button onClick={(e) => { e.stopPropagation(); onManageMembers() }} className="p-1 rounded-lg text-ink-muted hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors" title="Manage members">
                    <Users className="w-3 h-3" />
                </button>
            )}
            {!ws.isDefault && canMutateWorkspace && (
                <button onClick={(e) => { e.stopPropagation(); onSetDefault() }} className="p-1 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Set Default">
                    <Shield className="w-3 h-3" />
                </button>
            )}
            {canMutateWorkspace && (
                <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="p-1 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors" title="Delete">
                    <Trash2 className="w-3 h-3" />
                </button>
            )}
            <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />
        </div>
    )
}

// Memoized: renders per-row in the workspaces list. (Full benefit needs the
// parent to pass stable onOpen/onDelete/onSetDefault/onManageMembers.)
export const WorkspaceListRow = memo(WorkspaceListRowBase)
