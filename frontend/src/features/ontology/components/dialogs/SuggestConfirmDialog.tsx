/**
 * SuggestConfirmDialog — multi-phase dialog for "Suggest from Graph".
 *
 * Phase 1: Confirm — explains what will happen, shows data source context.
 * Phase 2: Analyzing — spinner while calling suggest endpoint.
 * Phase 3: Recommendations — shows matching existing ontologies (system first)
 *          with coverage bars before allowing the user to create a new draft.
 */
import { useState } from 'react'
import {
  X, Sparkles, Database, Loader2, Box, GitBranch, Shield,
  CheckCircle2, Copy, ArrowRight, PenLine,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyMatchResult, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

type Phase = 'confirm' | 'analyzing' | 'recommendations'

interface SuggestConfirmDialogProps {
  dataSourceLabel: string | null
  /** All loaded ontologies — used to enrich match results with isSystem/isPublished. */
  ontologies: OntologyDefinitionResponse[]
  onAnalyze: () => Promise<{
    matches: OntologyMatchResult[]
    suggestedEntityCount: number
    suggestedRelCount: number
  }>
  onUseExisting: (ontologyId: string) => void
  onCloneExisting: (ontologyId: string) => void
  onCreateDraft: () => void
  onClose: () => void
  isCreating: boolean
}

export function SuggestConfirmDialog({
  dataSourceLabel,
  ontologies,
  onAnalyze,
  onUseExisting,
  onCloneExisting,
  onCreateDraft,
  onClose,
  isCreating,
}: SuggestConfirmDialogProps) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [matches, setMatches] = useState<OntologyMatchResult[]>([])
  const [graphCounts, setGraphCounts] = useState({ entities: 0, rels: 0 })
  const [error, setError] = useState<string | null>(null)

  const isBusy = phase === 'analyzing' || isCreating

  /** Look up the full ontology to get isSystem/isPublished. */
  function getOntology(id: string) {
    return ontologies.find(o => o.id === id)
  }

  async function handleAnalyze() {
    setPhase('analyzing')
    setError(null)
    try {
      const result = await onAnalyze()
      setMatches(result.matches)
      setGraphCounts({ entities: result.suggestedEntityCount, rels: result.suggestedRelCount })
      setPhase('recommendations')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setPhase('confirm')
    }
  }

  // Sort matches: system first, then by coverage desc
  const sortedMatches = [...matches].sort((a, b) => {
    const aSystem = getOntology(a.ontologyId)?.isSystem ? 1 : 0
    const bSystem = getOntology(b.ontologyId)?.isSystem ? 1 : 0
    if (aSystem !== bSystem) return bSystem - aSystem
    return b.jaccardScore - a.jaccardScore
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={isBusy ? undefined : onClose} />
      <div className={cn(
        'relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden',
        phase === 'recommendations' ? 'max-w-lg' : 'max-w-md',
      )}>
        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Suggest from Graph</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {phase === 'confirm' && 'Analyze your data source'}
                  {phase === 'analyzing' && 'Scanning graph schema...'}
                  {phase === 'recommendations' && (
                    matches.length > 0
                      ? `${matches.length} existing match${matches.length > 1 ? 'es' : ''} found`
                      : 'No existing matches found'
                  )}
                </p>
              </div>
            </div>
            {!isBusy && (
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* ── Phase 1: Confirm ─────────────────────────────────────── */}
        {(phase === 'confirm' || phase === 'analyzing') && (
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-ink-secondary leading-relaxed">
              This will analyze the entity and relationship types in your active data source,
              check for <span className="font-semibold text-ink">existing semantic layers</span> that
              already cover your graph, and recommend the best match before creating anything new.
            </p>

            {dataSourceLabel && (
              <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center flex-shrink-0">
                    <Database className="w-4 h-4 text-emerald-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Data Source</p>
                    <p className="text-sm font-semibold text-ink truncate">{dataSourceLabel}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4">
              <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold mb-2.5">What happens next</p>
              <div className="space-y-2">
                <div className="flex items-center gap-2.5">
                  <Box className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                  <span className="text-xs text-ink-secondary">Detect entity and relationship types from your graph</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <Shield className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                  <span className="text-xs text-ink-secondary">Check existing layers (system & custom) for coverage</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                  <span className="text-xs text-ink-secondary">Recommend the best fit or generate a new draft</span>
                </div>
              </div>
            </div>

            {phase === 'analyzing' && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/50 dark:border-indigo-800/30">
                <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
                <p className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                  Analyzing graph schema and checking existing layers...
                </p>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-3">
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Phase 3: Recommendations ─────────────────────────────── */}
        {phase === 'recommendations' && (
          <div className="px-6 py-5 space-y-4">
            {/* Graph summary */}
            <div className="flex items-center gap-4 px-4 py-2.5 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-glass-border">
              <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                <Box className="w-3.5 h-3.5 text-indigo-400" />
                <span className="font-semibold text-ink">{graphCounts.entities}</span> entity types
              </div>
              <div className="w-px h-4 bg-glass-border" />
              <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                <span className="font-semibold text-ink">{graphCounts.rels}</span> relationships
              </div>
            </div>

            {/* Matches */}
            {sortedMatches.length > 0 && (
              <>
                <div>
                  <p className="text-xs font-semibold text-ink-secondary mb-0.5">Recommended Semantic Layers</p>
                  <p className="text-[11px] text-ink-muted">
                    These existing layers already cover your graph. Using one saves time and keeps things consistent.
                  </p>
                </div>

                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-0.5">
                  {sortedMatches.map((match, idx) => {
                    const ont = getOntology(match.ontologyId)
                    const totalTypes = match.coveredEntityTypes.length + match.uncoveredEntityTypes.length
                    const coveragePct = totalTypes > 0
                      ? Math.round((match.coveredEntityTypes.length / totalTypes) * 100)
                      : 0
                    const isSystem = ont?.isSystem ?? false
                    const isPublished = ont?.isPublished ?? false
                    const isBest = idx === 0

                    return (
                      <div
                        key={match.ontologyId}
                        className={cn(
                          'rounded-xl border-2 p-4 transition-all',
                          isBest
                            ? 'border-indigo-500/60 bg-indigo-50/30 dark:bg-indigo-950/10 shadow-sm shadow-indigo-500/5'
                            : 'border-glass-border hover:border-glass-border-hover'
                        )}
                      >
                        {/* Top row: name + badges + coverage */}
                        <div className="flex items-start justify-between gap-3 mb-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-semibold text-ink truncate">{match.ontologyName}</p>
                              {isBest && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[9px] font-bold rounded-full bg-indigo-500 text-white">
                                  BEST MATCH
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[11px] text-ink-muted">v{match.version}</span>
                              {isSystem && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-indigo-600 dark:text-indigo-400">
                                  <Shield className="w-2.5 h-2.5" />
                                  System
                                </span>
                              )}
                              {isPublished && !isSystem && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  Published
                                </span>
                              )}
                              {!isPublished && !isSystem && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400">
                                  <PenLine className="w-2.5 h-2.5" />
                                  Draft
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className={cn(
                              'text-lg font-bold',
                              coveragePct >= 80 ? 'text-emerald-600 dark:text-emerald-400'
                                : coveragePct >= 50 ? 'text-amber-600 dark:text-amber-400'
                                : 'text-red-500'
                            )}>
                              {coveragePct}%
                            </p>
                            <p className="text-[10px] text-ink-muted">coverage</p>
                          </div>
                        </div>

                        {/* Coverage bar */}
                        <div className="w-full h-1.5 rounded-full bg-black/5 dark:bg-white/5 mb-2.5">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              coveragePct >= 80 ? 'bg-emerald-500'
                                : coveragePct >= 50 ? 'bg-amber-500'
                                : 'bg-red-400'
                            )}
                            style={{ width: `${coveragePct}%` }}
                          />
                        </div>

                        {/* Type detail */}
                        <div className="mb-3">
                          <p className="text-[11px] text-ink-muted">
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                              {match.coveredEntityTypes.length} covered
                            </span>
                            {match.uncoveredEntityTypes.length > 0 && (
                              <>
                                {' · '}
                                <span className="text-amber-600 dark:text-amber-400 font-medium">
                                  {match.uncoveredEntityTypes.length} missing
                                </span>
                                <span className="text-ink-muted">
                                  {' '}({match.uncoveredEntityTypes.slice(0, 3).join(', ')}
                                  {match.uncoveredEntityTypes.length > 3 && ` +${match.uncoveredEntityTypes.length - 3}`})
                                </span>
                              </>
                            )}
                            {match.uncoveredEntityTypes.length === 0 && (
                              <span className="text-emerald-600 dark:text-emerald-400"> — full coverage</span>
                            )}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onUseExisting(match.ontologyId)}
                            className={cn(
                              'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all',
                              isBest
                                ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/20'
                                : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20'
                            )}
                          >
                            <ArrowRight className="w-3 h-3" />
                            Use This
                          </button>
                          <button
                            onClick={() => onCloneExisting(match.ontologyId)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                            Clone & Extend
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* No matches */}
            {sortedMatches.length === 0 && (
              <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5 text-center">
                <Sparkles className="w-8 h-8 text-indigo-300 dark:text-indigo-600 mx-auto mb-2" />
                <p className="text-sm font-semibold text-ink mb-1">No existing layers match your graph</p>
                <p className="text-xs text-ink-muted">
                  We'll create a new draft semantic layer with all {graphCounts.entities} entity types
                  and {graphCounts.rels} relationships detected.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          {/* Left side */}
          <div>
            {phase === 'recommendations' && sortedMatches.length > 0 && (
              <p className="text-[11px] text-ink-muted">
                Or generate a fresh draft instead
              </p>
            )}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isBusy}
              className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>

            {phase === 'confirm' && (
              <button
                onClick={handleAnalyze}
                className={cn(
                  'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm',
                  'bg-gradient-to-r from-indigo-500 to-purple-500 text-white',
                  'hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25',
                )}
              >
                <Sparkles className="w-4 h-4" />
                Analyze Graph
              </button>
            )}

            {phase === 'analyzing' && (
              <button
                disabled
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-purple-500 text-white opacity-60 shadow-sm"
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing...
              </button>
            )}

            {phase === 'recommendations' && (
              <button
                onClick={onCreateDraft}
                disabled={isCreating}
                className={cn(
                  'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm',
                  sortedMatches.length > 0
                    ? 'border border-glass-border text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5'
                    : 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25',
                  isCreating && 'opacity-60',
                )}
              >
                {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {isCreating ? 'Creating...' : 'Create New Draft'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
