import { useState, useEffect } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { ontologyDefinitionService, type OntologyAuditEntry } from '@/services/ontologyDefinitionService'

interface WorkspaceOntologyTimelineProps {
    dataSources: DataSourceResponse[]
    ontologyMap: Record<string, OntologyDefinitionResponse>
}

function actionDotColor(action: string): string {
    switch (action) {
        case 'published': return 'bg-emerald-500'
        case 'created': return 'bg-indigo-500'
        case 'updated': return 'bg-amber-500'
        case 'deleted': return 'bg-red-500'
        case 'restored': return 'bg-cyan-500'
        default: return 'bg-gray-400'
    }
}

function actionLabel(action: string): string {
    return action.charAt(0).toUpperCase() + action.slice(1)
}

export function WorkspaceOntologyTimeline({ dataSources, ontologyMap }: WorkspaceOntologyTimelineProps) {
    const [auditLogs, setAuditLogs] = useState<Record<string, OntologyAuditEntry[]>>({})
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        const ontologyIds = [...new Set(dataSources.map(ds => ds.ontologyId).filter(Boolean))] as string[]
        if (ontologyIds.length === 0) { setIsLoading(false); return }

        Promise.all(ontologyIds.map(id =>
            ontologyDefinitionService.auditLog(id).then(entries => ({ id, entries })).catch(() => ({ id, entries: [] as OntologyAuditEntry[] }))
        )).then(results => {
            const logs: Record<string, OntologyAuditEntry[]> = {}
            results.forEach(r => { logs[r.id] = r.entries })
            setAuditLogs(logs)
            setIsLoading(false)
        })
    }, [dataSources])

    // Data sources that have an ontology assigned
    const dsWithOntology = dataSources.filter(ds => ds.ontologyId && ontologyMap[ds.ontologyId])

    // Empty state
    if (!isLoading && dsWithOntology.length === 0) {
        return (
            <div className="py-16 text-center border-2 border-dashed border-glass-border rounded-2xl">
                <GitBranch className="w-10 h-10 mx-auto text-ink-muted mb-3 opacity-30" />
                <h4 className="text-sm font-bold text-ink mb-1">No ontologies assigned</h4>
                <p className="text-xs text-ink-muted">Assign ontologies to data sources to track semantic changes.</p>
            </div>
        )
    }

    // Loading state
    if (isLoading) {
        return (
            <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <h3 className="text-lg font-bold text-ink">Ontology Change Timeline</h3>

            {dsWithOntology.map(ds => {
                const ontology = ontologyMap[ds.ontologyId!]
                const entries = auditLogs[ds.ontologyId!] || []

                return (
                    <div key={ds.id} className="mb-6">
                        {/* DS + Ontology header */}
                        <div className="flex items-center gap-2 mb-3">
                            <GitBranch className="w-4 h-4 text-indigo-500" />
                            <span className="text-sm font-semibold text-ink">{ds.label || 'Unnamed'}</span>
                            <span className="text-xs text-ink-muted">&mdash;</span>
                            <span className="text-xs text-ink-muted">{ontology.name} v{ontology.version}</span>
                            {ontology.isPublished ? (
                                <span className="px-1.5 py-0.5 text-[8px] font-bold rounded bg-emerald-500/10 text-emerald-500">PUBLISHED</span>
                            ) : (
                                <span className="px-1.5 py-0.5 text-[8px] font-bold rounded bg-amber-500/10 text-amber-500">DRAFT</span>
                            )}
                        </div>

                        {/* Timeline */}
                        {entries.length === 0 ? (
                            <p className="ml-6 text-xs text-ink-muted">No audit history available.</p>
                        ) : (
                            <div className="ml-2 border-l-2 border-glass-border pl-4 space-y-3">
                                {entries.map(entry => (
                                    <div key={entry.id} className="relative">
                                        {/* Dot on the timeline line */}
                                        <div className={cn(
                                            'absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full border-2 border-canvas-elevated',
                                            actionDotColor(entry.action),
                                        )} />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-semibold text-ink">{actionLabel(entry.action)}</span>
                                                {entry.version && <span className="text-[10px] text-ink-muted">v{entry.version}</span>}
                                                <span className="text-[10px] text-ink-muted">{new Date(entry.createdAt).toLocaleDateString()}</span>
                                            </div>
                                            {entry.summary && <p className="text-xs text-ink-muted mt-0.5">{entry.summary}</p>}
                                            {entry.changes && (
                                                <div className="flex flex-wrap gap-1.5 mt-1">
                                                    {entry.changes.addedEntityTypes?.map(t => (
                                                        <span key={t} className="px-1.5 py-0.5 text-[9px] rounded bg-emerald-500/10 text-emerald-500">+ {t}</span>
                                                    ))}
                                                    {entry.changes.removedEntityTypes?.map(t => (
                                                        <span key={t} className="px-1.5 py-0.5 text-[9px] rounded bg-red-500/10 text-red-500">&minus; {t}</span>
                                                    ))}
                                                    {entry.changes.addedRelationshipTypes?.map(t => (
                                                        <span key={t} className="px-1.5 py-0.5 text-[9px] rounded bg-emerald-500/10 text-emerald-500">+ {t}</span>
                                                    ))}
                                                    {entry.changes.removedRelationshipTypes?.map(t => (
                                                        <span key={t} className="px-1.5 py-0.5 text-[9px] rounded bg-red-500/10 text-red-500">&minus; {t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
