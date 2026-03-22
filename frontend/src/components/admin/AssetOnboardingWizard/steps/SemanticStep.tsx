/**
 * SemanticStep — Per-source ontology assignment in the onboarding wizard.
 *
 * Each data source gets its own ontology since graph schemas can differ.
 * Coverage analysis warns when a selected ontology doesn't fully cover
 * the graph's entity/relationship types (mirrors OntologySchemaPage CoveragePanel).
 */
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, Sparkles, Check, X, Loader2, ChevronDown, AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { OntologyDefinitionResponse, OntologyMatchResult, OntologyCoverageResponse } from '@/services/ontologyDefinitionService'
import { providerService } from '@/services/providerService'
import type { CatalogItemResponse } from '@/services/catalogService'
import type { OnboardingFormData } from '../AssetOnboardingWizard'

interface SemanticStepProps {
    formData: OnboardingFormData
    updateFormData: (updates: Partial<OnboardingFormData>) => void
    catalogItems: CatalogItemResponse[]
    providerId: string
}

interface SuggestionState {
    loading: boolean
    error: string | null
    result: OntologyMatchResult | null
}

interface CoverageWarning {
    loading: boolean
    data: OntologyCoverageResponse | null
    error: string | null
}

/** Convert PhysicalGraphStatsResponse → GraphSchemaStats (suggest endpoint format) */
function transformStatsForSuggest(raw: any): Record<string, unknown> {
    return {
        totalNodes: raw.nodeCount ?? 0,
        totalEdges: raw.edgeCount ?? 0,
        entityTypeStats: Object.entries(raw.entityTypeCounts ?? {}).map(
            ([name, count]) => ({ id: name, name, count: count as number, sampleNames: [] })
        ),
        edgeTypeStats: Object.entries(raw.edgeTypeCounts ?? {}).map(
            ([name, count]) => ({ id: name, name, count: count as number, sourceTypes: [], targetTypes: [] })
        ),
        tagStats: [],
    }
}

function coverageTextClass(pct: number): string {
    if (pct >= 70) return 'text-emerald-400'
    if (pct >= 40) return 'text-amber-400'
    return 'text-red-400'
}

function coverageBarClass(pct: number): string {
    if (pct >= 70) return 'bg-gradient-to-r from-emerald-500 to-emerald-400'
    if (pct >= 40) return 'bg-gradient-to-r from-amber-500 to-amber-400'
    return 'bg-gradient-to-r from-red-500 to-red-400'
}

export function SemanticStep({
    formData,
    updateFormData,
    catalogItems,
    providerId,
}: SemanticStepProps) {
    const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])
    const [loadingOntologies, setLoadingOntologies] = useState(true)
    const [suggestions, setSuggestions] = useState<Record<string, SuggestionState>>({})
    const [coverageWarnings, setCoverageWarnings] = useState<Record<string, CoverageWarning>>({})
    const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set(catalogItems.map(c => c.id)))
    // Cache raw stats per item so we can re-check coverage when ontology changes
    const [cachedStats, setCachedStats] = useState<Record<string, Record<string, unknown>>>({})

    // Load ontologies on mount — show all (published first, then drafts)
    useEffect(() => {
        let cancelled = false
        setLoadingOntologies(true)
        ontologyDefinitionService.list().then(all => {
            if (cancelled) return
            setOntologies(all.sort((a, b) => (b.isPublished ? 1 : 0) - (a.isPublished ? 1 : 0)))
            setLoadingOntologies(false)
        }).catch(() => {
            if (!cancelled) setLoadingOntologies(false)
        })
        return () => { cancelled = true }
    }, [])

    const updateOntologySelection = useCallback((itemId: string, updates: Partial<OnboardingFormData['ontologySelections'][string]>) => {
        updateFormData({
            ontologySelections: {
                ...formData.ontologySelections,
                [itemId]: {
                    ...formData.ontologySelections[itemId],
                    ...updates,
                },
            },
        })
    }, [formData.ontologySelections, updateFormData])

    // Check coverage when ontology selection changes (if we have cached stats)
    const checkCoverage = useCallback(async (itemId: string, ontologyId: string) => {
        const stats = cachedStats[itemId]
        if (!stats || !ontologyId) {
            setCoverageWarnings(prev => ({ ...prev, [itemId]: { loading: false, data: null, error: null } }))
            return
        }
        setCoverageWarnings(prev => ({ ...prev, [itemId]: { loading: true, data: null, error: null } }))
        try {
            const c = await ontologyDefinitionService.coverage(ontologyId, stats)
            setCoverageWarnings(prev => ({ ...prev, [itemId]: { loading: false, data: c, error: null } }))
        } catch (err) {
            setCoverageWarnings(prev => ({
                ...prev,
                [itemId]: { loading: false, data: null, error: err instanceof Error ? err.message : 'Coverage check failed' },
            }))
        }
    }, [cachedStats])

    const handleOntologyChange = useCallback((itemId: string, ontologyId: string) => {
        updateOntologySelection(itemId, {
            ontologyId,
            coverageStats: null,
            suggestedOntology: null,
        })
        // Re-check coverage if we have stats cached
        if (cachedStats[itemId] && ontologyId) {
            checkCoverage(itemId, ontologyId)
        }
    }, [updateOntologySelection, cachedStats, checkCoverage])

    const handleSuggest = async (item: CatalogItemResponse) => {
        setSuggestions(prev => ({
            ...prev,
            [item.id]: { loading: true, error: null, result: null },
        }))

        try {
            const assetName = item.sourceIdentifier || item.name
            const rawStats = await providerService.getAssetStats(providerId, assetName)
            const transformedStats = transformStatsForSuggest(rawStats)

            // Cache for future coverage checks
            setCachedStats(prev => ({ ...prev, [item.id]: transformedStats }))

            const suggestion = await ontologyDefinitionService.suggest(transformedStats)

            const bestMatch = suggestion.matchingOntologies.length > 0
                ? suggestion.matchingOntologies.reduce((a, b) => a.jaccardScore > b.jaccardScore ? a : b)
                : null

            setSuggestions(prev => ({
                ...prev,
                [item.id]: { loading: false, error: null, result: bestMatch },
            }))

            updateOntologySelection(item.id, {
                suggestedOntology: suggestion,
                coverageStats: bestMatch,
                ontologyId: bestMatch?.ontologyId ?? formData.ontologySelections[item.id]?.ontologyId ?? '',
            })

            // If we got a match, also run coverage check
            if (bestMatch?.ontologyId) {
                checkCoverage(item.id, bestMatch.ontologyId)
            }

            setExpandedItems(prev => new Set(prev).add(item.id))
        } catch (err) {
            setSuggestions(prev => ({
                ...prev,
                [item.id]: {
                    loading: false,
                    error: err instanceof Error ? err.message : 'Failed to analyze schema',
                    result: null,
                },
            }))
        }
    }

    const getWorkspaceName = (itemId: string): string => {
        const alloc = formData.allocations[itemId]
        if (!alloc) return 'Unassigned'
        if (alloc.workspaceId === 'new') return alloc.newWorkspaceName || 'New Workspace'
        if (alloc.workspaceId) return alloc.newWorkspaceName || alloc.workspaceId
        return 'Unassigned'
    }

    const toggleExpand = (itemId: string) => {
        setExpandedItems(prev => {
            const next = new Set(prev)
            if (next.has(itemId)) next.delete(itemId)
            else next.add(itemId)
            return next
        })
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-ink">Configure Semantic Layer</h3>
                    <p className="text-sm text-ink-muted mt-0.5">
                        Assign an ontology to each data source. Graph schemas can differ across sources,
                        so each gets its own semantic layer configuration.
                    </p>
                </div>
            </div>

            {/* Info banner */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="glass-panel-subtle rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 flex items-start gap-3"
            >
                <Info className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-ink-secondary leading-relaxed">
                    Use <strong>Analyze Coverage</strong> to auto-detect the best ontology for each source.
                    If an ontology doesn't fully cover the graph schema, you'll see a coverage warning
                    with the uncovered types listed.
                </p>
            </motion.div>

            {/* Per-source ontology cards */}
            <div className="space-y-4">
                {catalogItems.map((item, index) => {
                    const selection = formData.ontologySelections[item.id]
                    const suggestion = suggestions[item.id]
                    const coverageW = coverageWarnings[item.id]
                    const coverage = selection?.coverageStats as OntologyMatchResult | null
                    const isExpanded = expandedItems.has(item.id)

                    const itemOntologyId = selection?.ontologyId ?? ''

                    // Coverage from suggestion (auto-suggest) or from manual coverage check
                    const totalTypes = coverage
                        ? coverage.totalEntityTypes + coverage.totalRelationshipTypes
                        : 0
                    const coveredTypes = coverage
                        ? coverage.coveredEntityTypes.length + coverage.coveredRelationshipTypes.length
                        : 0
                    const coveragePct = totalTypes > 0 ? Math.round((coveredTypes / totalTypes) * 100) : 0

                    // Coverage warning from manual ontology selection
                    const hasWarning = coverageW?.data && coverageW.data.coveragePercent < 100
                    const warningData = coverageW?.data

                    return (
                        <motion.div
                            key={item.id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            className="glass-panel rounded-xl p-5 space-y-4"
                        >
                            {/* Item header */}
                            <div className="flex items-center justify-between">
                                <button
                                    type="button"
                                    onClick={() => toggleExpand(item.id)}
                                    className="flex items-center gap-2 text-left flex-1 min-w-0"
                                >
                                    <ChevronDown className={cn(
                                        'w-4 h-4 text-ink-muted transition-transform duration-200',
                                        isExpanded && 'rotate-180'
                                    )} />
                                    <span className="text-sm font-medium text-ink truncate">{item.name}</span>
                                    <span className="text-ink-secondary mx-1">&rarr;</span>
                                    <span className="text-xs text-ink-muted truncate">{getWorkspaceName(item.id)}</span>
                                </button>

                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                    {itemOntologyId ? (
                                        <div className="flex items-center gap-1.5 text-emerald-400">
                                            <Check className="w-3.5 h-3.5" />
                                            <span className="text-xs font-medium">Configured</span>
                                        </div>
                                    ) : (
                                        <span className="text-xs font-medium text-amber-400">Pending</span>
                                    )}
                                </div>
                            </div>

                            {/* Expanded content */}
                            <AnimatePresence>
                                {isExpanded && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="space-y-4 overflow-hidden"
                                    >
                                        {/* Ontology selector + suggest button */}
                                        <div className="flex items-center gap-3">
                                            <select
                                                value={itemOntologyId}
                                                onChange={(e) => handleOntologyChange(item.id, e.target.value)}
                                                disabled={loadingOntologies}
                                                className={cn(
                                                    'flex-1 rounded-lg border border-glass-border bg-transparent px-3 py-2',
                                                    'text-sm text-ink placeholder:text-ink-secondary',
                                                    'focus:outline-none focus:ring-1 focus:ring-indigo-500/50',
                                                    'disabled:opacity-50',
                                                )}
                                            >
                                                <option value="">
                                                    {loadingOntologies ? 'Loading ontologies...' : 'Select an ontology...'}
                                                </option>
                                                {ontologies.map(o => (
                                                    <option key={o.id} value={o.id}>
                                                        {o.name} (v{o.version}){o.isPublished ? '' : ' — Draft'}
                                                    </option>
                                                ))}
                                            </select>

                                            <button
                                                type="button"
                                                onClick={() => handleSuggest(item)}
                                                disabled={suggestion?.loading}
                                                className={cn(
                                                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium',
                                                    'border border-glass-border whitespace-nowrap',
                                                    'hover:bg-indigo-500/10 hover:border-indigo-500/30 hover:text-indigo-400',
                                                    'transition-colors duration-150',
                                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                                    suggestion?.loading
                                                        ? 'text-indigo-400 border-indigo-500/30 bg-indigo-500/5'
                                                        : 'text-ink-muted',
                                                )}
                                            >
                                                {suggestion?.loading ? (
                                                    <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
                                                ) : (
                                                    <><Sparkles className="w-4 h-4" /> Analyze Coverage</>
                                                )}
                                            </button>
                                        </div>

                                        {/* Error state */}
                                        {suggestion?.error && (
                                            <div className="flex items-center gap-2 text-sm text-red-400">
                                                <X className="w-4 h-4 flex-shrink-0" />
                                                <span>{suggestion.error}</span>
                                            </div>
                                        )}

                                        {/* Coverage warning from manual ontology selection */}
                                        {coverageW?.loading && (
                                            <div className="flex items-center gap-2 text-sm text-ink-muted">
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                <span>Checking coverage...</span>
                                            </div>
                                        )}
                                        {hasWarning && warningData && (
                                            <motion.div
                                                initial={{ opacity: 0, y: 4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 space-y-2"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                                                    <span className="text-sm font-medium text-amber-400">
                                                        Coverage: {Math.round(warningData.coveragePercent)}% — {warningData.uncoveredEntityTypes.length + warningData.uncoveredRelationshipTypes.length} type{warningData.uncoveredEntityTypes.length + warningData.uncoveredRelationshipTypes.length !== 1 ? 's' : ''} not covered
                                                    </span>
                                                </div>
                                                <p className="text-xs text-ink-muted">
                                                    This ontology does not define all types found in the graph.
                                                    Uncovered types won't appear in contextual views or lineage traversal.
                                                </p>
                                                {warningData.uncoveredEntityTypes.length > 0 && (
                                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                                        {warningData.uncoveredEntityTypes.map(t => (
                                                            <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                                                                <X className="w-3 h-3" />{t}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {warningData.uncoveredRelationshipTypes.length > 0 && (
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {warningData.uncoveredRelationshipTypes.map(t => (
                                                            <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                                                                <X className="w-3 h-3" />{t}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </motion.div>
                                        )}
                                        {coverageW?.data && coverageW.data.coveragePercent >= 100 && (
                                            <div className="flex items-center gap-2 text-sm text-emerald-400">
                                                <Check className="w-4 h-4" />
                                                <span>Full coverage — all graph types are defined in this ontology</span>
                                            </div>
                                        )}

                                        {/* Coverage Heatmap from auto-suggest */}
                                        {coverage && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                className="space-y-3 pt-1"
                                            >
                                                {/* Coverage bar */}
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-xs font-medium text-ink-muted">
                                                            Best Match Coverage
                                                        </span>
                                                        <span className={cn(
                                                            'text-xs font-bold',
                                                            coverageTextClass(coveragePct),
                                                        )}>
                                                            {coveragePct}% ({coveredTypes}/{totalTypes} types)
                                                        </span>
                                                    </div>
                                                    <div className="h-2 rounded-full bg-slate-700/50 overflow-hidden">
                                                        <motion.div
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${coveragePct}%` }}
                                                            transition={{ duration: 0.6, ease: 'easeOut' }}
                                                            className={cn('h-full rounded-full', coverageBarClass(coveragePct))}
                                                        />
                                                    </div>
                                                </div>

                                                {/* Entity types */}
                                                <div className="space-y-1.5">
                                                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-secondary">
                                                        Entity Types
                                                    </span>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {coverage.coveredEntityTypes.map((t, i) => (
                                                            <motion.span
                                                                key={t}
                                                                initial={{ opacity: 0, scale: 0.8 }}
                                                                animate={{ opacity: 1, scale: 1 }}
                                                                transition={{ delay: i * 0.02 }}
                                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                                            >
                                                                <Check className="w-3 h-3" />{t}
                                                            </motion.span>
                                                        ))}
                                                        {coverage.uncoveredEntityTypes.map((t, i) => (
                                                            <motion.span
                                                                key={t}
                                                                initial={{ opacity: 0, scale: 0.8 }}
                                                                animate={{ opacity: 1, scale: 1 }}
                                                                transition={{ delay: (coverage.coveredEntityTypes.length + i) * 0.02 }}
                                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20"
                                                            >
                                                                <X className="w-3 h-3" />{t}
                                                            </motion.span>
                                                        ))}
                                                    </div>
                                                </div>

                                                {/* Relationship types */}
                                                <div className="space-y-1.5">
                                                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-secondary">
                                                        Relationship Types
                                                    </span>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {coverage.coveredRelationshipTypes.map((t, i) => (
                                                            <motion.span
                                                                key={t}
                                                                initial={{ opacity: 0, scale: 0.8 }}
                                                                animate={{ opacity: 1, scale: 1 }}
                                                                transition={{ delay: i * 0.02 }}
                                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                                            >
                                                                <Check className="w-3 h-3" />{t}
                                                            </motion.span>
                                                        ))}
                                                        {coverage.uncoveredRelationshipTypes.map((t, i) => (
                                                            <motion.span
                                                                key={t}
                                                                initial={{ opacity: 0, scale: 0.8 }}
                                                                animate={{ opacity: 1, scale: 1 }}
                                                                transition={{ delay: (coverage.coveredRelationshipTypes.length + i) * 0.02 }}
                                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20"
                                                            >
                                                                <X className="w-3 h-3" />{t}
                                                            </motion.span>
                                                        ))}
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.div>
                    )
                })}
            </div>
        </div>
    )
}
