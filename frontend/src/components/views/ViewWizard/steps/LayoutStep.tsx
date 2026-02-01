/**
 * LayoutStep - Second wizard step for layout type selection and layer configuration
 * 
 * Beautiful card-based layout selection with recommended badge
 */

import React, { useState, useCallback } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import {
    Check,
    Plus,
    GripVertical,
    Trash2,
    ChevronDown,
    ChevronRight,
    Wand2
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import type { WizardFormData } from '../ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Types
// ============================================

interface LayoutStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    layoutTypes: {
        id: 'graph' | 'hierarchy' | 'reference'
        label: string
        icon: React.ReactNode
        description: string
        features: string[]
        recommended?: boolean
    }[]
}

interface LayerTemplate {
    id: string
    name: string
    description: string
    layers: Omit<ViewLayerConfig, 'id' | 'order'>[]
}

const LAYER_TEMPLATES: LayerTemplate[] = [
    {
        id: 'data-flow',
        name: 'Data Flow',
        description: 'Source → Staging → Transform → Consumption',
        layers: [
            { name: 'Source', description: 'Raw data sources', color: '#3b82f6', entityTypes: ['database', 'file'] },
            { name: 'Staging', description: 'Intermediate storage', color: '#8b5cf6', entityTypes: ['schema', 'table'] },
            { name: 'Transform', description: 'Processing layer', color: '#f59e0b', entityTypes: ['table', 'view'] },
            { name: 'Consumption', description: 'Analytics and reports', color: '#22c55e', entityTypes: ['dashboard', 'report'] }
        ]
    },
    {
        id: 'medallion',
        name: 'Medallion',
        description: 'Bronze → Silver → Gold',
        layers: [
            { name: 'Bronze', description: 'Raw data', color: '#CD7F32', entityTypes: ['database', 'file'] },
            { name: 'Silver', description: 'Cleansed', color: '#C0C0C0', entityTypes: ['table'] },
            { name: 'Gold', description: 'Business-ready', color: '#FFD700', entityTypes: ['view', 'dashboard'] }
        ]
    },
    {
        id: 'simple',
        name: 'Simple',
        description: 'Input → Output',
        layers: [
            { name: 'Input', description: 'Source systems', color: '#3b82f6', entityTypes: [] },
            { name: 'Output', description: 'Target systems', color: '#22c55e', entityTypes: [] }
        ]
    }
]

const LAYER_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444', '#06b6d4', '#ec4899', '#6366f1']

// ============================================
// Component
// ============================================

export function LayoutStep({ formData, updateFormData, layoutTypes }: LayoutStepProps) {
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null)

    const handleSelectLayoutType = useCallback((type: 'graph' | 'hierarchy' | 'reference') => {
        updateFormData({ layoutType: type })
        // If switching to reference and no layers, start with empty
        if (type === 'reference' && formData.layers.length === 0) {
            // Don't auto-add—let user pick template
        }
    }, [updateFormData, formData.layers])

    const handleApplyTemplate = useCallback((template: LayerTemplate) => {
        const layers: ViewLayerConfig[] = template.layers.map((l, i) => ({
            ...l,
            id: generateId(),
            order: i
        }))
        updateFormData({ layers })
    }, [updateFormData])

    const handleAddLayer = useCallback(() => {
        const newLayer: ViewLayerConfig = {
            id: generateId(),
            name: `Layer ${formData.layers.length + 1}`,
            description: '',
            color: LAYER_COLORS[formData.layers.length % LAYER_COLORS.length],
            entityTypes: [],
            order: formData.layers.length
        }
        updateFormData({ layers: [...formData.layers, newLayer] })
        setExpandedLayerId(newLayer.id)
    }, [formData.layers, updateFormData])

    const handleUpdateLayer = useCallback((id: string, updates: Partial<ViewLayerConfig>) => {
        updateFormData({
            layers: formData.layers.map(l => l.id === id ? { ...l, ...updates } : l)
        })
    }, [formData.layers, updateFormData])

    const handleRemoveLayer = useCallback((id: string) => {
        updateFormData({
            layers: formData.layers.filter(l => l.id !== id)
        })
        if (expandedLayerId === id) setExpandedLayerId(null)
    }, [formData.layers, expandedLayerId, updateFormData])

    const handleReorderLayers = useCallback((reordered: ViewLayerConfig[]) => {
        updateFormData({
            layers: reordered.map((l, i) => ({ ...l, order: i }))
        })
    }, [updateFormData])

    return (
        <div className="space-y-8">
            {/* Layout Type Selection */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
            >
                <div className="text-center mb-6">
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
                        Choose your layout type
                    </h3>
                    <p className="text-slate-500">
                        Select how you want your view to be organized
                    </p>
                </div>

                <div className="grid grid-cols-3 gap-4">
                    {layoutTypes.map((type) => (
                        <motion.button
                            key={type.id}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => handleSelectLayoutType(type.id)}
                            className={cn(
                                'relative p-6 rounded-2xl border-2 text-left transition-all',
                                formData.layoutType === type.id
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 ring-4 ring-blue-500/10'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-800'
                            )}
                        >
                            {/* Recommended Badge */}
                            {type.recommended && (
                                <span className="absolute -top-2 -right-2 px-2 py-0.5 text-xs font-semibold bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow-lg">
                                    Recommended
                                </span>
                            )}

                            {/* Selected Check */}
                            {formData.layoutType === type.id && (
                                <motion.div
                                    initial={{ scale: 0 }}
                                    animate={{ scale: 1 }}
                                    className="absolute top-3 right-3 w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center"
                                >
                                    <Check className="w-4 h-4 text-white" />
                                </motion.div>
                            )}

                            <div className="text-blue-600 dark:text-blue-400 mb-3">
                                {type.icon}
                            </div>
                            <h4 className="font-bold text-slate-900 dark:text-white mb-1">
                                {type.label}
                            </h4>
                            <p className="text-sm text-slate-500 mb-3">
                                {type.description}
                            </p>
                            <ul className="space-y-1">
                                {type.features.map((feature, i) => (
                                    <li key={i} className="flex items-center gap-2 text-xs text-slate-400">
                                        <span className="w-1 h-1 rounded-full bg-slate-400" />
                                        {feature}
                                    </li>
                                ))}
                            </ul>
                        </motion.button>
                    ))}
                </div>
            </motion.div>

            {/* Layer Configuration (for Reference Model) */}
            <AnimatePresence>
                {formData.layoutType === 'reference' && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-4 pt-6 border-t border-slate-200 dark:border-slate-700"
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <h4 className="font-bold text-slate-900 dark:text-white">
                                    Configure Layers
                                </h4>
                                <p className="text-sm text-slate-500">
                                    Define the horizontal layers for your reference model
                                </p>
                            </div>
                            <button
                                onClick={handleAddLayer}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Add Layer
                            </button>
                        </div>

                        {/* Templates */}
                        {formData.layers.length === 0 && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800"
                            >
                                <div className="flex items-center gap-2 mb-3">
                                    <Wand2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">Quick Start Templates</span>
                                </div>
                                <div className="grid grid-cols-3 gap-3">
                                    {LAYER_TEMPLATES.map(template => (
                                        <button
                                            key={template.id}
                                            onClick={() => handleApplyTemplate(template)}
                                            className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors text-left"
                                        >
                                            <p className="font-medium text-sm text-slate-800 dark:text-slate-200">{template.name}</p>
                                            <p className="text-xs text-slate-500">{template.description}</p>
                                        </button>
                                    ))}
                                </div>
                            </motion.div>
                        )}

                        {/* Layer List */}
                        {formData.layers.length > 0 && (
                            <Reorder.Group
                                axis="y"
                                values={formData.layers}
                                onReorder={handleReorderLayers}
                                className="space-y-2"
                            >
                                {formData.layers.map((layer, index) => (
                                    <Reorder.Item
                                        key={layer.id}
                                        value={layer}
                                        className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
                                    >
                                        {/* Layer Header */}
                                        <div
                                            className="flex items-center gap-3 p-4 cursor-pointer"
                                            onClick={() => setExpandedLayerId(expandedLayerId === layer.id ? null : layer.id)}
                                        >
                                            <GripVertical className="w-5 h-5 text-slate-400 cursor-grab" />
                                            <div
                                                className="w-4 h-4 rounded-full"
                                                style={{ backgroundColor: layer.color }}
                                            />
                                            <span className="font-medium text-slate-800 dark:text-slate-200 flex-1">
                                                {layer.name}
                                            </span>
                                            <span className="text-xs text-slate-400 px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded-full">
                                                Order: {index + 1}
                                            </span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleRemoveLayer(layer.id) }}
                                                className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                            {expandedLayerId === layer.id ? (
                                                <ChevronDown className="w-5 h-5 text-slate-400" />
                                            ) : (
                                                <ChevronRight className="w-5 h-5 text-slate-400" />
                                            )}
                                        </div>

                                        {/* Expanded Content */}
                                        <AnimatePresence>
                                            {expandedLayerId === layer.id && (
                                                <motion.div
                                                    initial={{ height: 0 }}
                                                    animate={{ height: 'auto' }}
                                                    exit={{ height: 0 }}
                                                    className="overflow-hidden"
                                                >
                                                    <div className="p-4 pt-0 space-y-4 border-t border-slate-100 dark:border-slate-700">
                                                        <div className="grid grid-cols-2 gap-4">
                                                            <div>
                                                                <label className="text-xs font-medium text-slate-500 uppercase">Name</label>
                                                                <input
                                                                    type="text"
                                                                    value={layer.name}
                                                                    onChange={(e) => handleUpdateLayer(layer.id, { name: e.target.value })}
                                                                    className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-medium text-slate-500 uppercase">Color</label>
                                                                <div className="flex gap-2 mt-1">
                                                                    {LAYER_COLORS.map(color => (
                                                                        <button
                                                                            key={color}
                                                                            onClick={() => handleUpdateLayer(layer.id, { color })}
                                                                            className={cn(
                                                                                'w-7 h-7 rounded-full transition-transform',
                                                                                layer.color === color && 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                                                                            )}
                                                                            style={{ backgroundColor: color }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-500 uppercase">Description</label>
                                                            <input
                                                                type="text"
                                                                value={layer.description || ''}
                                                                onChange={(e) => handleUpdateLayer(layer.id, { description: e.target.value })}
                                                                placeholder="Optional description"
                                                                className="w-full mt-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm"
                                                            />
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </Reorder.Item>
                                ))}
                            </Reorder.Group>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

export default LayoutStep
