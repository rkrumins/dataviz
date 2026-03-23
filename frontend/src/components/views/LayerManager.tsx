/**
 * LayerManager - Orchestrates layer cards with drag-drop reordering
 * 
 * Features:
 * - Drag-and-drop layer reordering using framer-motion Reorder
 * - Add new layers with templates
 * - Layer presets (Data Flow, Medallion, etc.)
 * - Integrated with view configuration
 */

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import {
    Plus,
    Sparkles,
    ChevronDown,
    Database,
    Layers,
    GitBranch,
    Building
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import type { ViewLayerConfig, EntityAssignmentConfig } from '@/types/schema'
import { EnhancedLayerCard } from './EnhancedLayerCard'
import { AssignmentLayerCard } from './AssignmentLayerCard'

// ============================================
// Types
// ============================================

interface LayerManagerProps {
    layers: ViewLayerConfig[]
    onUpdate: (layers: ViewLayerConfig[]) => void
    onBulkAssign?: (layerId: string, entityIds: string[]) => void
    className?: string
    mode?: 'config' | 'assignment'
}

interface ReorderableLayerCardProps {
    layer: ViewLayerConfig
    index: number
    onUpdate: (updates: Partial<ViewLayerConfig>) => void
    onRemove: () => void
    onDuplicate: () => void
}

// ============================================
// Reorderable Wrapper Component
// ============================================

function ReorderableLayerCard({ layer, index, onUpdate, onRemove, onDuplicate }: ReorderableLayerCardProps) {
    const dragControls = useDragControls()

    return (
        <Reorder.Item
            value={layer.id}
            dragListener={false}
            dragControls={dragControls}
            className="list-none"
        >
            <EnhancedLayerCard
                layer={layer}
                index={index}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onDuplicate={onDuplicate}
                dragHandleProps={{
                    onPointerDown: (e) => dragControls.start(e)
                }}
            />
        </Reorder.Item>
    )
}

// ============================================
// Constants
// ============================================

const LAYER_TEMPLATES: {
    name: string
    description: string
    icon: React.ReactNode
    layers: Partial<ViewLayerConfig>[]
}[] = [
        {
            name: 'Data Flow',
            description: '4-tier data processing pipeline',
            icon: <GitBranch className="w-5 h-5" />,
            layers: [
                { name: 'Sources', description: 'Raw data sources and ingestion', color: '#3B82F6' },
                { name: 'Transform', description: 'Data processing and transformation', color: '#8B5CF6' },
                { name: 'Curated', description: 'Cleaned and validated datasets', color: '#22C55E' },
                { name: 'Consume', description: 'Analytics and reporting', color: '#F97316' }
            ]
        },
        {
            name: 'Medallion',
            description: 'Bronze → Silver → Gold architecture',
            icon: <Database className="w-5 h-5" />,
            layers: [
                { name: 'Bronze', description: 'Raw data landing zone', color: '#A16207' },
                { name: 'Silver', description: 'Cleansed and conformed', color: '#64748B' },
                { name: 'Gold', description: 'Business-ready aggregates', color: '#EAB308' }
            ]
        },
        {
            name: 'Infrastructure',
            description: 'System architecture layers',
            icon: <Building className="w-5 h-5" />,
            layers: [
                { name: 'Storage', description: 'Data storage layer', color: '#06B6D4' },
                { name: 'Compute', description: 'Processing infrastructure', color: '#8B5CF6' },
                { name: 'Network', description: 'Connectivity layer', color: '#EC4899' },
                { name: 'Application', description: 'Application services', color: '#22C55E' }
            ]
        },
        {
            name: 'Simple',
            description: 'Basic 2-layer structure',
            icon: <Layers className="w-5 h-5" />,
            layers: [
                { name: 'Internal', description: 'Internal systems', color: '#3B82F6' },
                { name: 'External', description: 'External integrations', color: '#64748B' }
            ]
        }
    ]

// ============================================
// Main Component
// ============================================

export function LayerManager({
    layers,
    onUpdate,
    onBulkAssign,
    className,
    mode
}: LayerManagerProps) {
    const [showTemplates, setShowTemplates] = useState(false)

    // Convert layers to Reorder items format
    const layerIds = useMemo(() => layers.map(l => l.id), [layers])

    // Handlers
    const handleReorder = useCallback((newOrder: string[]) => {
        const reorderedLayers = newOrder.map(id => layers.find(l => l.id === id)!).filter(Boolean)
        // Update sequence numbers
        const withSequence = reorderedLayers.map((layer, idx) => ({
            ...layer,
            sequence: idx
        }))
        onUpdate(withSequence)
    }, [layers, onUpdate])

    const handleAddLayer = useCallback(() => {
        const newLayer: ViewLayerConfig = {
            id: generateId(),
            name: `Layer ${layers.length + 1}`,
            description: '',
            color: ['#3B82F6', '#8B5CF6', '#22C55E', '#F97316', '#EC4899', '#06B6D4'][layers.length % 6],
            order: layers.length,
            sequence: layers.length,
            entityTypes: [],
            rules: []
        }
        onUpdate([...layers, newLayer])
    }, [layers, onUpdate])

    const handleApplyTemplate = useCallback((template: typeof LAYER_TEMPLATES[0]) => {
        const newLayers: ViewLayerConfig[] = template.layers.map((partial, idx) => ({
            id: generateId(),
            name: partial.name || `Layer ${idx + 1}`,
            description: partial.description || '',
            color: partial.color || '#3B82F6',
            order: idx,
            sequence: idx,
            entityTypes: partial.entityTypes || [],
            rules: partial.rules || []
        }))
        onUpdate(newLayers)
        setShowTemplates(false)
    }, [onUpdate])

    const handleUpdateLayer = useCallback((layerId: string, updates: Partial<ViewLayerConfig>) => {
        onUpdate(
            layers.map(l => l.id === layerId ? { ...l, ...updates } : l)
        )
    }, [layers, onUpdate])

    const handleRemoveLayer = useCallback((layerId: string) => {
        onUpdate(layers.filter(l => l.id !== layerId))
    }, [layers, onUpdate])

    const handleDuplicateLayer = useCallback((layerId: string) => {
        const layer = layers.find(l => l.id === layerId)
        if (!layer) return

        const newLayer: ViewLayerConfig = {
            ...layer,
            id: generateId(),
            name: `${layer.name} (Copy)`,
            order: layers.length,
            sequence: layers.length
        }
        onUpdate([...layers, newLayer])
    }, [layers, onUpdate])

    const handleAssignEntity = useCallback((layerId: string, entityId: string) => {
        const newLayers = layers.map(l => {
            // Remove entity from other layers first (exclusivity)
            const cleanAssignments = (l.entityAssignments || []).filter(a => a.entityId !== entityId)

            if (l.id === layerId) {
                // Add to this layer
                const newAssignment: EntityAssignmentConfig = {
                    entityId,
                    layerId,
                    inheritsChildren: true,
                    priority: 1
                }
                return {
                    ...l,
                    entityAssignments: [...cleanAssignments, newAssignment]
                }
            }
            return {
                ...l,
                entityAssignments: cleanAssignments
            }
        })
        onUpdate(newLayers)
    }, [layers, onUpdate])

    const handleUnassignEntity = useCallback((_layerId: string, entityId: string) => {
        const newLayers = layers.map(l => ({
            ...l,
            entityAssignments: (l.entityAssignments || []).filter(a => a.entityId !== entityId)
        }))
        onUpdate(newLayers)
    }, [layers, onUpdate])

    if (mode === 'assignment') {
        return (
            <div className={cn('space-y-3', className)}>
                {layers.length > 0 ? (
                    layers.map(layer => (
                        <AssignmentLayerCard
                            key={layer.id}
                            layer={layer}
                            entityAssignments={layer.entityAssignments || []}
                            onAssign={handleAssignEntity}
                            onUnassign={handleUnassignEntity}
                            onBulkAssign={onBulkAssign}
                        />
                    ))
                ) : (
                    <div className="text-center py-12 text-slate-400">
                        <p>No layers available for assignment</p>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className={cn('space-y-4', className)}>
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Layers</h3>
                    <p className="text-sm text-slate-500">Organize entities into horizontal layers</p>
                </div>

                {/* Templates Toggle */}
                <button
                    onClick={() => setShowTemplates(!showTemplates)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                >
                    <Sparkles className="w-4 h-4" />
                    Templates
                    <ChevronDown className={cn('w-4 h-4 transition-transform', showTemplates && 'rotate-180')} />
                </button>
            </div>

            {/* Templates Panel */}
            <AnimatePresence>
                {showTemplates && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="grid grid-cols-2 gap-3 p-4 bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-800 dark:to-blue-900/20 rounded-xl border border-slate-200 dark:border-slate-700">
                            {LAYER_TEMPLATES.map((template, i) => (
                                <button
                                    key={i}
                                    onClick={() => handleApplyTemplate(template)}
                                    className="flex items-start gap-3 p-3 text-left bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all"
                                >
                                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white flex-shrink-0">
                                        {template.icon}
                                    </div>
                                    <div>
                                        <p className="font-semibold text-sm text-slate-800 dark:text-white">{template.name}</p>
                                        <p className="text-xs text-slate-500">{template.description}</p>
                                        <div className="flex items-center gap-1 mt-1.5">
                                            {template.layers.map((layer, j) => (
                                                <div
                                                    key={j}
                                                    className="w-3 h-3 rounded-sm"
                                                    style={{ backgroundColor: layer.color }}
                                                    title={layer.name}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Layers List */}
            {layers.length > 0 ? (
                <Reorder.Group
                    axis="y"
                    values={layerIds}
                    onReorder={handleReorder}
                    className="space-y-3"
                >
                    {layers.map((layer, index) => (
                        <ReorderableLayerCard
                            key={layer.id}
                            layer={layer}
                            index={index}
                            onUpdate={(updates) => handleUpdateLayer(layer.id, updates)}
                            onRemove={() => handleRemoveLayer(layer.id)}
                            onDuplicate={() => handleDuplicateLayer(layer.id)}
                        />
                    ))}
                </Reorder.Group>
            ) : (
                <div className="text-center py-12 bg-slate-50 dark:bg-slate-800/50 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700">
                    <Layers className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="text-base font-medium text-slate-600 dark:text-slate-400">No layers configured</p>
                    <p className="text-sm text-slate-400 mt-1 mb-4">Add layers to organize entities</p>
                    <div className="flex items-center justify-center gap-3">
                        <button
                            onClick={handleAddLayer}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
                        >
                            <Plus className="w-4 h-4" /> Add Layer
                        </button>
                        <button
                            onClick={() => setShowTemplates(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-blue-300 transition-colors text-sm font-medium"
                        >
                            <Sparkles className="w-4 h-4" /> Use Template
                        </button>
                    </div>
                </div>
            )}

            {/* Add Layer Button */}
            {layers.length > 0 && (
                <button
                    onClick={handleAddLayer}
                    className="w-full flex items-center justify-center gap-2 p-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-500 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors"
                >
                    <Plus className="w-4 h-4" /> Add Layer
                </button>
            )}
        </div>
    )
}

export default LayerManager
