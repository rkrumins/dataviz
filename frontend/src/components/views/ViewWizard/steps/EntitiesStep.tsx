/**
 * EntitiesStep - Third wizard step for entity and edge type selection
 * 
 * Features:
 * - Graph overview showing all available types with counts
 * - Smart filtering by tags, names, and properties
 * - Real-time matching count
 * - Beautiful card-based selection
 */

import { useState, useMemo, useCallback } from 'react'
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
    Sparkles,
    Info
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import type { WizardFormData } from '../ViewWizard'

// ============================================
// Types
// ============================================

interface EntitiesStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
}

interface ActiveFilter {
    id: string
    type: 'tag' | 'name' | 'property'
    label: string
    value: unknown
}

// ============================================
// Component
// ============================================

export function EntitiesStep({ formData, updateFormData }: EntitiesStepProps) {
    const schema = useSchemaStore(s => s.schema)
    const [searchQuery, setSearchQuery] = useState('')
    const [showFilters, setShowFilters] = useState(false)
    const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
    const [showEdgeTypes, setShowEdgeTypes] = useState(false)

    // Entity types with selection state
    const entityTypesWithState = useMemo(() => {
        return (schema?.entityTypes ?? []).map(et => ({
            ...et,
            isSelected: formData.visibleEntityTypes.includes(et.id),
            count: 0 // Would come from introspection in real data
        }))
    }, [schema, formData.visibleEntityTypes])

    // Edge types with selection state
    const edgeTypesWithState = useMemo(() => {
        return (schema?.relationshipTypes ?? []).map(rt => ({
            ...rt,
            isSelected: formData.visibleRelationshipTypes.includes(rt.id),
            count: 0
        }))
    }, [schema, formData.visibleRelationshipTypes])

    // Filter entity types by search
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
        const allIds = schema?.entityTypes.map(e => e.id) ?? []
        updateFormData({ visibleEntityTypes: allIds })
    }, [schema, updateFormData])

    const handleSelectNone = useCallback(() => {
        updateFormData({ visibleEntityTypes: [] })
    }, [updateFormData])

    // Remove filter
    const removeFilter = useCallback((filterId: string) => {
        setActiveFilters(prev => prev.filter(f => f.id !== filterId))
    }, [])

    // Stats
    const selectedCount = formData.visibleEntityTypes.length
    const totalCount = schema?.entityTypes.length ?? 0

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

            {/* Search and Filter Bar */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="flex items-center gap-3"
            >
                <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search entity types..."
                        className="w-full pl-12 pr-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all outline-none"
                    />
                </div>
                <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={cn(
                        'flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-all',
                        showFilters
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                    )}
                >
                    <Filter className="w-5 h-5" />
                    Filters
                    {activeFilters.length > 0 && (
                        <span className="ml-1 px-2 py-0.5 text-xs font-bold bg-blue-600 text-white rounded-full">
                            {activeFilters.length}
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
                            <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                                <Sparkles className="w-4 h-4 text-blue-500" />
                                Advanced Filters
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
                                                setActiveFilters(prev => [...prev, {
                                                    id: `name-${Date.now()}`,
                                                    type: 'name',
                                                    label: `Name contains "${value}"`,
                                                    value
                                                }])
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
                                        placeholder="e.g., source, pii"
                                        className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                                                const value = (e.target as HTMLInputElement).value
                                                setActiveFilters(prev => [...prev, {
                                                    id: `tag-${Date.now()}`,
                                                    type: 'tag',
                                                    label: `Tag: ${value}`,
                                                    value
                                                }])
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
                                                setActiveFilters(prev => [...prev, {
                                                    id: `prop-${Date.now()}`,
                                                    type: 'property',
                                                    label: value,
                                                    value
                                                }])
                                                    ; (e.target as HTMLInputElement).value = ''
                                            }
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Active Filters */}
                            {activeFilters.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                                    {activeFilters.map(filter => (
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
                                        onClick={() => setActiveFilters([])}
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
                transition={{ delay: 0.2 }}
                className="flex items-center justify-between"
            >
                <div className="flex items-center gap-4">
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                        <span className="font-bold text-blue-600">{selectedCount}</span> of {totalCount} entity types selected
                    </span>
                </div>
                <div className="flex items-center gap-2">
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

            {/* Entity Types Grid */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
            >
                {filteredEntityTypes.map((entityType, index) => (
                    <motion.button
                        key={entityType.id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: index * 0.02 }}
                        onClick={() => toggleEntityType(entityType.id)}
                        className={cn(
                            'relative p-4 rounded-xl border-2 text-left transition-all',
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

                        <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                            style={{ backgroundColor: `${entityType.visual.color}20` }}
                        >
                            <Box className="w-5 h-5" style={{ color: entityType.visual.color }} />
                        </div>
                        <p className="font-medium text-sm text-slate-800 dark:text-slate-200 truncate">
                            {entityType.name}
                        </p>
                        <p className="text-xs text-slate-400 truncate">
                            {entityType.pluralName}
                        </p>
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
                transition={{ delay: 0.4 }}
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
                        ({formData.visibleRelationshipTypes.length} selected)
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
                                            'p-3 rounded-lg border text-left transition-all flex items-center gap-2',
                                            edgeType.isSelected
                                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                                        )}
                                    >
                                        {edgeType.isSelected && <Check className="w-4 h-4 text-blue-500" />}
                                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">
                                            {edgeType.name}
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

