/**
 * EnhancedLayerCard - Modern layer card with inline editing
 * 
 * Features:
 * - Color/icon picker with visual preview
 * - Drag handle for reordering
 * - Inline expandable configuration
 * - Quick entity type chips
 * - Rule count badge
 */

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    GripVertical,
    ChevronDown,
    ChevronRight,
    Palette,
    Trash2,
    Copy,
    Box,
    GitBranch,
    Check,
    Plus,
    X
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import type { ViewLayerConfig, LayerAssignmentRuleConfig } from '@/types/schema'
import type { SmartRule } from './SmartRuleBuilder'

// ============================================
// Types
// ============================================

interface EnhancedLayerCardProps {
    layer: ViewLayerConfig
    index: number
    onUpdate: (updates: Partial<ViewLayerConfig>) => void
    onRemove: () => void
    onDuplicate?: () => void
    isDragging?: boolean
    dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
    className?: string
}

// ============================================
// Constants
// ============================================

const LAYER_COLORS = [
    { name: 'blue', value: '#3B82F6', dark: '#1D4ED8' },
    { name: 'purple', value: '#8B5CF6', dark: '#6D28D9' },
    { name: 'pink', value: '#EC4899', dark: '#BE185D' },
    { name: 'red', value: '#EF4444', dark: '#B91C1C' },
    { name: 'orange', value: '#F97316', dark: '#C2410C' },
    { name: 'yellow', value: '#EAB308', dark: '#A16207' },
    { name: 'green', value: '#22C55E', dark: '#15803D' },
    { name: 'teal', value: '#14B8A6', dark: '#0F766E' },
    { name: 'cyan', value: '#06B6D4', dark: '#0E7490' },
    { name: 'slate', value: '#64748B', dark: '#475569' },
]

// ============================================
// Sub-Components
// ============================================

interface ColorPickerProps {
    value: string
    onChange: (color: string) => void
    onClose: () => void
}

function ColorPicker({ value, onChange, onClose }: ColorPickerProps) {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute top-full left-0 mt-2 p-2 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-50"
        >
            <div className="grid grid-cols-5 gap-1">
                {LAYER_COLORS.map(color => (
                    <button
                        key={color.name}
                        onClick={() => {
                            onChange(color.value)
                            onClose()
                        }}
                        className={cn(
                            'w-8 h-8 rounded-lg transition-transform hover:scale-110',
                            value === color.value && 'ring-2 ring-offset-2 ring-blue-500'
                        )}
                        style={{ backgroundColor: color.value }}
                    >
                        {value === color.value && (
                            <Check className="w-4 h-4 text-white mx-auto" />
                        )}
                    </button>
                ))}
            </div>
        </motion.div>
    )
}

interface EntityTypeChipsProps {
    selectedTypes: string[]
    availableTypes: string[]
    onChange: (types: string[]) => void
}

function EntityTypeChips({ selectedTypes, availableTypes, onChange }: EntityTypeChipsProps) {
    const [isExpanded, setIsExpanded] = useState(false)

    const toggleType = useCallback((type: string) => {
        if (selectedTypes.includes(type)) {
            onChange(selectedTypes.filter(t => t !== type))
        } else {
            onChange([...selectedTypes, type])
        }
    }, [selectedTypes, onChange])

    return (
        <div className="space-y-2">
            {/* Selected Types */}
            <div className="flex flex-wrap gap-1.5">
                {selectedTypes.map(type => (
                    <motion.span
                        key={type}
                        layout
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0 }}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-xs"
                    >
                        <Box className="w-3 h-3" />
                        {type}
                        <button
                            onClick={() => toggleType(type)}
                            className="ml-0.5 hover:text-red-500"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </motion.span>
                ))}
                {selectedTypes.length === 0 && (
                    <span className="text-xs text-slate-400">No entity types selected</span>
                )}
            </div>

            {/* Expand Toggle */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {isExpanded ? 'Hide types' : 'Add types'}
            </button>

            {/* Available Types */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-200 dark:border-slate-700">
                            {availableTypes.filter(t => !selectedTypes.includes(t)).map(type => (
                                <button
                                    key={type}
                                    onClick={() => toggleType(type)}
                                    className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-full text-xs hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                                >
                                    <Plus className="w-3 h-3" />
                                    {type}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ============================================
// Main Component
// ============================================

export function EnhancedLayerCard({
    layer,
    index,
    onUpdate,
    onRemove,
    onDuplicate,
    isDragging,
    dragHandleProps,
    className
}: EnhancedLayerCardProps) {
    const [isExpanded, setIsExpanded] = useState(false)
    const [showColorPicker, setShowColorPicker] = useState(false)
    const [activeTab, setActiveTab] = useState<'types' | 'rules'>('types')

    const schema = useSchemaStore(s => s.schema)
    const entityTypes = useMemo(() =>
        schema?.entityTypes.map(e => e.id) ?? [],
        [schema]
    )

    // Convert legacy rules to SmartRules for display
    const smartRules: SmartRule[] = useMemo(() => {
        return (layer.rules || []).map(rule => ({
            id: rule.id,
            name: rule.name || 'Untitled Rule',
            groups: [{
                id: generateId(),
                logic: 'AND' as const,
                conditions: [
                    ...(rule.entityTypes?.map(type => ({
                        id: generateId(),
                        field: 'type' as const,
                        operator: 'equals' as const,
                        value: type
                    })) || []),
                    ...(rule.urnPattern ? [{
                        id: generateId(),
                        field: 'urn' as const,
                        operator: 'matches' as const,
                        value: rule.urnPattern
                    }] : []),
                    ...(rule.tags?.map(tag => ({
                        id: generateId(),
                        field: 'tag' as const,
                        operator: 'equals' as const,
                        value: tag
                    })) || [])
                ]
            }],
            groupLogic: 'AND' as const,
            priority: rule.priority,
            inheritsChildren: rule.inheritsFromParent !== false,
            isEnabled: true
        }))
    }, [layer.rules])

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

    const handleRemoveRule = useCallback((ruleId: string) => {
        onUpdate({ rules: layer.rules?.filter(r => r.id !== ruleId) })
    }, [layer.rules, onUpdate])

    const layerColor = layer.color || LAYER_COLORS[index % LAYER_COLORS.length].value

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: -100 }}
            className={cn(
                'relative bg-white dark:bg-slate-900 rounded-xl border-2 overflow-hidden',
                isDragging
                    ? 'border-blue-500 shadow-xl ring-4 ring-blue-500/20'
                    : 'border-slate-200 dark:border-slate-700',
                className
            )}
        >
            {/* Color Strip */}
            <div
                className="absolute left-0 top-0 bottom-0 w-1.5"
                style={{ backgroundColor: layerColor }}
            />

            {/* Header */}
            <div className="flex items-center gap-3 p-4 pl-5">
                {/* Drag Handle */}
                <div
                    {...dragHandleProps}
                    className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
                >
                    <GripVertical className="w-5 h-5" />
                </div>

                {/* Color Button */}
                <div className="relative">
                    <button
                        onClick={() => setShowColorPicker(!showColorPicker)}
                        className="w-8 h-8 rounded-lg shadow-sm hover:scale-105 transition-transform"
                        style={{ backgroundColor: layerColor }}
                    >
                        <Palette className="w-4 h-4 text-white/70 mx-auto" />
                    </button>
                    <AnimatePresence>
                        {showColorPicker && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={() => setShowColorPicker(false)}
                                />
                                <ColorPicker
                                    value={layerColor}
                                    onChange={color => onUpdate({ color })}
                                    onClose={() => setShowColorPicker(false)}
                                />
                            </>
                        )}
                    </AnimatePresence>
                </div>

                {/* Name Input */}
                <input
                    type="text"
                    value={layer.name}
                    onChange={e => onUpdate({ name: e.target.value })}
                    placeholder="Layer name"
                    className="flex-1 text-base font-semibold bg-transparent border-none outline-none focus:ring-1 focus:ring-blue-500 rounded px-2 -mx-2"
                />

                {/* Badges */}
                <div className="flex items-center gap-2">
                    {(layer.entityTypes?.length ?? 0) > 0 && (
                        <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full text-xs">
                            <Box className="w-3 h-3" />
                            {layer.entityTypes?.length}
                        </span>
                    )}
                    {(layer.rules?.length ?? 0) > 0 && (
                        <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-full text-xs">
                            <GitBranch className="w-3 h-3" />
                            {layer.rules?.length}
                        </span>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                    {onDuplicate && (
                        <button
                            onClick={onDuplicate}
                            className="p-1.5 text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                            title="Duplicate layer"
                        >
                            <Copy className="w-4 h-4" />
                        </button>
                    )}
                    <button
                        onClick={onRemove}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                        title="Delete layer"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
                    >
                        <ChevronDown className={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-180')} />
                    </button>
                </div>
            </div>

            {/* Expandable Content */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                    >
                        <div className="px-5 pb-4 pt-0">
                            {/* Description */}
                            <input
                                type="text"
                                value={layer.description || ''}
                                onChange={e => onUpdate({ description: e.target.value })}
                                placeholder="Add layer description..."
                                className="w-full mb-4 text-sm text-slate-500 bg-transparent border-none outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 -mx-1"
                            />

                            {/* Tabs */}
                            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-4">
                                <button
                                    onClick={() => setActiveTab('types')}
                                    className={cn(
                                        'flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                                        activeTab === 'types'
                                            ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm'
                                            : 'text-slate-500 hover:text-slate-700'
                                    )}
                                >
                                    <Box className="w-4 h-4" />
                                    Entity Types
                                </button>
                                <button
                                    onClick={() => setActiveTab('rules')}
                                    className={cn(
                                        'flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                                        activeTab === 'rules'
                                            ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm'
                                            : 'text-slate-500 hover:text-slate-700'
                                    )}
                                >
                                    <GitBranch className="w-4 h-4" />
                                    Rules ({layer.rules?.length ?? 0})
                                </button>
                            </div>

                            {/* Tab Content */}
                            {activeTab === 'types' && (
                                <div className="space-y-3">
                                    <p className="text-xs text-slate-500">
                                        Entities of these types will be assigned to this layer.
                                    </p>
                                    <EntityTypeChips
                                        selectedTypes={layer.entityTypes || []}
                                        availableTypes={entityTypes}
                                        onChange={types => onUpdate({ entityTypes: types })}
                                    />
                                </div>
                            )}

                            {activeTab === 'rules' && (
                                <div className="space-y-4">
                                    <p className="text-xs text-slate-500">
                                        Rules provide fine-grained control over entity assignment using conditions.
                                    </p>

                                    {smartRules.length === 0 ? (
                                        <div className="text-center py-6 text-slate-400">
                                            <GitBranch className="w-10 h-10 mx-auto mb-2 opacity-50" />
                                            <p className="text-sm">No rules defined</p>
                                            <p className="text-xs mt-1">Add rules for advanced entity matching</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            {smartRules.map(rule => (
                                                <div
                                                    key={rule.id}
                                                    className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700"
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-medium text-sm">{rule.name}</span>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs text-slate-400">
                                                                Priority: {rule.priority}
                                                            </span>
                                                            <button
                                                                onClick={() => handleRemoveRule(rule.id)}
                                                                className="p-1 text-slate-400 hover:text-red-500"
                                                            >
                                                                <Trash2 className="w-3 h-3" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                    {rule.groups[0]?.conditions.length > 0 && (
                                                        <div className="mt-2 text-xs text-slate-500">
                                                            {rule.groups[0].conditions.map((c, i) => (
                                                                <span key={c.id}>
                                                                    {i > 0 && <span className="text-blue-500 font-medium"> AND </span>}
                                                                    {c.field} {c.operator} "{c.value}"
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    <button
                                        onClick={handleAddRule}
                                        className="w-full flex items-center justify-center gap-2 p-3 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                                    >
                                        <Plus className="w-4 h-4" /> Add Rule
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

export default EnhancedLayerCard
