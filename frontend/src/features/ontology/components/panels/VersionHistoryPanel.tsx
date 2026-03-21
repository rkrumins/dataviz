/**
 * VersionHistoryPanel — timeline of all versions of this ontology.
 * Standalone tab (not embedded in UsagePanel).
 */
import { useNavigate } from 'react-router-dom'
import { Loader2, Clock, CheckCircle2, ArrowRight, Box, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useOntologyVersions } from '../../hooks/useOntologies'
import { OntologyStatusBadge } from '../OntologyStatusBadge'
import { formatDate } from '../../lib/ontology-parsers'

interface VersionHistoryPanelProps {
  ontology: OntologyDefinitionResponse
}

export function VersionHistoryPanel({ ontology }: VersionHistoryPanelProps) {
  const { data: versions, isLoading } = useOntologyVersions(ontology.id)
  const navigate = useNavigate()

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading version history...</span>
      </div>
    )
  }

  if (!versions || versions.length === 0) {
    return (
      <div className="border border-dashed border-glass-border rounded-xl py-16 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10 flex items-center justify-center">
          <Clock className="w-5 h-5 text-ink-muted/50" />
        </div>
        <p className="text-sm font-medium text-ink-secondary">No version history</p>
        <p className="text-xs text-ink-muted mt-1">
          Version history appears when this ontology is published or cloned.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />
          Version Timeline
        </h3>
        <span className="px-2 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-bold text-ink-muted">
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="relative pl-8">
        {/* Vertical timeline line */}
        <div className="absolute left-[13px] top-3 bottom-3 w-1 rounded-full bg-gradient-to-b from-indigo-300 via-glass-border to-glass-border dark:from-indigo-700 dark:via-glass-border dark:to-glass-border" />

        <div className="space-y-3">
          {versions.map((v, i) => {
            const isActive = v.id === ontology.id
            const entityCount = Object.keys(v.entityTypeDefinitions ?? {}).length
            const relCount = Object.keys(v.relationshipTypeDefinitions ?? {}).length

            // Compute diff from previous version
            const prevVersion = versions[i + 1]
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
                {/* Timeline dot */}
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

                {/* Content */}
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

                  <div className="flex items-center gap-3 text-[11px] text-ink-muted mt-1.5">
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
                      <span className="text-ink-muted/70">by {v.createdBy}</span>
                    )}
                  </div>

                  {/* Version diff */}
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

                {!isActive && (
                  <ArrowRight className="w-4 h-4 text-ink-muted/30 flex-shrink-0 mt-1" />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
