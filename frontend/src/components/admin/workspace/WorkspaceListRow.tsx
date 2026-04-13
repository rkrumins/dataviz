import { Database, FolderOpen, Shield, Trash2, ChevronRight, CircleDot, ArrowRightLeft, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge } from './WorkspaceHealthBadge'

const WS_PALETTES = [
    { icon: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
    { icon: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
    { icon: 'bg-violet-500/10 text-violet-500 border-violet-500/20' },
    { icon: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
    { icon: 'bg-rose-500/10 text-rose-500 border-rose-500/20' },
    { icon: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20' },
]

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
    onOpen: () => void
    onDelete: () => void
    onSetDefault: () => void
}

export function WorkspaceListRow({ ws, index, stats, healthStatus, onOpen, onDelete, onSetDefault }: WorkspaceListRowProps) {
    const palette = WS_PALETTES[index % WS_PALETTES.length]

    return (
        <div
            onClick={onOpen}
            className="group grid grid-cols-[16px_32px_minmax(0,2fr)_70px_80px_80px_60px_90px_72px] gap-3 items-center px-4 py-3 border-b border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
        >
            <WorkspaceHealthBadge status={healthStatus} size="sm" />

            <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center', palette.icon)}>
                <FolderOpen className="w-4 h-4" />
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

            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {!ws.isDefault && (
                    <button onClick={(e) => { e.stopPropagation(); onSetDefault() }} className="p-1 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Set Default">
                        <Shield className="w-3 h-3" />
                    </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="p-1 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors" title="Delete">
                    <Trash2 className="w-3 h-3" />
                </button>
                <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />
            </div>
        </div>
    )
}
