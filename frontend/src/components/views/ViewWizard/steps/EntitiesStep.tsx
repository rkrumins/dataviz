/**
 * EntitiesStep - Third wizard step for entity and edge type selection
 * 
 * Features:
 * - Graph overview showing all available types with counts
 * - Smart filtering by tags, names, and properties
 * - Real-time matching count
 * - Beautiful card-based selection
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search,
    Filter,
    X,
    Check,
    ChevronDown,
    ChevronRight,
    Tag,
    Type,
    Hash,
    Box,
    GitBranch,
    Layers,
    Sparkles,
    Info,
    ListTree
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGraphProvider, useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { useOntologyDefinition } from '@/hooks/useOntologyDefinition'
import { useWorkspacesStore } from '@/store/workspaces'
import { OntologyHierarchyPreview } from '../OntologyHierarchyPreview'
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import type { WizardFormData, ActiveFilter } from '../ViewWizard'

// ============================================
// Types
// ============================================

interface EntitiesStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    /** Data source whose assigned ontology scopes entity/relationship type pickers. */
    dataSourceId?: string
    /** Create mode may prune its OWN seed; an existing view's selection is the user's. */
    mode?: 'create' | 'edit'
}

// interface ActiveFilter moved to ViewWizard.tsx

/**
 * Index type-count summaries by CASEFOLDED id.
 *
 * Stats are keyed by the type string as it exists in the GRAPH (the FalkorDB
 * provider emits `EdgeTypeSummary(id=t)` straight from the physical relationship
 * type), while the pickers below are keyed by the DECLARED ontology id. Those
 * two drift in case — `has` vs `HAS` — and the backend itself casefolds whenever
 * it compares them (ontology/resolver.py, ontologies.py). An exact match here
 * silently resolved every edge count to zero, so match the same way the backend
 * does.
 *
 * Variants that casefold together are SUMMED: a graph carrying both `has` and
 * `HAS` edges genuinely has both under the declared `HAS`.
 */
function indexCounts(summaries: { id: string; count: number }[] | undefined): Map<string, number> {
    const map = new Map<string, number>()
    for (const s of summaries ?? []) {
        const key = s.id.trim().toLowerCase()
        map.set(key, (map.get(key) ?? 0) + s.count)
    }
    return map
}

const countKey = (id: string) => id.trim().toLowerCase()

// ============================================
// Component
// ============================================

export function EntitiesStep({ formData, updateFormData, dataSourceId, mode = 'create' }: EntitiesStepProps) {
    const provider = useGraphProvider()
    const { workspaceId } = useGraphProviderContext()
    const {
        entityTypes: dsEntityTypes,
        relationshipTypes: dsRelationshipTypes,
        containmentEdgeTypes,
        rootEntityTypes,
        isLoading: schemaLoading,
        isError: schemaError,
    } = useDataSourceSchema(dataSourceId)

    // ── Prune phantom type ids ────────────────────────────────────────────────
    // The wizard seeds visibleEntityTypes/visibleRelationshipTypes from the SCHEMA
    // STORE, which can carry a wider set than the data source's own ontology — in
    // the wild, 12 relationship ids for a 3-relationship ontology. Those phantom
    // ids can never match anything, yet they were saved onto the view. Drop them
    // once this data source's real schema is known.
    //
    // Create mode only: an existing view's selection belongs to the user (and to
    // the drift banner), not to us.
    useEffect(() => {
        if (mode !== 'create' || schemaLoading || schemaError) return
        if (dsEntityTypes.length === 0 && dsRelationshipTypes.length === 0) return

        const entityIds = new Set(dsEntityTypes.map(t => t.id))
        const relIds = new Set(dsRelationshipTypes.map(t => t.id))
        const prunedEntities = formData.visibleEntityTypes.filter(id => entityIds.has(id))
        const prunedRels = formData.visibleRelationshipTypes.filter(id => relIds.has(id))

        const updates: Partial<WizardFormData> = {}
        if (prunedEntities.length !== formData.visibleEntityTypes.length) {
            updates.visibleEntityTypes = prunedEntities
        }
        if (prunedRels.length !== formData.visibleRelationshipTypes.length) {
            updates.visibleRelationshipTypes = prunedRels
        }
        if (Object.keys(updates).length > 0) updateFormData(updates)
    }, [
        mode, schemaLoading, schemaError, dsEntityTypes, dsRelationshipTypes,
        formData.visibleEntityTypes, formData.visibleRelationshipTypes, updateFormData,
    ])

    // The semantic layer this view is built on. The ontologies endpoint is
    // admin-gated (silently), so non-admins get `null` and we fall back to a
    // compact card built from the schema we already loaded.
    const ontologyId = useWorkspacesStore(s => {
        for (const ws of s.workspaces) {
            const ds = ws.dataSources?.find(d => d.id === dataSourceId)
            if (ds) return ds.ontologyId
        }
        return undefined
    })
    const { ontology } = useOntologyDefinition(ontologyId)

    // Dynamic metadata and stats
    const [stats, setStats] = useState<GraphSchemaStats | null>(null)
    const [_isLoadingStats, setIsLoadingStats] = useState(true)

    const [searchQuery, setSearchQuery] = useState('')
    const [showFilters, setShowFilters] = useState(false)
    const [showEdgeTypes, setShowEdgeTypes] = useState(false)
    const [showScopeConfig, setShowScopeConfig] = useState(false)

    // Load dynamic data — try DB cache first, fall back to provider
    useEffect(() => {
        async function loadDynamicData() {
            try {
                setIsLoadingStats(true)
                let schemaStats: GraphSchemaStats | null = null

                // 1. Try cached stats from management DB (no provider dependency).
                //    ``fetchEnveloped`` unwraps the {data, meta} envelope and
                //    integrates with the same circuit breaker the provider uses.
                if (workspaceId && dataSourceId) {
                    const data = await fetchEnveloped<{
                        schemaStats?: GraphSchemaStats
                    }>(
                        `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-stats`,
                        { circuitScope: { workspaceId, dataSourceId } },
                    )
                    if (data?.schemaStats) schemaStats = data.schemaStats
                }

                // 2. Fall back to provider (which also unwraps internally)
                if (!schemaStats) {
                    schemaStats = await provider.getSchemaStats()
                }

                setStats(schemaStats)

                // Initialize scope if empty
                if (!formData.scopeEdges?.edgeTypes.length) {
                    updateFormData({
                        scopeEdges: {
                            edgeTypes: containmentEdgeTypes,
                            includeAll: false
                        }
                    })
                }
            } catch (error) {
                console.error('Failed to load dynamic data', error)
            } finally {
                setIsLoadingStats(false)
            }
        }
        loadDynamicData()
    }, [provider, workspaceId, dataSourceId, containmentEdgeTypes, formData.scopeEdges?.edgeTypes.length, updateFormData])

    // Physical graph counts, keyed so declared↔physical case drift can't hide them.
    const entityCounts = useMemo(() => indexCounts(stats?.entityTypeStats), [stats])
    const edgeCounts = useMemo(() => indexCounts(stats?.edgeTypeStats), [stats])
    const containmentKeys = useMemo(
        () => new Set(containmentEdgeTypes.map(countKey)),
        [containmentEdgeTypes],
    )

    // `count: undefined` means the graph reported NO count for this type — which
    // is not the same as "zero instances", and must not be rendered as one.
    const entityTypesWithState = useMemo(() => {
        return dsEntityTypes.map(et => ({
            ...et,
            isSelected: formData.visibleEntityTypes.includes(et.id),
            count: entityCounts.get(countKey(et.id)),
        }))
    }, [dsEntityTypes, formData.visibleEntityTypes, entityCounts])

    const edgeTypesWithState = useMemo(() => {
        return dsRelationshipTypes.map(rt => ({
            ...rt,
            isSelected: formData.visibleRelationshipTypes.includes(rt.id),
            count: edgeCounts.get(countKey(rt.id)),
            isContainment: containmentKeys.has(countKey(rt.id)),
        }))
    }, [dsRelationshipTypes, formData.visibleRelationshipTypes, edgeCounts, containmentKeys])

    // Filter the TYPE picker by search only.
    //
    // The advanced filters used to also narrow this grid, which was a fiction:
    // the "tag" filter substring-matched type IDs and the "property" filter just
    // checked whether a field existed. What they actually do is travel with the
    // view as fieldFilters and filter ENTITIES when the view loads — so they no
    // longer pretend to change which types you can select.
    const filteredEntityTypes = useMemo(() => {
        if (!searchQuery) return entityTypesWithState
        const query = searchQuery.toLowerCase()
        return entityTypesWithState.filter(et =>
            et.name.toLowerCase().includes(query) ||
            et.id.toLowerCase().includes(query) ||
            et.pluralName.toLowerCase().includes(query)
        )
    }, [entityTypesWithState, searchQuery])

    // Toggle entity type
    const toggleEntityType = useCallback((typeId: string) => {
        const current = formData.visibleEntityTypes
        const updated = current.includes(typeId)
            ? current.filter(id => id !== typeId)
            : [...current, typeId]
        updateFormData({ visibleEntityTypes: updated })
    }, [formData.visibleEntityTypes, updateFormData])

    // Toggle edge type
    const toggleEdgeType = useCallback((typeId: string) => {
        const current = formData.visibleRelationshipTypes
        const updated = current.includes(typeId)
            ? current.filter(id => id !== typeId)
            : [...current, typeId]
        updateFormData({ visibleRelationshipTypes: updated })
    }, [formData.visibleRelationshipTypes, updateFormData])

    // Select all / none
    const handleSelectAll = useCallback(() => {
        const allIds = dsEntityTypes.map(e => e.id)
        updateFormData({ visibleEntityTypes: allIds })
    }, [dsEntityTypes, updateFormData])

    const handleSelectNone = useCallback(() => {
        updateFormData({ visibleEntityTypes: [] })
    }, [updateFormData])

    // Remove filter
    const removeFilter = useCallback((filterId: string) => {
        updateFormData({
            advancedFilters: formData.advancedFilters.filter(f => f.id !== filterId)
        })
    }, [formData.advancedFilters, updateFormData])

    // Add filter
    const addFilter = useCallback((type: ActiveFilter['type'], label: string, value: any) => {
        const newFilter: ActiveFilter = {
            id: `${type}-${Date.now()}`,
            type,
            label,
            value
        }
        updateFormData({
            advancedFilters: [...formData.advancedFilters, newFilter]
        })
    }, [formData.advancedFilters, updateFormData])

    // Toggle scope edge
    const toggleScopeEdge = useCallback((edgeType: string) => {
        const current = formData.scopeEdges?.edgeTypes ?? []
        const updated = current.includes(edgeType)
            ? current.filter(t => t !== edgeType)
            : [...current, edgeType]

        updateFormData({
            scopeEdges: {
                ...(formData.scopeEdges ?? { includeAll: false }),
                edgeTypes: updated
            }
        })
    }, [formData.scopeEdges, updateFormData])

    // Stats.
    //
    // Count only what THIS ontology actually has. formData can carry ids from a
    // wider/older schema (the store seeds it), which is how "12 selected" ended
    // up next to three edge types. Matching is exact — the same comparison that
    // decides whether a card renders as selected — so the number can never
    // disagree with the checkmarks on screen.
    const availableEntityIds = useMemo(() => new Set(dsEntityTypes.map(et => et.id)), [dsEntityTypes])
    const selectedCount = useMemo(
        () => formData.visibleEntityTypes.filter(id => availableEntityIds.has(id)).length,
        [formData.visibleEntityTypes, availableEntityIds],
    )
    const totalCount = dsEntityTypes.length

    const availableEdgeIds = useMemo(() => new Set(dsRelationshipTypes.map(rt => rt.id)), [dsRelationshipTypes])
    const selectedEdgeCount = useMemo(
        () => formData.visibleRelationshipTypes.filter(id => availableEdgeIds.has(id)).length,
        [formData.visibleRelationshipTypes, availableEdgeIds],
    )

    return (
        <div className="space-y-6">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center"
            >
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                    Select what to include
                </h3>
                <p className="text-slate-500">
                    Choose which entity types and relationships to show in your view
                </p>
            </motion.div>

            {/* Ontology context — the semantic layer these types come from.
                Three tiers: full card (admin), compact schema-derived card
                (non-admin / fetch failed), nothing (no ontology assigned — the
                Scope step already warns about that). */}
            {ontologyId && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.04 }}
                    className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 p-4"
                >
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 text-violet-500 bg-violet-500/10 border-violet-500/20">
                            <Layers className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                Ontology this view is built on
                            </p>
                            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">
                                    {ontology?.name ?? 'Assigned semantic layer'}
                                </h4>
                                {ontology?.isPublished && (
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                        <Check className="w-2.5 h-2.5" /> Published
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                                <div className="flex items-center gap-1 text-xs">
                                    <Box className="w-3 h-3 text-emerald-500" />
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">{dsEntityTypes.length}</span>
                                    <span className="text-slate-400">entity types</span>
                                </div>
                                <div className="flex items-center gap-1 text-xs">
                                    <GitBranch className="w-3 h-3 text-violet-500" />
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">{dsRelationshipTypes.length}</span>
                                    <span className="text-slate-400">relationships</span>
                                </div>
                                <div className="flex items-center gap-1 text-xs">
                                    <ListTree className="w-3 h-3 text-amber-500" />
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">{containmentEdgeTypes.length}</span>
                                    <span className="text-slate-400">containment</span>
                                </div>
                            </div>
                            {ontology?.description && (
                                <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500 line-clamp-2 leading-relaxed">
                                    {ontology.description}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* The numbers above say how MUCH; this says what SHAPE. */}
                    <OntologyHierarchyPreview
                        entityTypes={dsEntityTypes}
                        relationshipTypes={dsRelationshipTypes}
                        containmentEdgeTypes={containmentEdgeTypes}
                        rootEntityTypes={rootEntityTypes}
                        countFor={typeId => entityCounts.get(countKey(typeId))}
                        className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/60"
                    />
                </motion.div>
            )}

            {/* Search and Filter Bar */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="flex items-center gap-3"
            >
                <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search entity types..."
                        className="w-full pl-12 pr-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-colors duration-150 outline-none"
                    />
                </div>
                <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={cn(
                        'flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-colors duration-150',
                        showFilters
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                    )}
                >
                    <Filter className="w-5 h-5" />
                    Data filters
                    {formData.advancedFilters.length > 0 && (
                        <span className="ml-1 px-2 py-0.5 text-xs font-bold bg-blue-600 text-white rounded-full">
                            {formData.advancedFilters.length}
                        </span>
                    )}
                </button>
            </motion.div>

            {/* Advanced Filters Panel */}
            <AnimatePresence>
                {showFilters && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 space-y-4">
                            <div>
                                <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                                    <Sparkles className="w-4 h-4 text-blue-500" />
                                    View data filters
                                </div>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    Applied to entities when the view loads — they don&apos;t change which types you can select below.
                                </p>
                            </div>

                            <div className="grid grid-cols-3 gap-4">
                                {/* Name Filter */}
                                <div>
                                    <label className="text-xs font-medium text-slate-500 uppercase flex items-center gap-1">
                                        <Type className="w-3 h-3" /> Name Contains
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="e.g., finance"
                                        className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                                                const value = (e.target as HTMLInputElement).value
                                                addFilter('name', `Name contains "${value}"`, value)
                                                    ; (e.target as HTMLInputElement).value = ''
                                            }
                                        }}
                                    />
                                </div>

                                {/* Tag Filter */}
                                <div>
                                    <label className="text-xs font-medium text-slate-500 uppercase flex items-center gap-1">
                                        <Tag className="w-3 h-3" /> Has Tag
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="e.g., finance"
                                        className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                                                const value = (e.target as HTMLInputElement).value
                                                addFilter('tag', `Tag: ${value}`, value)
                                                    ; (e.target as HTMLInputElement).value = ''
                                            }
                                        }}
                                    />
                                </div>

                                {/* Property Filter */}
                                <div>
                                    <label className="text-xs font-medium text-slate-500 uppercase flex items-center gap-1">
                                        <Hash className="w-3 h-3" /> Property
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="e.g., status=active"
                                        className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                                                const value = (e.target as HTMLInputElement).value
                                                addFilter('property', value, value)
                                                    ; (e.target as HTMLInputElement).value = ''
                                            }
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Active Filters */}
                            {formData.advancedFilters.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                                    {formData.advancedFilters.map(filter => (
                                        <motion.span
                                            key={filter.id}
                                            initial={{ scale: 0 }}
                                            animate={{ scale: 1 }}
                                            exit={{ scale: 0 }}
                                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm"
                                        >
                                            {filter.type === 'tag' && <Tag className="w-3 h-3" />}
                                            {filter.type === 'name' && <Type className="w-3 h-3" />}
                                            {filter.type === 'property' && <Hash className="w-3 h-3" />}
                                            {filter.label}
                                            <button
                                                onClick={() => removeFilter(filter.id)}
                                                className="ml-1 hover:text-blue-900 dark:hover:text-blue-100"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </motion.span>
                                    ))}
                                    <button
                                        onClick={() => updateFormData({ advancedFilters: [] })}
                                        className="text-xs text-slate-500 hover:text-slate-700"
                                    >
                                        Clear all
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Selection Stats and Actions */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="flex items-center justify-between"
            >
                <div className="flex items-center gap-4">
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                        <span className="font-bold text-blue-600">{selectedCount}</span> of {totalCount} entity types selected
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowScopeConfig(!showScopeConfig)}
                        className={cn(
                            'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-150',
                            showScopeConfig
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                        )}
                    >
                        <ListTree className="w-4 h-4" />
                        Hierarchy Scope
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                        onClick={handleSelectAll}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                        Select All
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                        onClick={handleSelectNone}
                        className="text-sm text-slate-500 hover:text-slate-600 font-medium"
                    >
                        Clear
                    </button>
                </div>
            </motion.div>

            {/* Hierarchy Scope Config */}
            <AnimatePresence>
                {showScopeConfig && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden bg-amber-50 dark:bg-amber-900/10 rounded-xl border border-amber-200 dark:border-amber-900/30 p-4 space-y-3"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 font-semibold">
                                <ListTree className="w-5 h-5" />
                                Hierarchy Definition
                            </div>
                            <div className="text-xs text-amber-600 dark:text-amber-400 max-w-md text-right">
                                Select which edge types define the parent-child relationships in this view.
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            {edgeTypesWithState.map(edge => (
                                <button
                                    key={edge.id}
                                    onClick={() => toggleScopeEdge(edge.id)}
                                    className={cn(
                                        'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors duration-150 flex items-center gap-1.5',
                                        formData.scopeEdges?.edgeTypes.includes(edge.id)
                                            ? 'bg-amber-500 border-amber-600 text-white'
                                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-amber-400'
                                    )}
                                >
                                    {formData.scopeEdges?.edgeTypes.includes(edge.id) && <Check className="w-3 h-3" />}
                                    {edge.name}
                                    {containmentEdgeTypes.includes(edge.id) && (
                                        <Sparkles className="w-3 h-3 text-amber-200" />
                                    )}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Entity Types Grid */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
            >
                {filteredEntityTypes.map((entityType, index) => (
                    <motion.button
                        key={entityType.id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: Math.min(index * 0.01, 0.05) }}
                        onClick={() => toggleEntityType(entityType.id)}
                        className={cn(
                            'relative p-4 rounded-xl border-2 text-left transition-colors duration-150 group',
                            entityType.isSelected
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800'
                        )}
                    >
                        {/* Selection Check */}
                        {entityType.isSelected && (
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                className="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"
                            >
                                <Check className="w-3 h-3 text-white" />
                            </motion.div>
                        )}

                        <div className="flex items-start justify-between mb-2">
                            <div
                                className="w-10 h-10 rounded-lg flex items-center justify-center bg-white dark:bg-slate-700 shadow-sm border border-slate-100 dark:border-slate-600 group-hover:scale-110 transition-transform"
                                style={{ color: entityType.visual.color }}
                            >
                                <Box className="w-5 h-5" />
                            </div>

                            <span
                                className={cn(
                                    'px-2 py-1 rounded-md text-[10px] font-bold tabular-nums',
                                    entityType.count === undefined
                                        ? 'bg-slate-50 dark:bg-slate-800 text-slate-300 dark:text-slate-600'
                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                                )}
                                title={entityType.count === undefined
                                    ? 'No count available for this type'
                                    : `${entityType.count.toLocaleString()} in the graph`}
                            >
                                {entityType.count === undefined ? '—' : entityType.count.toLocaleString()}
                            </span>
                        </div>

                        <p className="font-bold text-sm text-slate-800 dark:text-slate-200 truncate">
                            {entityType.name}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate uppercase tracking-wider font-semibold">
                            {entityType.id}
                        </p>

                        {/* Intelligence: Recommended logic */}
                        {rootEntityTypes.includes(entityType.id) && (
                            <div className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-[9px] font-bold uppercase">
                                <Sparkles className="w-2.5 h-2.5" /> Root
                            </div>
                        )}
                    </motion.button>
                ))}
            </motion.div>

            {filteredEntityTypes.length === 0 && (
                <div className="text-center py-8 text-slate-400">
                    No entity types match your search
                </div>
            )}

            {/* Edge Types Section */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 }}
                className="pt-6 border-t border-slate-200 dark:border-slate-700"
            >
                <button
                    onClick={() => setShowEdgeTypes(!showEdgeTypes)}
                    className="flex items-center gap-2 w-full text-left"
                >
                    {showEdgeTypes ? (
                        <ChevronDown className="w-5 h-5 text-slate-400" />
                    ) : (
                        <ChevronRight className="w-5 h-5 text-slate-400" />
                    )}
                    <GitBranch className="w-5 h-5 text-slate-500" />
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                        Edge Types
                    </span>
                    <span className="text-sm text-slate-400 ml-2">
                        ({selectedEdgeCount} of {dsRelationshipTypes.length} selected)
                    </span>
                </button>

                <AnimatePresence>
                    {showEdgeTypes && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                        >
                            <div className="grid grid-cols-3 gap-2 mt-4">
                                {edgeTypesWithState.map(edgeType => (
                                    <button
                                        key={edgeType.id}
                                        onClick={() => toggleEdgeType(edgeType.id)}
                                        className={cn(
                                            'p-3 rounded-lg border text-left transition-colors duration-150 flex items-center gap-2 group',
                                            edgeType.isSelected
                                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                                        )}
                                    >
                                        <div className={cn(
                                            "w-2 h-2 rounded-full",
                                            edgeType.isSelected ? "bg-blue-500" : "bg-slate-300"
                                        )} />
                                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate flex-1">
                                            {edgeType.name}
                                        </span>
                                        <span
                                            className={cn(
                                                'text-[10px] font-bold tabular-nums shrink-0',
                                                edgeType.count === undefined
                                                    ? 'text-slate-300 dark:text-slate-600'
                                                    : 'text-slate-400 group-hover:text-blue-500',
                                            )}
                                            title={edgeType.count === undefined
                                                ? 'No count available for this edge type'
                                                : `${edgeType.count.toLocaleString()} edges in the graph`}
                                        >
                                            {edgeType.count === undefined ? '—' : edgeType.count.toLocaleString()}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>

            {/* Hint */}
            {selectedCount === 0 && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg"
                >
                    <Info className="w-4 h-4 flex-shrink-0" />
                    Select at least one entity type to continue
                </motion.div>
            )}
        </div>
    )
}

export default EntitiesStep

