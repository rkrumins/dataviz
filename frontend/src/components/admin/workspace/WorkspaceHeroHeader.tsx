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
  { key: 'totalNodes', label: 'Nodes', icon: CircleDot, color: 'text-indigo-500' },
  { key: 'totalEdges', label: 'Edges', icon: ArrowRightLeft, color: 'text-violet-500' },
  { key: 'totalTypes', label: 'Entity Types', icon: Layers, color: 'text-emerald-500' },
  { key: 'totalViews', label: 'Views', icon: Eye, color: 'text-cyan-500' },
] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceHeroHeader({
  workspace,
  healthStatus,
  aggregateStats,
  primaryOntologyName,
  isEditing,
  editName,
  editDesc,
  onEditNameChange,
  onEditDescChange,
  onStartEdit,
  onSave,
  onCancel,
}: WorkspaceHeroHeaderProps) {
  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-6">
      {/* Gradient icon */}
      <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center mb-4">
        <Database className="w-7 h-7 text-indigo-500" />
      </div>

      {/* Identity section */}
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
          {/* Name row */}
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-2xl font-bold text-ink">{workspace.name}</h2>
            {workspace.isDefault && (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">
                DEFAULT
              </span>
            )}
            <button
              onClick={onStartEdit}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          </div>

          {/* Description */}
          {workspace.description && (
            <p className="text-sm text-ink-secondary">{workspace.description}</p>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-ink-muted">
            <WorkspaceHealthBadge status={healthStatus} showLabel />
            <span className="flex items-center gap-1">
              <Database className="w-3 h-3" /> {workspace.dataSources.length} sources
            </span>
            <span className="flex items-center gap-1">
              <Tag className="w-3 h-3" /> Created{' '}
              {new Date(workspace.createdAt).toLocaleDateString()}
            </span>
            {primaryOntologyName && (
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" /> {primaryOntologyName}
              </span>
            )}
          </div>
        </>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3 mt-5">
        {kpiConfig.map((kpi) => {
          const raw = aggregateStats[kpi.key]
          const display = kpi.key === 'totalViews' || kpi.key === 'totalTypes' ? raw : compactNum(raw)
          return (
            <div
              key={kpi.label}
              className="p-3 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]"
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
  )
}
