/**
 * LayerEditor - Enhanced individual layer configuration
 * 
 * Features:
 * - Scope edge filter configuration (which edges to use for containment)
 * - Instance-level entity picker with search
 * - Inheritance settings toggle
 * - Rule builder with conditions
 */

import React, { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronDown,
    ChevronRight,
    Settings,
    Link,
    Users,
    GitBranch,
    Plus,
    Trash2,
    Search,
    Check,
    AlertCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useInstanceAssignments } from '@/store/referenceModelStore'
import type {
    ViewLayerConfig,
    LayerAssignmentRuleConfig,
    EntityAssignmentConfig
} from '@/types/schema'

// ============================================
// Types
// ============================================

interface LayerEditorProps {
    layer: ViewLayerConfig
    onUpdate: (updates: Partial<ViewLayerConfig>) => void
    onRemove: () => void
    className?: string
}

interface SectionProps {
    title: string
    icon: React.ReactNode
    defaultOpen?: boolean
    children: React.ReactNode
}

// ============================================
// Sub-components
// ============================================

function Section({ title, icon, defaultOpen = false, children }: SectionProps) {
    const [isOpen, setIsOpen] = useState(defaultOpen)

    return (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
                <span className="text-slate-500">{icon}</span>
                <span className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300 text-left">{title}</span>
                {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                )}
            </button>
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="p-4 border-t border-slate-200 dark:border-slate-700">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

interface RuleEditorProps {
    rule: LayerAssignmentRuleConfig
    index: number
    onUpdate: (updates: Partial<LayerAssignmentRuleConfig>) => void
    onRemove: () => void
}

function RuleEditor({ rule, index, onUpdate, onRemove }: RuleEditorProps) {
    return (
        <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                    <span className="w-5 h-5 flex items-center justify-center bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded text-xs font-medium">
                        {index + 1}
                    </span>
                    <input
                        type="text"
                        value={rule.name || ''}
                        onChange={e => onUpdate({ name: e.target.value })}
                        placeholder="Rule name"
                        className="flex-1 bg-transparent border-none text-sm font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1"
                    />
                </div>
                <button
                    onClick={onRemove}
                    className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                >
                    <Trash2 className="w-4 h-4" />
                </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
                {/* URN Pattern */}
                <div>
                    <label className="text-slate-500 block mb-1">URN Pattern</label>
                    <input
                        type="text"
                        value={rule.urnPattern || ''}
                        onChange={e => onUpdate({ urnPattern: e.target.value || undefined })}
                        placeholder="e.g., *:database:*"
                        className="w-full px-2 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
                    />
                </div>

                {/* Priority */}
                <div>
                    <label className="text-slate-500 block mb-1">Priority</label>
                    <input
                        type="number"
                        value={rule.priority}
                        onChange={e => onUpdate({ priority: parseInt(e.target.value) || 1 })}
                        min={1}
                        max={100}
                        className="w-full px-2 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
                    />
                </div>

                {/* Tags */}
                <div className="col-span-2">
                    <label className="text-slate-500 block mb-1">Tags (comma-separated)</label>
                    <input
                        type="text"
                        value={rule.tags?.join(', ') || ''}
                        onChange={e => onUpdate({
                            tags: e.target.value ? e.target.value.split(',').map(s => s.trim()) : undefined
                        })}
                        placeholder="e.g., pii, sensitive"
                        className="w-full px-2 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
                    />
                </div>

                {/* Inheritance Toggle */}
                <div className="col-span-2 flex items-center gap-2">
                    <input
                        type="checkbox"
                        id={`inherit-${rule.id}`}
                        checked={rule.inheritsFromParent !== false}
                        onChange={e => onUpdate({ inheritsFromParent: e.target.checked })}
                        className="rounded"
                    />
                    <label htmlFor={`inherit-${rule.id}`} className="text-slate-600 dark:text-slate-400">
                        Inherit to children
                    </label>
                </div>
            </div>
        </div>
    )
}

// ============================================
// Main Component
// ============================================

export function LayerEditor({
    layer,
    onUpdate,
    onRemove,
    className
}: LayerEditorProps) {
    const schema = useSchemaStore(s => s.schema)
    const instanceAssignments = useInstanceAssignments()

    // Local state for entity search
    const [entitySearch, setEntitySearch] = useState('')

    // Available edge types from schema
    const edgeTypes = useMemo(() =>
        schema?.relationshipTypes.map(r => r.id) ?? [],
        [schema]
    )

    // Entity types from schema
    const entityTypes = useMemo(() =>
        schema?.entityTypes.map(e => e.id) ?? [],
        [schema]
    )

    // Instance assignments for this layer
    const layerAssignments = useMemo(() => {
        const assignments: EntityAssignmentConfig[] = []
        instanceAssignments.forEach((assignment) => {
            if (assignment.layerId === layer.id) {
                assignments.push(assignment)
            }
        })
        return assignments
    }, [instanceAssignments, layer.id])

    // Handlers
    const handleAddRule = useCallback(() => {
        const newRule: LayerAssignmentRuleConfig = {
            id: generateId(),
            name: `Rule ${(layer.rules?.length ?? 0) + 1}`,
            priority: 1,
            inheritsFromParent: true
        }
        onUpdate({ rules: [...(layer.rules || []), newRule] })
    }, [layer.rules, onUpdate])

    const handleUpdateRule = useCallback((ruleId: string, updates: Partial<LayerAssignmentRuleConfig>) => {
        onUpdate({
            rules: layer.rules?.map(r => r.id === ruleId ? { ...r, ...updates } : r)
        })
    }, [layer.rules, onUpdate])

    const handleRemoveRule = useCallback((ruleId: string) => {
        onUpdate({
            rules: layer.rules?.filter(r => r.id !== ruleId)
        })
    }, [layer.rules, onUpdate])

    const handleUpdateScopeEdges = useCallback((edgeType: string, enabled: boolean) => {
        const currentEdges = layer.scopeEdges?.edgeTypes || []
        const updated = enabled
            ? [...new Set([...currentEdges, edgeType])]
            : currentEdges.filter((e: string) => e !== edgeType)

        onUpdate({
            scopeEdges: {
                edgeTypes: updated,
                includeAll: layer.scopeEdges?.includeAll ?? false
            }
        })
    }, [layer.scopeEdges, onUpdate])

    return (
        <div className={cn('space-y-4', className)}>
            {/* Scope Edge Configuration */}
            <Section
                title="Scope Edges (Containment)"
                icon={<Link className="w-4 h-4" />}
                defaultOpen
            >
                <p className="text-xs text-slate-500 mb-3">
                    Select which edge types define the containment hierarchy for this layer.
                </p>
                <div className="flex flex-wrap gap-2">
                    {edgeTypes.map(edgeType => {
                        const isIncluded = layer.scopeEdges?.edgeTypes?.includes(edgeType)
                        return (
                            <button
                                key={edgeType}
                                onClick={() => handleUpdateScopeEdges(edgeType, !isIncluded)}
                                className={cn(
                                    isIncluded
                                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
                                )}
                            >
                                {isIncluded && <Check className="w-3 h-3" />}
                                {edgeType}
                            </button>
                        )
                    })}
                    {edgeTypes.length === 0 && (
                        <p className="text-xs text-slate-400">No edge types defined in schema</p>
                    )}
                </div>
            </Section>

            {/* Instance-Level Assignments */}
            <Section
                title={`Instance Assignments (${layerAssignments.length})`}
                icon={<Users className="w-4 h-4" />}
            >
                <p className="text-xs text-slate-500 mb-3">
                    Directly assign specific entities to this layer (overrides rules).
                </p>

                {/* Search */}
                <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        value={entitySearch}
                        onChange={e => setEntitySearch(e.target.value)}
                        placeholder="Search entities..."
                        className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm"
                    />
                </div>

                {/* Assignment List */}
                {layerAssignments.length > 0 ? (
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                        {layerAssignments.map(assignment => (
                            <div
                                key={assignment.entityId}
                                className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-800 rounded"
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-sm">{assignment.entityId}</span>
                                    {assignment.inheritsChildren && (
                                        <span className="text-2xs px-1 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded">
                                            + children
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-4 text-slate-400">
                        <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p className="text-xs">No instance assignments</p>
                        <p className="text-2xs mt-1">Use the Entity Assignment Panel to add direct assignments</p>
                    </div>
                )}
            </Section>

            {/* Assignment Rules */}
            <Section
                title={`Assignment Rules (${layer.rules?.length ?? 0})`}
                icon={<GitBranch className="w-4 h-4" />}
            >
                <div className="space-y-3">
                    {layer.rules?.map((rule, index) => (
                        <RuleEditor
                            key={rule.id}
                            rule={rule}
                            index={index}
                            onUpdate={(updates) => handleUpdateRule(rule.id, updates)}
                            onRemove={() => handleRemoveRule(rule.id)}
                        />
                    ))}

                    {(layer.rules?.length ?? 0) === 0 && (
                        <div className="text-center py-4 text-slate-400">
                            <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <p className="text-xs">No rules defined</p>
                            <p className="text-2xs mt-1">Add rules or rely on entity type matching</p>
                        </div>
                    )}

                    <button
                        onClick={handleAddRule}
                        className="w-full flex items-center justify-center gap-2 p-2 border border-dashed border-slate-200 dark:border-slate-700 rounded text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                    >
                        <Plus className="w-4 h-4" /> Add Rule
                    </button>
                </div>
            </Section>

            {/* Entity Types (Quick Filter) */}
            <Section
                title="Entity Type Filter"
                icon={<Settings className="w-4 h-4" />}
            >
                <p className="text-xs text-slate-500 mb-3">
                    Entities of these types will be assigned to this layer (lowest priority).
                </p>
                <div className="flex flex-wrap gap-2">
                    {entityTypes.map(type => {
                        const isSelected = layer.entityTypes?.includes(type)
                        return (
                            <button
                                key={type}
                                onClick={() => {
                                    const current = layer.entityTypes || []
                                    const updated = isSelected
                                        ? current.filter(t => t !== type)
                                        : [...current, type]
                                    onUpdate({ entityTypes: updated })
                                }}
                                className={cn(
                                    'px-2 py-1 text-xs rounded-full transition-colors',
                                    isSelected
                                        ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
                                )}
                            >
                                {type}
                            </button>
                        )
                    })}
                </div>
            </Section>

            {/* Danger Zone */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                <button
                    onClick={onRemove}
                    className="text-sm text-red-500 hover:text-red-600 flex items-center gap-2"
                >
                    <Trash2 className="w-4 h-4" /> Delete Layer
                </button>
            </div>
        </div>
    )
}
