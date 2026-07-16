/**
 * VersionHistoryPanel — version timeline + audit trail for an ontology.
 * Shows version entries alongside lifecycle events (create, update, publish,
 * delete, restore, clone) with actor info, timestamps, and change diffs.
 * Older versions can be COMPARED with the current one and RESTORED as a new
 * draft (composition of new-version + update — nothing is overwritten).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Clock, CheckCircle2, ArrowRight, Box, GitBranch, User, Plus, Minus, Upload, Trash2, RotateCcw, Copy, PenLine, GitCompareArrows } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ontologyDefinitionService, type OntologyDefinitionResponse, type OntologyAuditEntry } from '@/services/ontologyDefinitionService'
import { useOntologyVersions, useOntologyAuditLog } from '../../hooks/useOntologies'
import { useOntologyMutations } from '../../hooks/useOntologyMutations'
import { useSemanticLayerAccess } from '../../lib/useSemanticLayerAccess'
import { restoreVersionAsDraft } from '../../lib/restoreVersion'
import { OntologyStatusBadge } from '../OntologyStatusBadge'
import { VersionDiffDialog } from '../dialogs/VersionDiffDialog'
import { formatDate } from '../../lib/ontology-parsers'
import { useToast } from '@/components/ui/toast'

interface VersionHistoryPanelProps {
  ontology: OntologyDefinitionResponse
}

const ACTION_CONFIG: Record<string, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  accent: string
  dotColor: string
}> = {
  created: { icon: Plus, label: 'Created', accent: 'text-emerald-600 dark:text-emerald-400', dotColor: 'bg-emerald-500' },
  updated: { icon: PenLine, label: 'Updated', accent: 'text-blue-600 dark:text-blue-400', dotColor: 'bg-blue-500' },
  published: { icon: Upload, label: 'Published', accent: 'text-indigo-600 dark:text-indigo-400', dotColor: 'bg-indigo-500' },
  deleted: { icon: Trash2, label: 'Deleted', accent: 'text-red-600 dark:text-red-400', dotColor: 'bg-red-500' },
  restored: { icon: RotateCcw, label: 'Restored', accent: 'text-amber-600 dark:text-amber-400', dotColor: 'bg-amber-500' },
  cloned: { icon: Copy, label: 'New Version', accent: 'text-purple-600 dark:text-purple-400', dotColor: 'bg-purple-500' },
}

function TypeDiffBadges({ changes }: { changes: OntologyAuditEntry['changes'] }) {
  if (!changes) return null
  const { addedEntityTypes, removedEntityTypes, addedRelationshipTypes, removedRelationshipTypes } = changes
  const hasAny = (addedEntityTypes?.length || 0) + (removedEntityTypes?.length || 0) + (addedRelationshipTypes?.length || 0) + (removedRelationshipTypes?.length || 0) > 0
  if (!hasAny) return null

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {addedEntityTypes?.map(t => (
        <span key={`+e-${t}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400">
          <Plus className="w-2.5 h-2.5" />{t}
        </span>
      ))}
      {removedEntityTypes?.map(t => (
        <span key={`-e-${t}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400">
          <Minus className="w-2.5 h-2.5" />{t}
        </span>
      ))}
      {addedRelationshipTypes?.map(t => (
        <span key={`+r-${t}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50/70 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 italic">
          <Plus className="w-2.5 h-2.5" />{t}
        </span>
      ))}
      {removedRelationshipTypes?.map(t => (
        <span key={`-r-${t}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50/70 dark:bg-red-950/20 text-red-600 dark:text-red-400 italic">
          <Minus className="w-2.5 h-2.5" />{t}
        </span>
      ))}
    </div>
  )
}

export function VersionHistoryPanel({ ontology }: VersionHistoryPanelProps) {
  const { data: versions, isLoading: versionsLoading } = useOntologyVersions(ontology.id)
  const { data: auditLog, isLoading: auditLoading } = useOntologyAuditLog(ontology.id)
  const navigate = useNavigate()
  const access = useSemanticLayerAccess()
  const mutations = useOntologyMutations()
  const { showToast } = useToast()

  const [compareTarget, setCompareTarget] = useState<OntologyDefinitionResponse | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<OntologyDefinitionResponse | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)

  // Versions arrive newest-first; the newest version is the new-version source.
  const latestVersion = versions?.[0]

  async function confirmRestore() {
    if (!restoreTarget || !latestVersion || isRestoring) return
    setIsRestoring(true)
    try {
      const draft = await restoreVersionAsDraft(restoreTarget, latestVersion.id, {
        createNewVersion: id => mutations.createNewVersion.mutateAsync(id),
        update: (id, req) => mutations.update.mutateAsync({ id, req }),
        listVersions: id => ontologyDefinitionService.listVersions(id),
      })
      showToast('success', `v${restoreTarget.version}'s content restored into draft v${draft.version}`)
      setRestoreTarget(null)
      setCompareTarget(null)
      navigate(`/schema/${draft.id}`)
    } catch (err) {
      showToast('error', `Restore failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsRestoring(false)
    }
  }

  const isLoading = versionsLoading || auditLoading

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading history...</span>
      </div>
    )
  }

  const hasVersions = versions && versions.length > 0
  const hasAudit = auditLog && auditLog.length > 0

  if (!hasVersions && !hasAudit) {
    return (
      <div className="border border-dashed border-glass-border rounded-xl py-16 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10 flex items-center justify-center">
          <Clock className="w-5 h-5 text-ink-muted/50" />
        </div>
        <p className="text-sm font-medium text-ink-secondary">No history yet</p>
        <p className="text-xs text-ink-muted mt-1">
          History appears as you create, edit, publish, or clone this ontology.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Version Timeline */}
      {hasVersions && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" />
              Version Timeline
            </h3>
            <span className="px-2 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-bold text-ink-muted">
              {versions!.length} version{versions!.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="relative pl-8">
            <div className="absolute left-[13px] top-3 bottom-3 w-1 rounded-full bg-gradient-to-b from-indigo-300 via-glass-border to-glass-border dark:from-indigo-700 dark:via-glass-border dark:to-glass-border" />

            <div className="space-y-3">
              {versions!.map((v, i) => {
                const isActive = v.id === ontology.id
                const entityCount = Object.keys(v.entityTypeDefinitions ?? {}).length
                const relCount = Object.keys(v.relationshipTypeDefinitions ?? {}).length

                const prevVersion = versions![i + 1]
                const prevEntityCount = prevVersion ? Object.keys(prevVersion.entityTypeDefinitions ?? {}).length : null
                const prevRelCount = prevVersion ? Object.keys(prevVersion.relationshipTypeDefinitions ?? {}).length : null
                const entityDiff = prevEntityCount !== null ? entityCount - prevEntityCount : null
                const relDiff = prevRelCount !== null ? relCount - prevRelCount : null

                return (
                  <div
                    key={v.id}
                    onClick={() => !isActive && navigate(`/schema/${v.id}`)}
                    className={cn(
                      'relative flex items-start gap-4 p-4 rounded-xl border transition-all',
                      isActive
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                        : 'border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] hover:border-indigo-200 dark:hover:border-indigo-800/40',
                    )}
                  >
                    <div className="absolute -left-8 top-5">
                      {isActive ? (
                        <div className="relative">
                          <div className="absolute -inset-1 rounded-full bg-indigo-500/20 animate-pulse" />
                          <CheckCircle2 className="w-6 h-6 text-indigo-500 bg-canvas rounded-full relative z-10" />
                        </div>
                      ) : v.isPublished ? (
                        <div className="w-6 h-6 rounded-full bg-emerald-50 dark:bg-emerald-900/40 border-2 border-emerald-400 dark:border-emerald-600 flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-emerald-500" />
                        </div>
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-amber-50 dark:bg-amber-900/30 border-2 border-amber-300 dark:border-amber-700 flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-amber-400" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-ink">v{v.version}</span>
                        <OntologyStatusBadge ontology={v} size="xs" />
                        {isActive && (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 ring-1 ring-indigo-300/30 dark:ring-indigo-700/30">
                            current
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-[11px] text-ink-muted mt-1.5 flex-wrap">
                        <span>{formatDate(v.createdAt)}</span>
                        <span className="flex items-center gap-1">
                          <Box className="w-2.5 h-2.5" />
                          {entityCount} entities
                        </span>
                        <span className="flex items-center gap-1">
                          <GitBranch className="w-2.5 h-2.5" />
                          {relCount} relationships
                        </span>
                        {v.createdBy && (
                          <span className="flex items-center gap-1 text-ink-muted/70">
                            <User className="w-2.5 h-2.5" />
                            {v.createdBy}
                          </span>
                        )}
                        {v.publishedAt && (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <Upload className="w-2.5 h-2.5" />
                            Published {formatDate(v.publishedAt)}
                            {v.publishedBy ? ` by ${v.publishedBy}` : ''}
                          </span>
                        )}
                      </div>

                      {(entityDiff !== null || relDiff !== null) && (entityDiff !== 0 || relDiff !== 0) && (
                        <div className="flex items-center gap-2 mt-2">
                          {entityDiff !== null && entityDiff !== 0 && (
                            <span className={cn(
                              'text-[10px] font-medium px-1.5 py-0.5 rounded',
                              entityDiff > 0
                                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                                : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400',
                            )}>
                              {entityDiff > 0 ? '+' : ''}{entityDiff} entit{Math.abs(entityDiff) === 1 ? 'y' : 'ies'}
                            </span>
                          )}
                          {relDiff !== null && relDiff !== 0 && (
                            <span className={cn(
                              'text-[10px] font-medium px-1.5 py-0.5 rounded',
                              relDiff > 0
                                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                                : 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400',
                            )}>
                              {relDiff > 0 ? '+' : ''}{relDiff} rel{Math.abs(relDiff) === 1 ? '' : 's'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Version actions */}
                    <div className="flex items-center gap-1 flex-shrink-0 mt-0.5" onClick={e => e.stopPropagation()}>
                      {!isActive && (
                        <button
                          onClick={() => setCompareTarget(v)}
                          title={`Compare v${ontology.version} with v${v.version}`}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-ink-muted hover:text-indigo-600 hover:bg-indigo-500/[0.06] transition-colors"
                        >
                          <GitCompareArrows className="w-3 h-3" /> Compare
                        </button>
                      )}
                      {access.canEdit && v.id !== latestVersion?.id && (
                        <button
                          onClick={() => setRestoreTarget(v)}
                          title={`Restore v${v.version}'s content as a new draft`}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold text-ink-muted hover:text-amber-600 hover:bg-amber-500/[0.06] transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" /> Restore
                        </button>
                      )}
                      {!isActive && <ArrowRight className="w-4 h-4 text-ink-muted/30" />}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Audit Trail */}
      {hasAudit && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" />
              Activity Log
            </h3>
            <span className="px-2 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-bold text-ink-muted">
              {auditLog!.length} event{auditLog!.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="relative pl-6">
            <div className="absolute left-[9px] top-2 bottom-2 w-px bg-glass-border" />

            <div className="space-y-1">
              {auditLog!.map(entry => {
                const config = ACTION_CONFIG[entry.action] ?? ACTION_CONFIG.updated
                const Icon = config.icon

                return (
                  <div key={entry.id} className="relative flex items-start gap-3 py-2.5 px-3 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                    {/* Timeline dot */}
                    <div className="absolute -left-6 top-3.5">
                      <div className={cn('w-[18px] h-[18px] rounded-full flex items-center justify-center bg-canvas border-2 border-glass-border')}>
                        <div className={cn('w-2 h-2 rounded-full', config.dotColor)} />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className={cn('flex items-center gap-1 text-xs font-semibold', config.accent)}>
                          <Icon className="w-3 h-3" />
                          {config.label}
                        </div>
                        {entry.version != null && (
                          <span className="text-[10px] text-ink-muted font-mono">v{entry.version}</span>
                        )}
                        <span className="text-[10px] text-ink-muted">{formatDate(entry.createdAt)}</span>
                        {entry.actor && (
                          <span className="flex items-center gap-1 text-[10px] text-ink-muted/70">
                            <User className="w-2.5 h-2.5" />
                            {entry.actor}
                          </span>
                        )}
                      </div>

                      {entry.summary && (
                        <p className="text-[11px] text-ink-secondary mt-0.5">{entry.summary}</p>
                      )}

                      <TypeDiffBadges changes={entry.changes} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Compare dialog */}
      {compareTarget && (
        <VersionDiffDialog
          base={ontology}
          target={compareTarget}
          onRestore={
            access.canEdit && compareTarget.id !== latestVersion?.id
              ? () => setRestoreTarget(compareTarget)
              : undefined
          }
          onClose={() => setCompareTarget(null)}
        />
      )}

      {/* Restore confirmation */}
      {restoreTarget && (
        <>
          <div className="fixed inset-0 z-[110] bg-black/40" onClick={() => !isRestoring && setRestoreTarget(null)} />
          <div className="fixed inset-0 z-[110] flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto bg-canvas-elevated rounded-2xl border border-glass-border shadow-lg w-full max-w-md mx-4 overflow-hidden animate-in zoom-in-95 fade-in duration-200">
              <div className="p-6">
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                    <RotateCcw className="w-5 h-5 text-amber-500" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-ink">Restore v{restoreTarget.version}?</h3>
                    <p className="text-sm text-ink-muted mt-1">
                      This creates a <strong>new draft</strong> containing v{restoreTarget.version}&rsquo;s
                      content. Nothing is overwritten — v{latestVersion?.version ?? ontology.version} and
                      every other version stay exactly as they are. Publish the draft when you&rsquo;re ready.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01]">
                <button
                  onClick={() => setRestoreTarget(null)}
                  disabled={isRestoring}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRestore}
                  disabled={isRestoring}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-sm shadow-amber-500/20 disabled:opacity-60"
                >
                  {isRestoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  {isRestoring ? 'Restoring…' : 'Restore as Draft'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
