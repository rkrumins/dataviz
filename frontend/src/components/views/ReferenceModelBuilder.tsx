/**
 * ReferenceModelBuilder - Full-screen layer builder for Reference Model
 * 
 * Features:
 * - Layer creation wizard with templates
 * - Visual layer ordering with drag-and-drop
 * - Rule builder with AND/OR conditions
 * - Preview mode showing node distribution
 */

import React, { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import {
    X,
    Plus,
    GripVertical,
    Trash2,
    ChevronRight,
    ChevronDown,
    Eye,
    EyeOff,
    Wand2,
    Database,
    Server,
    Layers,
    BarChart3,
    FileText,
    Settings,
    Network,
    LayoutTemplate
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import {
    useReferenceModelStore,
    useLayers
} from '@/store/referenceModelStore'
import type { ViewLayerConfig, LayerAssignmentRuleConfig } from '@/types/schema'
import { LayerDropZone } from './LayerDropZone'
import { EntityAssignmentPanel } from './EntityAssignmentPanel'

// ============================================
// Types
// ============================================

interface ReferenceModelBuilderProps {
    isOpen: boolean
    onClose: () => void
    onSave?: (layers: ViewLayerConfig[]) => void
}

interface LayerTemplate {
    id: string
    name: string
    description: string
    icon: React.ReactNode
    layers: Omit<ViewLayerConfig, 'id' | 'order'>[]
}

// ============================================
// Constants
// ============================================

const LAYER_TEMPLATES: LayerTemplate[] = [
    {
        id: 'data-flow',
        name: 'Data Flow (4 Layers)',
        description: 'Source → Staging → Transform → Consumption',
        icon: <Network className="w-5 h-5" />,
        layers: [
            { name: 'Source', description: 'Raw data sources', icon: 'Database', color: '#3b82f6', entityTypes: ['database', 'file'] },
            { name: 'Staging', description: 'Intermediate storage', icon: 'Server', color: '#8b5cf6', entityTypes: ['schema', 'table'] },
            { name: 'Transform', description: 'Processing layer', icon: 'Layers', color: '#f59e0b', entityTypes: ['table', 'view'] },
            { name: 'Consumption', description: 'Analytics and reports', icon: 'BarChart3', color: '#22c55e', entityTypes: ['dashboard', 'report'] }
        ]
    },
    {
        id: 'medallion',
        name: 'Medallion (3 Layers)',
        description: 'Bronze → Silver → Gold architecture',
        icon: <Layers className="w-5 h-5" />,
        layers: [
            { name: 'Bronze', description: 'Raw data ingestion', icon: 'Database', color: '#CD7F32', entityTypes: ['database', 'file', 'table'] },
            { name: 'Silver', description: 'Cleansed and conformed', icon: 'FileText', color: '#C0C0C0', entityTypes: ['schema', 'table'] },
            { name: 'Gold', description: 'Business-ready', icon: 'BarChart3', color: '#FFD700', entityTypes: ['view', 'dashboard', 'report'] }
        ]
    },
    {
        id: 'simple',
        name: 'Simple (2 Layers)',
        description: 'Input → Output',
        icon: <LayoutTemplate className="w-5 h-5" />,
        layers: [
            { name: 'Input', description: 'Source systems', icon: 'Database', color: '#3b82f6', entityTypes: ['database', 'schema'] },
            { name: 'Output', description: 'Target systems', icon: 'BarChart3', color: '#22c55e', entityTypes: ['dashboard', 'report'] }
        ]
    },
    {
        id: 'custom',
        name: 'Start Empty',
        description: 'Build your own layer structure',
        icon: <Plus className="w-5 h-5" />,
        layers: []
    }
]

const LAYER_COLORS = [
    '#3b82f6', // Blue
    '#8b5cf6', // Purple
    '#f59e0b', // Amber
    '#22c55e', // Green
    '#ef4444', // Red
    '#06b6d4', // Cyan
    '#ec4899', // Pink
    '#6366f1', // Indigo
]

const LAYER_ICONS = [
    { name: 'Database', icon: Database },
    { name: 'Server', icon: Server },
    { name: 'Layers', icon: Layers },
    { name: 'BarChart3', icon: BarChart3 },
    { name: 'FileText', icon: FileText },
    { name: 'Network', icon: Network },
]

// ============================================
// Sub-components
// ============================================

interface LayerCardProps {
    layer: ViewLayerConfig
    index: number
    isExpanded: boolean
    entityTypes: string[]
    onToggle: () => void
    onUpdate: (updates: Partial<ViewLayerConfig>) => void
    onRemove: () => void
    onAddRule: () => void
    assignedCount?: number
}

function LayerCard({
    layer,
    index,
    isExpanded,
    entityTypes,
    onToggle,
    onUpdate,
    onRemove,
    onAddRule,
    assignedCount = 0
}: LayerCardProps) {
    return (
        <Reorder.Item
            value={layer}
            id={layer.id}
            className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm"
        >
            {/* Header */}
            <div
                className="flex items-center gap-3 p-4 cursor-pointer"
                onClick={onToggle}
            >
                <GripVertical className="w-5 h-5 text-slate-400 cursor-grab" />

                <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-white"
                    style={{ backgroundColor: layer.color }}
                >
                    <span className="text-sm font-bold">{index + 1}</span>
                </div>

                <div className="flex-1 min-w-0">
                    <input
                        type="text"
                        value={layer.name}
                        onChange={(e) => onUpdate({ name: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        className="text-lg font-semibold bg-transparent border-none focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1 -ml-1 w-full"
                    />
                    <p className="text-sm text-slate-500 truncate">{layer.description || 'No description'}</p>
                </div>

                <span className="px-2 py-1 text-xs bg-slate-100 dark:bg-slate-700 rounded-full text-slate-600 dark:text-slate-300">
                    {assignedCount} entities
                </span>

                {isExpanded ? (
                    <ChevronDown className="w-5 h-5 text-slate-400" />
                ) : (
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                )}
            </div>

            {/* Expanded Content */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700 pt-4">
                            {/* Description */}
                            <div>
                                <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Description</label>
                                <input
                                    type="text"
                                    value={layer.description || ''}
                                    onChange={(e) => onUpdate({ description: e.target.value })}
                                    placeholder="Add a description..."
                                    className="mt-1 w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm"
                                />
                            </div>

                            {/* Color & Icon */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Color</label>
                                    <div className="flex gap-2 mt-1">
                                        {LAYER_COLORS.map(color => (
                                            <button
                                                key={color}
                                                onClick={() => onUpdate({ color })}
                                                className={cn(
                                                    'w-7 h-7 rounded-full transition-transform',
                                                    layer.color === color && 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                                                )}
                                                style={{ backgroundColor: color }}
                                            />
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Icon</label>
                                    <div className="flex gap-2 mt-1">
                                        {LAYER_ICONS.map(({ name, icon: Icon }) => (
                                            <button
                                                key={name}
                                                onClick={() => onUpdate({ icon: name })}
                                                className={cn(
                                                    'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
                                                    layer.icon === name
                                                        ? 'bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400'
                                                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
                                                )}
                                            >
                                                <Icon className="w-4 h-4" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Entity Types */}
                            <div>
                                <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Entity Types</label>
                                <div className="flex flex-wrap gap-2 mt-1">
                                    {entityTypes.map(type => (
                                        <button
                                            key={type}
                                            onClick={() => {
                                                const current = layer.entityTypes || []
                                                const updated = current.includes(type)
                                                    ? current.filter(t => t !== type)
                                                    : [...current, type]
                                                onUpdate({ entityTypes: updated })
                                            }}
                                            className={cn(
                                                'px-2 py-1 text-xs rounded-full transition-colors',
                                                layer.entityTypes?.includes(type)
                                                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                                                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
                                            )}
                                        >
                                            {type}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Rules Summary */}
                            <div>
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Assignment Rules</label>
                                    <button
                                        onClick={onAddRule}
                                        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                    >
                                        <Plus className="w-3 h-3" /> Add Rule
                                    </button>
                                </div>
                                <div className="mt-1 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                                    {(layer.rules?.length ?? 0) === 0 ? (
                                        <p className="text-xs text-slate-400">No rules defined. Using entity type matching.</p>
                                    ) : (
                                        <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                                            {layer.rules?.slice(0, 3).map((rule, i) => (
                                                <li key={i} className="flex items-center gap-2">
                                                    <span className="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-2xs">
                                                        {i + 1}
                                                    </span>
                                                    {rule.name || rule.urnPattern || 'Unnamed rule'}
                                                </li>
                                            ))}
                                            {(layer.rules?.length ?? 0) > 3 && (
                                                <li className="text-slate-400">+{layer.rules!.length - 3} more...</li>
                                            )}
                                        </ul>
                                    )}
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-700">
                                <button
                                    onClick={onRemove}
                                    className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1"
                                >
                                    <Trash2 className="w-3 h-3" /> Remove Layer
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </Reorder.Item>
    )
}

// ============================================
// Main Component
// ============================================

export function ReferenceModelBuilder({
    isOpen,
    onClose,
    onSave
}: ReferenceModelBuilderProps) {
    // Store hooks
    const schema = useSchemaStore(s => s.schema)
    const storeLayers = useLayers()
    const setLayers = useReferenceModelStore(s => s.setLayers)

    // Local state
    const [layers, setLocalLayers] = useState<ViewLayerConfig[]>(() => [...storeLayers])
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null)
    const [showPreview, setShowPreview] = useState(false)
    const [showEntityPanel, setShowEntityPanel] = useState(false)
    const [showTemplateWizard, setShowTemplateWizard] = useState(storeLayers.length === 0)

    // Entity types from schema
    const entityTypes = useMemo(() =>
        schema?.entityTypes.map(e => e.id) ?? [],
        [schema]
    )

    // Handlers
    const handleApplyTemplate = useCallback((template: LayerTemplate) => {
        const newLayers: ViewLayerConfig[] = template.layers.map((l, i) => ({
            ...l,
            id: generateId(),
            order: i
        }))
        setLocalLayers(newLayers)
        setShowTemplateWizard(false)
    }, [])

    const handleAddLayer = useCallback(() => {
        const newLayer: ViewLayerConfig = {
            id: generateId(),
            name: `Layer ${layers.length + 1}`,
            description: '',
            icon: 'Layers',
            color: LAYER_COLORS[layers.length % LAYER_COLORS.length],
            entityTypes: [],
            order: layers.length
        }
        setLocalLayers([...layers, newLayer])
        setExpandedLayerId(newLayer.id)
    }, [layers])

    const handleUpdateLayer = useCallback((id: string, updates: Partial<ViewLayerConfig>) => {
        setLocalLayers(prev => prev.map(l =>
            l.id === id ? { ...l, ...updates } : l
        ))
    }, [])

    const handleRemoveLayer = useCallback((id: string) => {
        setLocalLayers(prev => prev.filter(l => l.id !== id))
        if (expandedLayerId === id) {
            setExpandedLayerId(null)
        }
    }, [expandedLayerId])

    const handleReorder = useCallback((reordered: ViewLayerConfig[]) => {
        setLocalLayers(reordered.map((l, i) => ({ ...l, order: i })))
    }, [])

    const handleAddRule = useCallback((layerId: string) => {
        const newRule: LayerAssignmentRuleConfig = {
            id: generateId(),
            name: 'New Rule',
            priority: 1,
            inheritsFromParent: true
        }
        setLocalLayers(prev => prev.map(l =>
            l.id === layerId
                ? { ...l, rules: [...(l.rules || []), newRule] }
                : l
        ))
    }, [])

    const handleSave = useCallback(() => {
        setLayers(layers)
        onSave?.(layers)
        onClose()
    }, [layers, setLayers, onSave, onClose])

    if (!isOpen) return null

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                            <LayoutTemplate className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Reference Model Builder</h2>
                            <p className="text-sm text-slate-500">Configure layers for your data architecture</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowPreview(!showPreview)}
                            className={cn(
                                'p-2 rounded-lg transition-colors',
                                showPreview
                                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-600'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600'
                            )}
                            title={showPreview ? 'Hide Preview' : 'Show Preview'}
                        >
                            {showPreview ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
                        >
                            <X className="w-5 h-5 text-slate-500" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden flex">
                    {/* Layer List */}
                    <div className={cn(
                        'flex-1 overflow-y-auto p-6 transition-all',
                        showPreview && 'max-w-[50%]'
                    )}>
                        {/* Template Wizard */}
                        <AnimatePresence>
                            {showTemplateWizard && (
                                <motion.div
                                    initial={{ opacity: 0, y: -20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -20 }}
                                    className="mb-6 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-200 dark:border-blue-800"
                                >
                                    <div className="flex items-center gap-2 mb-3">
                                        <Wand2 className="w-5 h-5 text-blue-600" />
                                        <h3 className="font-semibold text-slate-800 dark:text-slate-200">Quick Start Templates</h3>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {LAYER_TEMPLATES.map(template => (
                                            <button
                                                key={template.id}
                                                onClick={() => handleApplyTemplate(template)}
                                                className="flex items-start gap-3 p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 transition-colors text-left"
                                            >
                                                <span className="p-2 bg-slate-100 dark:bg-slate-700 rounded-lg text-slate-600 dark:text-slate-400">
                                                    {template.icon}
                                                </span>
                                                <div>
                                                    <p className="font-medium text-slate-800 dark:text-slate-200">{template.name}</p>
                                                    <p className="text-xs text-slate-500">{template.description}</p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Layer Cards */}
                        {layers.length === 0 ? (
                            <div className="text-center py-12">
                                <Layers className="w-16 h-16 mx-auto mb-4 text-slate-300" />
                                <p className="text-slate-500 mb-4">No layers defined yet</p>
                                <button
                                    onClick={() => setShowTemplateWizard(true)}
                                    className="btn btn-primary btn-md"
                                >
                                    <Wand2 className="w-4 h-4" /> Choose a Template
                                </button>
                            </div>
                        ) : (
                            <Reorder.Group
                                axis="y"
                                values={layers}
                                onReorder={handleReorder}
                                className="space-y-3"
                            >
                                {layers.map((layer, index) => (
                                    <LayerCard
                                        key={layer.id}
                                        layer={layer}
                                        index={index}
                                        isExpanded={expandedLayerId === layer.id}
                                        entityTypes={entityTypes}
                                        onToggle={() => setExpandedLayerId(
                                            expandedLayerId === layer.id ? null : layer.id
                                        )}
                                        onUpdate={(updates) => handleUpdateLayer(layer.id, updates)}
                                        onRemove={() => handleRemoveLayer(layer.id)}
                                        onAddRule={() => handleAddRule(layer.id)}
                                    />
                                ))}
                            </Reorder.Group>
                        )}

                        {/* Add Layer Button */}
                        {layers.length > 0 && (
                            <button
                                onClick={handleAddLayer}
                                className="mt-4 w-full flex items-center justify-center gap-2 p-3 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
                            >
                                <Plus className="w-5 h-5" /> Add Layer
                            </button>
                        )}
                    </div>

                    {/* Preview Panel */}
                    <AnimatePresence>
                        {showPreview && (
                            <motion.div
                                initial={{ width: 0, opacity: 0 }}
                                animate={{ width: '50%', opacity: 1 }}
                                exit={{ width: 0, opacity: 0 }}
                                className="border-l border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 overflow-hidden"
                            >
                                <div className="p-6 h-full overflow-y-auto">
                                    <h3 className="font-semibold text-slate-800 dark:text-slate-200 mb-4">Layer Preview</h3>
                                    <div className="space-y-3">
                                        {layers.map((layer) => (
                                            <LayerDropZone
                                                key={layer.id}
                                                layer={layer}
                                                showEntityCount
                                                entityCount={0}
                                            />
                                        ))}
                                    </div>
                                    {layers.length === 0 && (
                                        <p className="text-sm text-slate-400 text-center py-8">
                                            Add layers to see preview
                                        </p>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    <button
                        onClick={() => setShowEntityPanel(true)}
                        className="btn btn-secondary btn-md"
                    >
                        <Settings className="w-4 h-4" /> Assign Entities
                    </button>
                    <div className="flex gap-3">
                        <button onClick={onClose} className="btn btn-secondary btn-md">
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            className="btn btn-primary btn-md"
                            disabled={layers.length === 0}
                        >
                            Save Configuration
                        </button>
                    </div>
                </div>
            </motion.div>

            {/* Entity Assignment Panel */}
            <EntityAssignmentPanel
                isOpen={showEntityPanel}
                onClose={() => setShowEntityPanel(false)}
            />
        </motion.div>
    )
}
