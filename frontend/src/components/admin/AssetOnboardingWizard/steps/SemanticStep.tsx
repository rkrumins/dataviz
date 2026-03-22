/**
 * SemanticStep — Ontology assignment in the onboarding wizard.
 *
 * Ontologies are shared, reusable semantic layers that can span across
 * different sources, workspaces, and providers. This step therefore uses
 * a PRIMARY ontology selector at the top that applies to ALL items being
 * onboarded, with optional per-item overrides and per-item coverage heatmaps.
 */
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, Sparkles, Check, X, Loader2, ChevronDown, Info, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { OntologyDefinitionResponse, OntologyMatchResult } from '@/services/ontologyDefinitionService'
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
    const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
    const [perItemOverrides, setPerItemOverrides] = useState<Set<string>>(new Set())

    // The "primary" ontology is derived from the first item's selection
    // (all non-overridden items share this value)
    const primaryOntologyId = (() => {
        const firstItem = catalogItems[0]
        if (!firstItem) return ''
        return formData.ontologySelections[firstItem.id]?.ontologyId ?? ''
    })()

    // Load published ontologies on mount
    useEffect(() => {
        let cancelled = false
        setLoadingOntologies(true)
        ontologyDefinitionService.list().then(all => {
            if (cancelled) return
            // Show all ontologies (published + drafts) — sorted: published first
            setOntologies(all.sort((a, b) => (b.isPublished ? 1 : 0) - (a.isPublished ? 1 : 0)))
            setLoadingOntologies(false)
        }).catch(() => {
            if (!cancelled) setLoadingOntologies(false)
        })
        return () => { cancelled = true }
    }, [])

    // Apply primary ontology to all non-overridden items
    const applyPrimaryOntology = useCallback((ontologyId: string) => {
        const updated: OnboardingFormData['ontologySelections'] = { ...formData.ontologySelections }
        for (const item of catalogItems) {
            if (!perItemOverrides.has(item.id)) {
                updated[item.id] = {
                    ...updated[item.id],
                    ontologyId,
                    // Clear coverage when primary changes — user can re-run suggest
                    coverageStats: null,
                    suggestedOntology: null,
                }
            }
        }
        updateFormData({ ontologySelections: updated })
    }, [catalogItems, formData.ontologySelections, perItemOverrides, updateFormData])

    const updateItemOntology = useCallback((itemId: string, ontologyId: string) => {
        updateFormData({
            ontologySelections: {
                ...formData.ontologySelections,
                [itemId]: {
                    ...formData.ontologySelections[itemId],
                    ontologyId,
                    coverageStats: null,
                    suggestedOntology: null,
                },
            },
        })
    }, [formData.ontologySelections, updateFormData])

    const handleSuggest = async (item: CatalogItemResponse) => {
        setSuggestions(prev => ({
            ...prev,
            [item.id]: { loading: true, error: null, result: null },
        }))

        try {
            const assetName = item.sourceIdentifier || item.name
            const graphStats = await providerService.getAssetStats(providerId, assetName)
            const suggestion = await ontologyDefinitionService.suggest(graphStats)

            const bestMatch = suggestion.matchingOntologies.length > 0
                ? suggestion.matchingOntologies.reduce((a, b) => a.jaccardScore > b.jaccardScore ? a : b)
                : null

            setSuggestions(prev => ({
                ...prev,
                [item.id]: { loading: false, error: null, result: bestMatch },
            }))

            updateFormData({
                ontologySelections: {
                    ...formData.ontologySelections,
                    [item.id]: {
                        ...formData.ontologySelections[item.id],
                        suggestedOntology: suggestion,
                        coverageStats: bestMatch,
                        ontologyId: bestMatch?.ontologyId ?? formData.ontologySelections[item.id]?.ontologyId ?? '',
                    },
                },
            })

            // Auto-expand item to show coverage heatmap
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

    const toggleOverride = (itemId: string) => {
        setPerItemOverrides(prev => {
            const next = new Set(prev)
            if (next.has(itemId)) {
                next.delete(itemId)
                // Reset to primary ontology
                updateItemOntology(itemId, primaryOntologyId)
            } else {
                next.add(itemId)
            }
            return next
        })
    }

    const selectedOntology = ontologies.find(o => o.id === primaryOntologyId)

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
                        Select a shared ontology for your data sources. Ontologies define entity types
                        and relationships that power contextual views, search, and lineage traversal.
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
                    Ontologies are shared semantic layers that span across sources, workspaces, and providers.
                    Selecting one here applies it to all data sources being onboarded. You can override
                    individual items if their schema differs significantly.
                </p>
            </motion.div>

            {/* ── Primary Ontology Selector ── */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="glass-panel rounded-xl border border-glass-border p-5 space-y-3"
            >
                <label className="block text-xs font-bold text-ink-muted uppercase tracking-wider">
                    Ontology for All Sources
                </label>
                <select
                    value={primaryOntologyId}
                    onChange={(e) => applyPrimaryOntology(e.target.value)}
                    disabled={loadingOntologies}
                    className={cn(
                        'w-full rounded-lg border border-glass-border bg-transparent px-3 py-2.5',
                        'text-sm text-ink placeholder:text-ink-secondary',
                        'focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/40',
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

                {/* Selected ontology details */}
                {selectedOntology && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="flex items-center gap-3 pt-1"
                    >
                        <div className="flex items-center gap-1.5 text-emerald-400">
                            <Check className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">{selectedOntology.name}</span>
                        </div>
                        <span className="text-[10px] text-ink-muted">
                            v{selectedOntology.version} &middot; {selectedOntology.scope}
                        </span>
                        {selectedOntology.description && (
                            <span className="text-[10px] text-ink-muted truncate max-w-[200px]">
                                &mdash; {selectedOntology.description}
                            </span>
                        )}
                    </motion.div>
                )}
            </motion.div>

            {/* ── Per-Item Coverage & Overrides ── */}
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink-muted uppercase tracking-wider">
                        Per-Source Coverage
                    </span>
                    <span className="text-[10px] text-ink-muted">
                        {catalogItems.length} source{catalogItems.length !== 1 ? 's' : ''}
                    </span>
                </div>

                {catalogItems.map((item, index) => {
                    const selection = formData.ontologySelections[item.id]
                    const suggestion = suggestions[item.id]
                    const coverage = selection?.coverageStats as OntologyMatchResult | null
                    const isOverridden = perItemOverrides.has(item.id)
                    const isExpanded = expandedItems.has(item.id)

                    const totalTypes = coverage
                        ? coverage.totalEntityTypes + coverage.totalRelationshipTypes
                        : 0
                    const coveredTypes = coverage
                        ? coverage.coveredEntityTypes.length + coverage.coveredRelationshipTypes.length
                        : 0
                    const coveragePct = totalTypes > 0 ? Math.round((coveredTypes / totalTypes) * 100) : 0

                    const itemOntologyId = selection?.ontologyId ?? ''
                    const itemOntology = ontologies.find(o => o.id === itemOntologyId)

                    return (
                        <motion.div
                            key={item.id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.15 + index * 0.05 }}
                            className="glass-panel rounded-xl p-4 space-y-3"
                        >
                            {/* Item header row */}
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
                                    {/* Coverage badge (if analysed) */}
                                    {coverage && (
                                        <span className={cn(
                                            'text-xs font-bold',
                                            coverageTextClass(coveragePct),
                                        )}>
                                            {coveragePct}%
                                        </span>
                                    )}

                                    {/* Ontology status */}
                                    {itemOntologyId ? (
                                        <div className="flex items-center gap-1 text-emerald-400">
                                            <Check className="w-3.5 h-3.5" />
                                            <span className="text-[10px] font-medium">
                                                {isOverridden ? itemOntology?.name || 'Custom' : 'Inherited'}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-[10px] font-medium text-amber-400">Pending</span>
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
                                        className="space-y-3 overflow-hidden"
                                    >
                                        {/* Override toggle + per-item selector */}
                                        <div className="flex items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={() => toggleOverride(item.id)}
                                                className={cn(
                                                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                                                    'border',
                                                    isOverridden
                                                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                                                        : 'border-glass-border text-ink-muted hover:border-indigo-500/20 hover:text-ink-secondary',
                                                )}
                                            >
                                                <Settings2 className="w-3 h-3" />
                                                {isOverridden ? 'Using Override' : 'Override Ontology'}
                                            </button>

                                            {isOverridden && (
                                                <select
                                                    value={itemOntologyId}
                                                    onChange={(e) => updateItemOntology(item.id, e.target.value)}
                                                    className={cn(
                                                        'flex-1 rounded-lg border border-glass-border bg-transparent px-3 py-1.5',
                                                        'text-sm text-ink',
                                                        'focus:outline-none focus:ring-1 focus:ring-indigo-500/50',
                                                    )}
                                                >
                                                    <option value="">Select ontology...</option>
                                                    {ontologies.map(o => (
                                                        <option key={o.id} value={o.id}>
                                                            {o.name} (v{o.version})
                                                        </option>
                                                    ))}
                                                </select>
                                            )}

                                            {/* Auto-suggest button */}
                                            <button
                                                type="button"
                                                onClick={() => handleSuggest(item)}
                                                disabled={suggestion?.loading}
                                                className={cn(
                                                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium',
                                                    'border border-glass-border',
                                                    'hover:bg-indigo-500/10 hover:border-indigo-500/30 hover:text-indigo-400',
                                                    'transition-colors duration-150',
                                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                                    suggestion?.loading
                                                        ? 'text-indigo-400 border-indigo-500/30 bg-indigo-500/5'
                                                        : 'text-ink-muted',
                                                )}
                                            >
                                                {suggestion?.loading ? (
                                                    <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</>
                                                ) : (
                                                    <><Sparkles className="w-3 h-3" /> Analyze Coverage</>
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

                                        {/* Coverage Heatmap */}
                                        {coverage && (
                                            <div className="space-y-3 pt-1">
                                                {/* Coverage bar */}
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-xs font-medium text-ink-muted">
                                                            Schema Coverage
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
                                                                <Check className="w-3 h-3" />
                                                                {t}
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
                                                                <X className="w-3 h-3" />
                                                                {t}
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
                                                                <Check className="w-3 h-3" />
                                                                {t}
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
                                                                <X className="w-3 h-3" />
                                                                {t}
                                                            </motion.span>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
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
