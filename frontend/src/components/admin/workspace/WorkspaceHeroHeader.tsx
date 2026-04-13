import {
  Database,
  Edit2,
  Save,
  Tag,
  GitBranch,
  CircleDot,
  ArrowRightLeft,
  Layers,
  Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { WorkspaceHealthBadge } from './WorkspaceHealthBadge'
import { getProviderLogo } from '../ProviderLogos'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspaceHeroHeaderProps {
  workspace: WorkspaceResponse
  healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown'
  aggregateStats: { totalNodes: number; totalEdges: number; totalTypes: number; totalViews: number }
  primaryOntologyName?: string
  providerInfos: DataSourceProviderInfo[]
  isEditing: boolean
  editName: string
  editDesc: string
  onEditNameChange: (v: string) => void
  onEditDescChange: (v: string) => void
  onStartEdit: () => void
  onSave: () => void
  onCancel: () => void
}

// ---------------------------------------------------------------------------
// KPI configuration
// ---------------------------------------------------------------------------

const kpiConfig = [
  { key: 'totalNodes', label: 'Nodes', icon: CircleDot, color: 'text-indigo-500', bgHover: 'hover:bg-indigo-500/5', tooltip: 'Total entities across all data sources' },
  { key: 'totalEdges', label: 'Edges', icon: ArrowRightLeft, color: 'text-violet-500', bgHover: 'hover:bg-violet-500/5', tooltip: 'Total relationships across all data sources' },
  { key: 'totalTypes', label: 'Entity Types', icon: Layers, color: 'text-emerald-500', bgHover: 'hover:bg-emerald-500/5', tooltip: 'Unique entity type classifications' },
  { key: 'totalViews', label: 'Views', icon: Eye, color: 'text-cyan-500', bgHover: 'hover:bg-cyan-500/5', tooltip: 'Saved visual perspectives on your data' },
] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceHeroHeader({
  workspace,
  healthStatus,
  aggregateStats,
  primaryOntologyName,
  providerInfos,
  isEditing,
  editName,
  editDesc,
  onEditNameChange,
  onEditDescChange,
  onStartEdit,
  onSave,
  onCancel,
}: WorkspaceHeroHeaderProps) {
  // Deduplicate provider types for the badge row
  const uniqueProviders = Array.from(
    new Map(providerInfos.map(p => [p.providerType, p])).values()
  )

  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      {/* Top gradient accent */}
      <div className="h-1.5 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />

      <div className="p-6">
        {/* Top row: icon + identity */}
        <div className="flex items-start gap-5">
          {/* Large gradient icon */}
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 via-violet-500/15 to-cyan-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
            <Database className="w-8 h-8 text-indigo-500" />
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <div className="space-y-3">
                <input
                  value={editName}
                  onChange={(e) => onEditNameChange(e.target.value)}
                  autoFocus
                  placeholder="Workspace name"
                  className="text-2xl font-bold text-ink bg-transparent border-b-2 border-indigo-500 outline-none pb-0.5 w-full"
                />
                <textarea
                  value={editDesc}
                  onChange={(e) => onEditDescChange(e.target.value)}
                  placeholder="Description (optional)"
                  rows={2}
                  className="w-full text-sm text-ink-secondary bg-black/5 dark:bg-white/5 border border-glass-border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                />
                <div className="flex gap-2">
                  <button
                    onClick={onSave}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 transition-colors"
                  >
                    <Save className="w-3 h-3" /> Save
                  </button>
                  <button
                    onClick={onCancel}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Name + badges */}
                <div className="flex items-center gap-3 mb-1">
                  <h2 className="text-2xl font-bold text-ink truncate">{workspace.name}</h2>
                  {workspace.isDefault && (
                    <span className="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 shrink-0">
                      DEFAULT
                    </span>
                  )}
                  <button
                    onClick={onStartEdit}
                    className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted shrink-0"
                    title="Edit workspace name and description"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Description */}
                {workspace.description ? (
                  <p className="text-sm text-ink-secondary mb-3">{workspace.description}</p>
                ) : (
                  <p className="text-sm text-ink-muted/50 italic mb-3">No description — click the pencil icon to add one.</p>
                )}

                {/* Metadata badges row */}
                <div className="flex flex-wrap items-center gap-2">
                  <WorkspaceHealthBadge status={healthStatus} showLabel size="md" />

                  <span className="w-px h-4 bg-glass-border mx-1" />

                  <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <Database className="w-3 h-3" /> {workspace.dataSources.length} source{workspace.dataSources.length !== 1 ? 's' : ''}
                  </span>

                  <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <Tag className="w-3 h-3" /> Created {new Date(workspace.createdAt).toLocaleDateString()}
                  </span>

                  {primaryOntologyName && (
                    <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <GitBranch className="w-3 h-3" /> {primaryOntologyName}
                    </span>
                  )}

                  {/* Provider badges */}
                  {uniqueProviders.length > 0 && (
                    <>
                      <span className="w-px h-4 bg-glass-border mx-1" />
                      {uniqueProviders.map(p => {
                        const Logo = getProviderLogo(p.providerType)
                        return (
                          <span key={p.providerType} className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-[11px] font-medium text-ink-secondary">
                            <Logo className="w-3.5 h-3.5" />
                            {p.providerType === 'neo4j' ? 'Neo4j' : p.providerType === 'falkordb' ? 'FalkorDB' : p.providerType === 'datahub' ? 'DataHub' : p.providerType}
                          </span>
                        )
                      })}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-3 mt-6">
          {kpiConfig.map((kpi) => {
            const raw = aggregateStats[kpi.key]
            const display = kpi.key === 'totalViews' || kpi.key === 'totalTypes' ? raw : compactNum(raw)
            return (
              <div
                key={kpi.label}
                title={kpi.tooltip}
                className={cn(
                  "p-3.5 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] cursor-default transition-colors",
                  kpi.bgHover
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <kpi.icon className={cn('w-4 h-4', kpi.color)} />
                  <span className="text-xl font-bold text-ink">{display}</span>
                </div>
                <span className="text-[10px] text-ink-muted uppercase tracking-wider">
                  {kpi.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
