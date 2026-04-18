/**
 * OntologyDetailHeader — extracted header component for the detail pane.
 *
 * Two-tier layout:
 *   Tier 1 (always visible): Name + version selector + primary actions
 *   Tier 2 (expandable): Description + metadata dates
 *
 * Toolbar states:
 *   - Draft, no changes: [... menu] [Publish]
 *   - Draft, has changes: [Discard] [Review Changes] [Save All] [Publish]
 *   - Immutable: [... menu] [New Version]
 *
 * Version selector dropdown next to the version badge shows all versions
 * within the same schema lineage.
 */
import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Lock, PenLine, Loader2, Save, X, ShieldCheck,
  Copy, Download, Upload, Settings, MoreHorizontal,
  CircleDot, Trash2, ChevronDown, ChevronUp, Eye,
  GitBranch, Plus, Database, Layers,
  AlertTriangle,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { OntologyStatusBadge } from './OntologyStatusBadge'
import { useOntologyVersions } from '../hooks/useOntologies'

interface OntologyDetailHeaderProps {
  ontology: OntologyDefinitionResponse
  isImmutable: boolean
  hasPendingChanges: boolean
  isSaving: boolean
  // Deployment management
  workspaces: WorkspaceResponse[]
  ontologies: OntologyDefinitionResponse[]
  isAssigning: boolean
  onAssignToDataSource: (workspaceId: string, dataSourceId: string) => void
  onUnassignFromDataSource: (workspaceId: string, dataSourceId: string) => void
  onRollOutToWorkspace: (workspaceId: string) => void
  // Actions
  onDiscard: () => void
  onSave: () => void
  onReviewChanges: () => void
  onValidate: () => void
  onPublish: () => void
  onClone: () => void
  onCreateNewVersion: () => void
  onExport: () => void
  onImport: () => void
  onEditDetails: () => void
  onDelete: () => void
}

export function OntologyDetailHeader({
  ontology,
  isImmutable,
  hasPendingChanges,
  isSaving,
  workspaces,
  ontologies,
  isAssigning,
  onAssignToDataSource,
  onUnassignFromDataSource,
  onRollOutToWorkspace,
  onDiscard,
  onSave,
  onReviewChanges,
  onValidate,
  onPublish,
  onClone,
  onCreateNewVersion,
  onExport,
  onImport,
  onEditDetails,
  onDelete,
}: OntologyDetailHeaderProps) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [deployOpen, setDeployOpen] = useState(false)

  const { data: versions } = useOntologyVersions(ontology.id)

  const entityCount = Object.keys(ontology.entityTypeDefinitions ?? {}).length
  const relCount = Object.keys(ontology.relationshipTypeDefinitions ?? {}).length

  // Deployment data — categorize all data sources into 3 groups
  const { assignedToThis, assignedToOther, unassigned, deployCount } = useMemo(() => {
    const thisSchema: Array<{ wsId: string; wsName: string; dsId: string; dsLabel: string }> = []
    const otherSchema: Array<{ wsId: string; wsName: string; dsId: string; dsLabel: string; otherName: string }> = []
    const none: Array<{ wsId: string; wsName: string; dsId: string; dsLabel: string }> = []
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        const entry = { wsId: ws.id, wsName: ws.name, dsId: ds.id, dsLabel: ds.label || ds.id }
        if (ds.ontologyId === ontology.id) {
          thisSchema.push(entry)
        } else if (ds.ontologyId) {
          otherSchema.push({ ...entry, otherName: ds.ontologyId })
        } else {
          none.push(entry)
        }
      }
    }
    return { assignedToThis: thisSchema, assignedToOther: otherSchema, unassigned: none, deployCount: thisSchema.length }
  }, [workspaces, ontology.id])

  // Ontology name lookup for "assigned to other" display
  const ontologyNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of ontologies) m.set(o.id, o.name)
    return m
  }, [ontologies])

  // Assign-all confirmation state
  const [confirmRollout, setConfirmRollout] = useState<{ wsId: string; wsName: string; dsCount: number } | null>(null)

  const hasMultipleVersions = versions && versions.length > 1

  return (
    <div className="flex-shrink-0 px-8 pt-6 pb-0">
      {/* Tier 1: Name + version + primary actions */}
      <div className="flex items-start justify-between mb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-ink truncate">{ontology.name}</h1>

            {/* Version badge — clickable if multiple versions exist */}
            {hasMultipleVersions ? (
              <Popover.Root open={versionOpen} onOpenChange={setVersionOpen}>
                <Popover.Trigger asChild>
                  <button className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold font-mono flex-shrink-0 border cursor-pointer transition-all hover:ring-2 hover:ring-indigo-500/20',
                    ontology.isPublished || ontology.isSystem
                      ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-emerald-200/50 dark:border-emerald-800/40'
                      : 'bg-amber-50 dark:bg-amber-950/20 text-amber-600 dark:text-amber-400 border-amber-200/50 dark:border-amber-800/40',
                  )}>
                    {ontology.isPublished || ontology.isSystem
                      ? <Lock className="w-3 h-3" />
                      : <PenLine className="w-3 h-3" />}
                    v{ontology.version}
                    <ChevronDown className={cn('w-3 h-3 opacity-50 transition-transform', versionOpen && 'rotate-180')} />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="w-[280px] bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95"
                    sideOffset={6} align="start"
                  >
                    <div className="px-3 py-2 border-b border-glass-border/50">
                      <div className="flex items-center gap-2">
                        <GitBranch className="w-3.5 h-3.5 text-ink-muted" />
                        <span className="text-xs font-bold text-ink">Version History</span>
                        <span className="text-[10px] text-ink-muted ml-auto">{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto p-1.5">
                      {versions.map(v => {
                        const isCurrent = v.id === ontology.id
                        return (
                          <button
                            key={v.id}
                            onClick={() => {
                              if (!isCurrent) navigate(`/schema/${v.id}`)
                              setVersionOpen(false)
                            }}
                            className={cn(
                              'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all',
                              isCurrent
                                ? 'bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400'
                                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] text-ink-secondary',
                            )}
                          >
                            <span className={cn(
                              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold font-mono border flex-shrink-0',
                              v.isPublished || v.isSystem
                                ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-emerald-200/50 dark:border-emerald-800/40'
                                : 'bg-amber-50 dark:bg-amber-950/20 text-amber-600 dark:text-amber-400 border-amber-200/50 dark:border-amber-800/40',
                            )}>
                              {v.isPublished || v.isSystem ? <Lock className="w-2.5 h-2.5" /> : <PenLine className="w-2.5 h-2.5" />}
                              v{v.version}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-medium">
                                {v.isSystem ? 'System' : v.isPublished ? 'Published' : 'Draft'}
                              </span>
                              <p className="text-[10px] text-ink-muted truncate">
                                {v.isPublished && v.publishedAt
                                  ? new Date(v.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                  : new Date(v.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                }
                              </p>
                            </div>
                            {isCurrent && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500 flex-shrink-0">VIEWING</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            ) : (
              /* Single version — static badge */
              <span className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold font-mono flex-shrink-0 border',
                ontology.isPublished || ontology.isSystem
                  ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-emerald-200/50 dark:border-emerald-800/40'
                  : 'bg-amber-50 dark:bg-amber-950/20 text-amber-600 dark:text-amber-400 border-amber-200/50 dark:border-amber-800/40',
              )}>
                {ontology.isPublished || ontology.isSystem
                  ? <Lock className="w-3 h-3" />
                  : <PenLine className="w-3 h-3" />}
                v{ontology.version}
              </span>
            )}

            <OntologyStatusBadge ontology={ontology} />

            {/* Deployment badge */}
            <Popover.Root open={deployOpen} onOpenChange={setDeployOpen}>
              <Popover.Trigger asChild>
                <button className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 border transition-all hover:ring-2 hover:ring-indigo-500/20',
                  deployCount > 0
                    ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-emerald-200/50 dark:border-emerald-800/40'
                    : 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border',
                )}>
                  {deployCount > 0 ? (
                    <><Database className="w-3 h-3" />{deployCount} deployment{deployCount !== 1 ? 's' : ''}</>
                  ) : (
                    <><AlertTriangle className="w-3 h-3 text-amber-500" />Not deployed</>
                  )}
                  <ChevronDown className={cn('w-3 h-3 opacity-40 transition-transform', deployOpen && 'rotate-180')} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="w-[400px] bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95"
                  sideOffset={6} align="start"
                >
                  {/* Header with summary stats */}
                  <div className="px-4 pt-3 pb-2 border-b border-glass-border/50">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-bold text-ink">Data Source Assignments</h3>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />{assignedToThis.length} assigned
                      </span>
                      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold">
                        <span className="w-2 h-2 rounded-full bg-amber-500" />{assignedToOther.length} use other
                      </span>
                      <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-semibold">
                        <span className="w-2 h-2 rounded-full bg-red-400" />{unassigned.length} unassigned
                      </span>
                    </div>
                  </div>

                  <div className="max-h-[400px] overflow-y-auto">
                    {/* ── Section 1: Assigned to this schema (green) ── */}
                    {assignedToThis.length > 0 && (
                      <div className="px-2 pt-2 pb-1">
                        <div className="flex items-center gap-1.5 px-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                            Using this schema ({assignedToThis.length})
                          </span>
                        </div>
                        {assignedToThis.map(d => (
                          <div key={`${d.wsId}-${d.dsId}`} className="flex items-center gap-2 px-3 py-2 rounded-lg group hover:bg-emerald-500/[0.04]">
                            <Database className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-ink truncate">{d.dsLabel}</p>
                              <p className="text-[10px] text-ink-muted">{d.wsName}</p>
                            </div>
                            <button
                              onClick={() => onUnassignFromDataSource(d.wsId, d.dsId)}
                              disabled={isAssigning}
                              className="p-1 rounded-md hover:bg-red-500/10 text-ink-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30"
                              title="Unassign"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── Section 2: No schema assigned (red — urgent) ── */}
                    {unassigned.length > 0 && (
                      <div className="px-2 pt-2 pb-1 border-t border-glass-border/40">
                        <div className="flex items-center gap-1.5 px-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                          <span className="text-[10px] font-bold text-red-500 dark:text-red-400 uppercase tracking-wider">
                            No schema assigned ({unassigned.length})
                          </span>
                        </div>
                        {unassigned.map(d => (
                          <div key={`${d.wsId}-${d.dsId}`} className="flex items-center gap-2 px-3 py-2 rounded-lg group hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
                            <Database className="w-3.5 h-3.5 text-red-400/60 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-ink truncate">{d.dsLabel}</p>
                              <p className="text-[10px] text-ink-muted">{d.wsName}</p>
                            </div>
                            <button
                              onClick={() => onAssignToDataSource(d.wsId, d.dsId)}
                              disabled={isAssigning}
                              className="text-[10px] font-semibold text-indigo-500 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 px-2 py-0.5 rounded-md hover:bg-indigo-500/10 flex-shrink-0"
                            >
                              Assign
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* ── Section 3: Using another schema (amber) ── */}
                    {assignedToOther.length > 0 && (
                      <div className="px-2 pt-2 pb-1 border-t border-glass-border/40">
                        <div className="flex items-center gap-1.5 px-2 mb-1">
                          <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                          <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                            Using another schema ({assignedToOther.length})
                          </span>
                        </div>
                        {assignedToOther.map(d => (
                          <div key={`${d.wsId}-${d.dsId}`} className="flex items-center gap-2 px-3 py-2 rounded-lg group hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
                            <Database className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-ink truncate">{d.dsLabel}</p>
                              <p className="text-[10px] text-amber-500">
                                Uses &ldquo;{ontologyNames.get(d.otherName) || d.otherName}&rdquo; &middot; {d.wsName}
                              </p>
                            </div>
                            <button
                              onClick={() => onAssignToDataSource(d.wsId, d.dsId)}
                              disabled={isAssigning}
                              className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 px-2 py-0.5 rounded-md hover:bg-amber-500/10 flex-shrink-0"
                            >
                              Replace
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Empty state */}
                    {assignedToThis.length === 0 && unassigned.length === 0 && assignedToOther.length === 0 && (
                      <div className="px-4 py-8 text-center">
                        <Database className="w-6 h-6 text-ink-muted/30 mx-auto mb-2" />
                        <p className="text-xs text-ink-muted">No data sources available</p>
                      </div>
                    )}
                  </div>

                  {/* Footer — workspace-level actions */}
                  {workspaces.length > 0 && (
                    <div className="px-4 py-2.5 border-t border-glass-border/50 bg-black/[0.02] dark:bg-white/[0.02]">
                      <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-1.5">Quick actions</p>
                      <div className="flex flex-wrap gap-1.5">
                        {workspaces.map(ws => {
                          const wsDs = ws.dataSources ?? []
                          const unassignedInWs = wsDs.filter(ds => ds.ontologyId !== ontology.id).length
                          if (unassignedInWs === 0) return null
                          return (
                            <button
                              key={ws.id}
                              onClick={() => setConfirmRollout({ wsId: ws.id, wsName: ws.name, dsCount: wsDs.length })}
                              disabled={isAssigning}
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-500/[0.06] hover:bg-indigo-500/[0.12] border border-indigo-500/15 transition-all disabled:opacity-50"
                            >
                              <Layers className="w-2.5 h-2.5" />
                              Assign all in {ws.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {hasPendingChanges && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-[10px] font-bold text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20 animate-pulse">
                <CircleDot className="w-2.5 h-2.5" />
                Unsaved
              </span>
            )}
          </div>

          {/* Compact summary — always visible */}
          <div className="flex items-center gap-3 mt-1.5">
            <p className="text-sm text-ink-muted">
              {entityCount} entity type{entityCount !== 1 ? 's' : ''} · {relCount} relationship{relCount !== 1 ? 's' : ''}
            </p>
            {ontology.description && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-0.5 text-[11px] text-ink-muted/60 hover:text-ink-muted transition-colors"
              >
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {expanded ? 'Less' : 'More'}
              </button>
            )}
          </div>

          {/* Tier 2: Expandable details */}
          {expanded && (
            <div className="mt-2 space-y-1.5 animate-in slide-in-from-top-1 fade-in duration-150">
              {ontology.description && (
                <p className="text-sm text-ink-secondary max-w-2xl">{ontology.description}</p>
              )}
              <div className="flex items-center gap-4 flex-wrap text-[11px] text-ink-muted">
                <span>Created {new Date(ontology.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}{ontology.createdBy ? ` by ${ontology.createdBy}` : ''}</span>
                <span className="opacity-30">·</span>
                <span>Updated {new Date(ontology.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{ontology.updatedBy ? ` by ${ontology.updatedBy}` : ''}</span>
                {ontology.publishedAt && (
                  <>
                    <span className="opacity-30">·</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      Published {new Date(ontology.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      {ontology.publishedBy ? ` by ${ontology.publishedBy}` : ''}
                    </span>
                  </>
                )}
                <span className="opacity-30">·</span>
                <span>{ontology.scope}</span>
              </div>
            </div>
          )}
        </div>

        {/* Action toolbar */}
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-4">
          {/* Overflow menu — always visible */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="flex items-center justify-center w-9 h-9 rounded-xl border border-glass-border hover:border-glass-border-hover hover:bg-black/[0.03] dark:hover:bg-white/[0.03] text-ink-muted hover:text-ink transition-all">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[180px] bg-canvas-elevated border border-glass-border rounded-xl shadow-xl p-1.5 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                sideOffset={6}
                align="end"
              >
                {!ontology.isSystem && (
                  <DropdownMenu.Item
                    onClick={onEditDetails}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer outline-none transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    Edit Details
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  onClick={onValidate}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer outline-none transition-colors"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Validate
                </DropdownMenu.Item>
                {/* Clone — available for all (creates independent copy) */}
                <DropdownMenu.Item
                  onClick={onClone}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer outline-none transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Clone (Independent Copy)
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px bg-glass-border/60 my-1" />
                <DropdownMenu.Item
                  onClick={onExport}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer outline-none transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export JSON
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={onImport}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] cursor-pointer outline-none transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Import JSON
                </DropdownMenu.Item>
                {!ontology.isSystem && !ontology.isPublished && (
                  <>
                    <DropdownMenu.Separator className="h-px bg-glass-border/60 my-1" />
                    <DropdownMenu.Item
                      onClick={onDelete}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-red-500 hover:text-red-600 hover:bg-red-500/[0.06] cursor-pointer outline-none transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {/* Contextual actions based on state */}
          {hasPendingChanges && (
            <>
              <button
                onClick={onDiscard}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-all"
              >
                <X className="w-3.5 h-3.5" />
                Discard
              </button>
              <button
                onClick={onReviewChanges}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border border-glass-border hover:border-indigo-300 hover:bg-indigo-500/[0.06] text-ink-secondary hover:text-indigo-600 transition-all"
              >
                <Eye className="w-3.5 h-3.5" />
                Review
              </button>
              <button
                onClick={onSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold bg-emerald-500 text-white hover:bg-emerald-600 shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30 transition-all disabled:opacity-60"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {isSaving ? 'Saving...' : 'Save All'}
              </button>
            </>
          )}

          {/* Publish — shown for drafts */}
          {!isImmutable && (
            <button
              onClick={onPublish}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 transition-all shadow-md shadow-indigo-500/25"
            >
              <Upload className="w-4 h-4" />
              Publish
            </button>
          )}

          {/* New Version — shown for immutable (published/system) ontologies */}
          {isImmutable && !ontology.deletedAt && (
            <button
              onClick={onCreateNewVersion}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
            >
              <Plus className="w-4 h-4" />
              New Version
            </button>
          )}
        </div>
      </div>

      {/* Assign-all confirmation dialog */}
      {confirmRollout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmRollout(null)} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl animate-in fade-in zoom-in-95 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-ink">Assign to all data sources?</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">{confirmRollout.wsName}</p>
              </div>
            </div>
            <p className="text-xs text-ink-muted mb-5 leading-relaxed">
              This will assign <span className="font-semibold text-ink">&ldquo;{ontology.name}&rdquo;</span> to
              all <span className="font-semibold text-ink">{confirmRollout.dsCount} data source{confirmRollout.dsCount !== 1 ? 's' : ''}</span> in
              this workspace. Data sources currently using another schema will be reassigned.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmRollout(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onRollOutToWorkspace(confirmRollout.wsId)
                  setConfirmRollout(null)
                  setDeployOpen(false)
                }}
                disabled={isAssigning}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm disabled:opacity-50"
              >
                {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                Assign All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
