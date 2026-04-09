/**
 * SuggestConfirmDialog — multi-phase dialog for "Suggest from Graph".
 *
 * Phase 1: Confirm — explains what will happen, shows data source context.
 * Phase 2: Analyzing — spinner while calling suggest endpoint.
 * Phase 3: Recommendations — searchable, selectable list of matching ontologies
 *          sorted by coverage %. Click a card to select, then confirm in footer.
 */
import { useState, useMemo } from 'react'
import {
  X, Sparkles, Database, Loader2, Box, GitBranch, Shield,
  CheckCircle2, Copy, ArrowRight, PenLine, Users, Check, Search, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyMatchResult, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

type Phase = 'confirm' | 'analyzing' | 'recommendations'

interface SuggestConfirmDialogProps {
  dataSourceLabel: string | null
  /** Pre-generated meaningful name for the new draft. */
  suggestedName?: string
  ontologies: OntologyDefinitionResponse[]
  /** The ontology ID currently assigned to the active data source. */
  currentOntologyId: string | null
  /** Map from ontology ID → number of data sources using it. */
  assignmentCountMap: Map<string, number>
  onAnalyze: () => Promise<{
    matches: OntologyMatchResult[]
    suggestedEntityCount: number
    suggestedRelCount: number
  }>
  onUseExisting: (ontologyId: string) => void
  onCloneExisting: (ontologyId: string) => void
  onCreateDraft: (name?: string) => void
  onClose: () => void
  isCreating: boolean
}

/** Mini donut-style ring for coverage. */
function CoverageRing({ percent, size = 52, stroke = 5, color }: {
  percent: number; size?: number; stroke?: number; color: string
}) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (percent / 100) * circ
  return (
    <svg width={size} height={size} className="flex-shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        className="stroke-black/[0.04] dark:stroke-white/[0.06]" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        className="transition-all duration-500" />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
        className="rotate-90 origin-center fill-current text-ink font-bold"
        style={{ fontSize: size * 0.28 }}>
        {percent}%
      </text>
    </svg>
  )
}

/** Tiny inline bar with label. */
function MiniBar({ covered, total, label, colorClass }: {
  covered: number; total: number; label: string; colorClass: string
}) {
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">{label}</span>
        <span className="text-[11px] font-bold text-ink">{covered}/{total}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
        <div className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function SuggestConfirmDialog({
  dataSourceLabel,
  suggestedName,
  ontologies,
  currentOntologyId,
  assignmentCountMap,
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draftName, setDraftName] = useState(suggestedName || 'Graph Schema')

  const isBusy = phase === 'analyzing' || isCreating

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
      // Auto-select the best match if available
      if (result.matches.length > 0) {
        const sorted = [...result.matches].sort((a, b) => {
          const aSystem = getOntology(a.ontologyId)?.isSystem ? 1 : 0
          const bSystem = getOntology(b.ontologyId)?.isSystem ? 1 : 0
          if (aSystem !== bSystem) return bSystem - aSystem
          return b.jaccardScore - a.jaccardScore
        })
        setSelectedId(sorted[0].ontologyId)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setPhase('confirm')
    }
  }

  // Sort: system first, then by Jaccard desc
  const sortedMatches = useMemo(() => [...matches].sort((a, b) => {
    const aSystem = getOntology(a.ontologyId)?.isSystem ? 1 : 0
    const bSystem = getOntology(b.ontologyId)?.isSystem ? 1 : 0
    if (aSystem !== bSystem) return bSystem - aSystem
    return b.jaccardScore - a.jaccardScore
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [matches, ontologies])

  // Filter by search query
  const filteredMatches = useMemo(() => {
    if (!search.trim()) return sortedMatches
    const q = search.toLowerCase()
    return sortedMatches.filter(m => {
      const ont = getOntology(m.ontologyId)
      return (
        m.ontologyName.toLowerCase().includes(q) ||
        ont?.description?.toLowerCase().includes(q)
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedMatches, search, ontologies])

  const selectedMatch = selectedId ? sortedMatches.find(m => m.ontologyId === selectedId) : null
  const selectedOnt = selectedId ? getOntology(selectedId) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={isBusy ? undefined : onClose} />
      <div className={cn(
        'relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden flex flex-col',
        phase === 'recommendations' ? 'max-w-2xl max-h-[85vh]' : 'max-w-md',
      )}>
        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4 flex-shrink-0">
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
                      ? `${matches.length} existing match${matches.length > 1 ? 'es' : ''} found — select one`
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

        {/* ── Phase 1 + 2: Confirm / Analyzing ─────────────────────── */}
        {(phase === 'confirm' || phase === 'analyzing') && (
          <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto">
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
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Graph stats banner */}
            <div className="px-6 pt-5 pb-3">
              <div className="flex items-center gap-1 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-500/[0.06] to-purple-500/[0.06] border border-indigo-500/10">
                <Database className="w-4 h-4 text-indigo-400 mr-2 flex-shrink-0" />
                <span className="text-xs text-ink-secondary">Your graph contains</span>
                <span className="text-xs font-bold text-ink mx-0.5">{graphCounts.entities}</span>
                <span className="text-xs text-ink-secondary mr-1">entity type{graphCounts.entities !== 1 ? 's' : ''}</span>
                <span className="text-xs text-ink-muted mx-1">and</span>
                <span className="text-xs font-bold text-ink mx-0.5">{graphCounts.rels}</span>
                <span className="text-xs text-ink-secondary">relationship{graphCounts.rels !== 1 ? 's' : ''}</span>
              </div>
            </div>

            {/* Search + match cards */}
            {sortedMatches.length > 0 && (
              <div className="px-6 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-xs font-semibold text-ink">Recommended Semantic Layers</p>
                    <p className="text-[11px] text-ink-muted mt-0.5">
                      Select a layer to use or clone, or create a new draft
                    </p>
                  </div>
                </div>

                {/* Search bar */}
                {sortedMatches.length > 3 && (
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
                    <input
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search semantic layers..."
                      className="w-full pl-9 pr-8 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border/60 text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 transition-all"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted/50 hover:text-ink-muted transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}

                {/* Filtered results count */}
                {search && (
                  <p className="text-[11px] text-ink-muted mb-2">
                    {filteredMatches.length} of {sortedMatches.length} match{sortedMatches.length !== 1 ? 'es' : ''}
                  </p>
                )}

                <div className="space-y-3">
                  {filteredMatches.map((match, idx) => {
                    const ont = getOntology(match.ontologyId)
                    const isSystem = ont?.isSystem ?? false
                    const isPublished = ont?.isPublished ?? false
                    const isBest = !search && idx === 0
                    const isSelected = selectedId === match.ontologyId
                    const isCurrent = match.ontologyId === currentOntologyId
                    const assignCount = assignmentCountMap.get(match.ontologyId) ?? 0

                    // Separate entity and relationship coverage
                    const entityTotal = match.coveredEntityTypes.length + match.uncoveredEntityTypes.length
                    const entityPct = entityTotal > 0 ? Math.round((match.coveredEntityTypes.length / entityTotal) * 100) : 0
                    const relTotal = match.coveredRelationshipTypes.length + match.uncoveredRelationshipTypes.length
                    const relPct = relTotal > 0 ? Math.round((match.coveredRelationshipTypes.length / relTotal) * 100) : 0

                    // Overall coverage (combined)
                    const totalCovered = match.coveredEntityTypes.length + match.coveredRelationshipTypes.length
                    const totalAll = entityTotal + relTotal
                    const overallPct = totalAll > 0 ? Math.round((totalCovered / totalAll) * 100) : 0

                    const ringColor = overallPct >= 80 ? '#10b981' : overallPct >= 50 ? '#f59e0b' : '#ef4444'

                    return (
                      <button
                        key={match.ontologyId}
                        type="button"
                        onClick={() => setSelectedId(match.ontologyId)}
                        className={cn(
                          'w-full text-left rounded-xl border-2 transition-all',
                          isSelected
                            ? 'border-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10 ring-1 ring-indigo-500/20'
                            : isCurrent
                              ? 'border-emerald-500/40 bg-emerald-50/10 dark:bg-emerald-950/10 hover:border-emerald-500/60'
                              : isBest
                                ? 'border-indigo-500/30 bg-indigo-50/10 dark:bg-indigo-950/5 hover:border-indigo-500/50'
                                : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.01] dark:hover:bg-white/[0.01]',
                        )}
                      >
                        {/* Currently assigned indicator */}
                        {isCurrent && (
                          <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-0">
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                              <Zap className="w-2.5 h-2.5 text-emerald-500" />
                              <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                                Currently Assigned
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Card header */}
                        <div className={cn('px-5 pb-3', isCurrent ? 'pt-2' : 'pt-4')}>
                          <div className="flex items-start gap-4">
                            {/* Selection radio + coverage donut */}
                            <div className="flex flex-col items-center gap-2 pt-0.5">
                              <div className={cn(
                                'w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                                isSelected
                                  ? 'border-indigo-500 bg-indigo-500'
                                  : 'border-glass-border-hover',
                              )}>
                                {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                              </div>
                              <CoverageRing percent={overallPct} color={ringColor} />
                            </div>

                            {/* Name + metadata */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                                <p className="text-sm font-bold text-ink truncate">{match.ontologyName}</p>
                                {isBest && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-sm">
                                    BEST MATCH
                                  </span>
                                )}
                              </div>

                              {/* Description */}
                              {ont?.description && (
                                <p className="text-[11px] text-ink-secondary leading-snug mb-1.5 line-clamp-2">
                                  {ont.description}
                                </p>
                              )}

                              {/* Badges row */}
                              <div className="flex items-center gap-1.5 flex-wrap mb-2">
                                <span className="text-[10px] text-ink-muted font-medium">v{match.version}</span>
                                {isSystem && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                                    <Shield className="w-2.5 h-2.5" />
                                    System
                                  </span>
                                )}
                                {isPublished && !isSystem && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                    Published
                                  </span>
                                )}
                                {!isPublished && !isSystem && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                    <PenLine className="w-2.5 h-2.5" />
                                    Draft
                                  </span>
                                )}
                                {assignCount > 0 && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                                    <Users className="w-2.5 h-2.5" />
                                    {assignCount} data source{assignCount !== 1 ? 's' : ''}
                                  </span>
                                )}
                              </div>

                              {/* Type counts */}
                              <div className="flex items-center gap-3 mb-2">
                                <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                                  <Box className="w-3 h-3 text-indigo-400" />
                                  {match.totalEntityTypes} entity type{match.totalEntityTypes !== 1 ? 's' : ''}
                                </span>
                                <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                                  <GitBranch className="w-3 h-3 text-purple-400" />
                                  {match.totalRelationshipTypes} relationship{match.totalRelationshipTypes !== 1 ? 's' : ''}
                                </span>
                              </div>

                              {/* Coverage bars */}
                              <div className="flex gap-4">
                                <MiniBar
                                  covered={match.coveredEntityTypes.length}
                                  total={entityTotal}
                                  label="Entity Types"
                                  colorClass={entityPct >= 80 ? 'bg-emerald-500' : entityPct >= 50 ? 'bg-amber-500' : 'bg-red-400'}
                                />
                                <MiniBar
                                  covered={match.coveredRelationshipTypes.length}
                                  total={relTotal}
                                  label="Relationships"
                                  colorClass={relPct >= 80 ? 'bg-emerald-500' : relPct >= 50 ? 'bg-amber-500' : 'bg-red-400'}
                                />
                              </div>

                              {/* Missing types detail (collapsed unless selected) */}
                              {isSelected && (match.uncoveredEntityTypes.length > 0 || match.uncoveredRelationshipTypes.length > 0) && (
                                <div className="mt-2.5 px-3 py-2 rounded-lg bg-amber-50/50 dark:bg-amber-950/10 border border-amber-200/30 dark:border-amber-800/20">
                                  {match.uncoveredEntityTypes.length > 0 && (
                                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                                      <span className="font-semibold">Missing entity types:</span>{' '}
                                      {match.uncoveredEntityTypes.slice(0, 5).join(', ')}
                                      {match.uncoveredEntityTypes.length > 5 && (
                                        <span className="text-amber-600/70 dark:text-amber-500/70">
                                          {' '}+{match.uncoveredEntityTypes.length - 5} more
                                        </span>
                                      )}
                                    </p>
                                  )}
                                  {match.uncoveredRelationshipTypes.length > 0 && (
                                    <p className={cn('text-[11px] text-amber-700 dark:text-amber-400', match.uncoveredEntityTypes.length > 0 && 'mt-1')}>
                                      <span className="font-semibold">Missing relationships:</span>{' '}
                                      {match.uncoveredRelationshipTypes.slice(0, 5).join(', ')}
                                      {match.uncoveredRelationshipTypes.length > 5 && (
                                        <span className="text-amber-600/70 dark:text-amber-500/70">
                                          {' '}+{match.uncoveredRelationshipTypes.length - 5} more
                                        </span>
                                      )}
                                    </p>
                                  )}
                                </div>
                              )}

                              {/* Full coverage callout (only when selected) */}
                              {isSelected && match.uncoveredEntityTypes.length === 0 && match.uncoveredRelationshipTypes.length === 0 && (
                                <div className="mt-2.5 px-3 py-2 rounded-lg bg-emerald-50/50 dark:bg-emerald-950/10 border border-emerald-200/30 dark:border-emerald-800/20">
                                  <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold flex items-center gap-1.5">
                                    <CheckCircle2 className="w-3 h-3" />
                                    Full coverage — this layer covers every type in your graph
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>

                {/* No search results */}
                {search && filteredMatches.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-xs text-ink-muted">No semantic layers match your search</p>
                  </div>
                )}
              </div>
            )}

            {/* ── "Create from Graph" option — always shown ────────── */}
            <div className="px-6 pb-4">
              {sortedMatches.length > 0 && (
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex-1 h-px bg-glass-border/60" />
                  <span className="text-[10px] font-medium text-ink-muted/50 uppercase tracking-wider">
                    Or start fresh
                  </span>
                  <div className="flex-1 h-px bg-glass-border/60" />
                </div>
              )}

              <button
                type="button"
                onClick={() => setSelectedId('__create_from_graph__')}
                className={cn(
                  'w-full text-left rounded-xl border-2 transition-all',
                  selectedId === '__create_from_graph__'
                    ? 'border-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10 ring-1 ring-indigo-500/20'
                    : 'border-dashed border-glass-border hover:border-indigo-500/30 hover:bg-black/[0.01] dark:hover:bg-white/[0.01]',
                )}
              >
                <div className="px-5 py-4">
                  <div className="flex items-start gap-4">
                    {/* Selection radio + icon */}
                    <div className="flex flex-col items-center gap-2 pt-0.5">
                      <div className={cn(
                        'w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                        selectedId === '__create_from_graph__'
                          ? 'border-indigo-500 bg-indigo-500'
                          : 'border-glass-border-hover',
                      )}>
                        {selectedId === '__create_from_graph__' && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500/15 to-purple-500/15 border border-indigo-500/10 flex items-center justify-center">
                        <Sparkles className="w-5 h-5 text-indigo-500" />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-ink mb-0.5">Create from Physical Graph</p>
                      <p className="text-[11px] text-ink-secondary leading-snug mb-2">
                        Generate a new semantic layer draft directly from the {graphCounts.entities} entity type{graphCounts.entities !== 1 ? 's' : ''}{' '}
                        and {graphCounts.rels} relationship{graphCounts.rels !== 1 ? 's' : ''} detected in your data source.
                        All node and edge types will be included.
                      </p>
                      <div className="flex items-center gap-3">
                        <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                          <Box className="w-3 h-3 text-indigo-400" />
                          {graphCounts.entities} entity type{graphCounts.entities !== 1 ? 's' : ''}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                          <GitBranch className="w-3 h-3 text-purple-400" />
                          {graphCounts.rels} relationship{graphCounts.rels !== 1 ? 's' : ''}
                        </span>
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          <PenLine className="w-2.5 h-2.5" />
                          New Draft
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className="border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
          {/* Selected layer summary */}
          {phase === 'recommendations' && selectedMatch && selectedOnt && (
            <div className="px-6 pt-3 pb-0">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50/40 dark:bg-indigo-950/15 border border-indigo-500/15">
                <Check className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-[11px] text-ink-secondary">
                  Selected: <span className="font-semibold text-ink">{selectedOnt.name}</span>
                  <span className="text-ink-muted ml-1">v{selectedMatch.version}</span>
                  {selectedId === currentOntologyId && (
                    <span className="text-emerald-600 dark:text-emerald-400 ml-1.5 font-medium">(currently assigned)</span>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* "Create from Graph" selection summary with name input */}
          {phase === 'recommendations' && selectedId === '__create_from_graph__' && (
            <div className="px-6 pt-3 pb-0">
              <div className="rounded-lg bg-indigo-50/40 dark:bg-indigo-950/15 border border-indigo-500/15 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                  <span className="text-[11px] text-ink-secondary">
                    New draft: <span className="font-semibold text-ink">{draftName}</span>
                    <span className="text-ink-muted ml-1">
                      — {graphCounts.entities} entity type{graphCounts.entities !== 1 ? 's' : ''}, {graphCounts.rels} relationship{graphCounts.rels !== 1 ? 's' : ''}
                    </span>
                  </span>
                </div>
                <div className="mt-2">
                  <label className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider mb-1 block">Name your schema</label>
                  <input
                    type="text"
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    placeholder="Enter schema name..."
                    className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-black/20 border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 transition-all"
                    autoFocus
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-6 py-4">
            <div>
              {phase === 'recommendations' && !selectedId && (
                <p className="text-[11px] text-ink-muted">
                  Select an option above to continue
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
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
                <button disabled
                  className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-purple-500 text-white opacity-60 shadow-sm"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analyzing...
                </button>
              )}

              {phase === 'recommendations' && (
                <>
                  {/* Clone & Extend — only when an existing layer is selected */}
                  {selectedId && selectedId !== '__create_from_graph__' && (
                    <button
                      onClick={() => onCloneExisting(selectedId)}
                      disabled={isCreating}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Clone & Extend
                    </button>
                  )}

                  {/* Primary confirm — changes label based on selection */}
                  {selectedId === '__create_from_graph__' ? (
                    <button
                      onClick={() => onCreateDraft(draftName.trim() || undefined)}
                      disabled={isCreating || !draftName.trim()}
                      className={cn(
                        'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm',
                        'bg-gradient-to-r from-indigo-500 to-purple-500 text-white',
                        'hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25',
                        (isCreating || !draftName.trim()) && 'opacity-60',
                      )}
                    >
                      {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      {isCreating ? 'Creating...' : 'Create from Graph'}
                    </button>
                  ) : selectedId ? (
                    <button
                      onClick={() => onUseExisting(selectedId)}
                      disabled={isCreating}
                      className={cn(
                        'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm',
                        'bg-gradient-to-r from-indigo-500 to-purple-500 text-white',
                        'hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25',
                        isCreating && 'opacity-60',
                      )}
                    >
                      <ArrowRight className="w-4 h-4" />
                      Use Selected
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
