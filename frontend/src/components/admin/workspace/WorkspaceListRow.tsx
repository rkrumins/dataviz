import { memo } from 'react'
import { Database, FolderOpen, Shield, Trash2, ChevronRight, CircleDot, ArrowRightLeft, Layers, Users } from 'lucide-react'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge } from './WorkspaceHealthBadge'
import { getProviderLogo } from '../ProviderLogos'
import type { WsDataSourceProviderInfo } from '../WorkspaceCard'
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
    stats: { nodes: number; edges: number; types: number }
    healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown'
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

function WorkspaceListRowBase({ ws, index: _index, stats, healthStatus, dsProviders, onOpen, onDelete, onSetDefault, onManageMembers, onPrefetch }: WorkspaceListRowProps) {
    const uniqueProviderTypes = Array.from(new Set(dsProviders.map(p => p.providerType).filter(t => t !== 'unknown')))
    const prefetchHandlers = useIntentPrefetch(onPrefetch)

    return (
        <div
            {...prefetchHandlers}
            onClick={onOpen}
            className="group grid grid-cols-[16px_32px_minmax(0,2fr)_100px_70px_80px_80px_60px_90px_72px] gap-3 items-center px-4 py-3 border-b border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
        >
            <WorkspaceHealthBadge status={healthStatus} size="sm" />

            <div className="w-8 h-8 rounded-lg border border-glass-border flex items-center justify-center bg-black/[0.02] dark:bg-white/[0.02]">
                <FolderOpen className="w-4 h-4 text-ink-muted" />
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

            <span className="text-[11px] text-ink-muted">{new Date(ws.updatedAt).toLocaleDateString()}</span>

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
