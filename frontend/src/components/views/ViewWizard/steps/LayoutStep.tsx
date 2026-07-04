/**
 * LayoutStep - Second wizard step for layout type selection and layer configuration
 * 
 * Beautiful card-based layout selection with recommended badge
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import {
    Check,
    Plus,
    GripVertical,
    Trash2,
    ChevronDown,
    ChevronRight,
    Wand2,
    Sparkles,
    Repeat
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import type { WizardFormData } from '../ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'
import { listTemplates as fetchBackendTemplates } from '@/services/contextModelService'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { useSchemaEntityTypes, useSchemaStore } from '@/store/schema'
import { blankQuickStartTemplates } from '../blankTemplates'
import { deriveLayersFromOntology } from '../blankModel'

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
    /** Data source whose assigned ontology scopes the entity type picker. */
    dataSourceId?: string
    /** Blank model: no data source yet — read entity types from the hydrated schema store. */
    blank?: boolean
}

interface LayerTemplate {
    id: string
    name: string
    description: string
    category?: string
    layers: Omit<ViewLayerConfig, 'id' | 'order'>[]
}

// ============================================
// Local fallback templates (used when backend returns 0 templates)
// ============================================

// Entity types are intentionally left empty — they are driven by the active
// data source's ontology and selected by the user in the layer editor.
const LOCAL_FALLBACK_TEMPLATES: LayerTemplate[] = [
    {
        id: 'data-flow',
        name: 'Data Flow',
        description: 'Source → Staging → Transform → Consumption',
        category: 'data-engineering',
        layers: [
            { name: 'Source', description: 'Raw data sources', color: '#3b82f6', entityTypes: [] },
            { name: 'Staging', description: 'Intermediate storage', color: '#8b5cf6', entityTypes: [] },
            { name: 'Transform', description: 'Processing layer', color: '#f59e0b', entityTypes: [] },
            { name: 'Consumption', description: 'Analytics and reports', color: '#22c55e', entityTypes: [] }
        ]
    },
    {
        id: 'medallion',
        name: 'Medallion',
        description: 'Bronze → Silver → Gold',
        category: 'data-engineering',
        layers: [
            { name: 'Bronze', description: 'Raw data', color: '#CD7F32', entityTypes: [] },
            { name: 'Silver', description: 'Cleansed', color: '#C0C0C0', entityTypes: [] },
            { name: 'Gold', description: 'Business-ready', color: '#FFD700', entityTypes: [] }
        ]
    },
    {
        id: 'simple',
        name: 'Simple',
        description: 'Input → Output',
        category: undefined,
        layers: [
            { name: 'Input', description: 'Source systems', color: '#3b82f6', entityTypes: [] },
            { name: 'Output', description: 'Target systems', color: '#22c55e', entityTypes: [] }
        ]
    }
]

const LAYER_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444', '#06b6d4', '#ec4899', '#6366f1']

// ============================================
// Blank-model Quick Start template gallery
// ============================================

/** Mini preview: up to five neutral column bars with truncated names. Deliberately
 *  monochrome (the layers' real colors show on the canvas, not here) — five cards of
 *  saturated bars read as noise; only the SELECTED card's bars take a soft accent. */
function TemplatePreview({ layers, active }: { layers: ViewLayerConfig[]; active?: boolean }) {
    if (layers.length === 0) {
        return (
            <div className="flex items-center justify-center h-[52px] rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-[10px] text-slate-400">
                Empty canvas
            </div>
        )
    }
    const shown = layers.slice(0, 5)
    const extra = layers.length - shown.length
    return (
        <div className="flex items-end gap-1.5">
            {shown.map((layer, i) => (
                <div key={layer.id ?? i} className="flex-1 min-w-0">
                    <div className={cn(
                        'h-8 rounded-md border',
                        active
                            ? 'bg-blue-100 border-blue-200 dark:bg-blue-900/40 dark:border-blue-800'
                            : 'bg-slate-100 border-slate-200 dark:bg-slate-700/60 dark:border-slate-600/60',
                    )} />
                    <div className="mt-1 text-[9px] text-slate-500 dark:text-slate-400 truncate text-center" title={layer.name}>
                        {layer.name}
                    </div>
                </div>
            ))}
            {extra > 0 && (
                <div className="flex-none">
                    <div className="h-8 px-1.5 rounded-md bg-slate-100 border border-slate-200 dark:bg-slate-700/60 dark:border-slate-600/60 flex items-center justify-center text-[9px] font-semibold text-slate-500 dark:text-slate-300">
                        +{extra}
                    </div>
                    <div className="mt-1 text-[9px] text-transparent">.</div>
                </div>
            )}
        </div>
    )
}

/** One template offering, whatever its origin (blank Quick Start, backend
 *  ContextModel, local fallback, or ontology-derived). The gallery renders all
 *  of them identically so both creation flows share one visual language. */
interface GalleryTemplate {
    id: string
    name: string
    description: string
    category?: string
    recommended?: boolean
    layers: Array<Partial<ViewLayerConfig> & { name: string }>
}

/** Gallery of Quick Start templates — one card per template with a mini preview,
 *  description, category chip, and selected state. Shared by BOTH creation flows. */
function TemplateGallery({
    templates,
    activeId,
    loading,
    onApply,
}: {
    templates: GalleryTemplate[]
    activeId?: string
    loading?: boolean
    onApply: (template: GalleryTemplate) => void
}) {
    if (loading) {
        return (
            <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 p-4 animate-pulse">
                        <div className="h-3 w-2/3 bg-slate-200 dark:bg-slate-600 rounded mb-2" />
                        <div className="h-2 w-full bg-slate-100 dark:bg-slate-700 rounded mb-4" />
                        <div className="flex gap-1.5">
                            {Array.from({ length: 3 }).map((_, j) => (
                                <div key={j} className="h-8 flex-1 bg-slate-100 dark:bg-slate-700 rounded-md" />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        )
    }
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {templates.map(template => {
                const active = template.id === activeId
                return (
                    <button
                        key={template.id}
                        type="button"
                        onClick={() => onApply(template)}
                        className={cn(
                            'relative text-left rounded-xl border-2 p-4 transition-colors duration-150 hover:shadow-md',
                            active
                                ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm shadow-blue-500/10'
                                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-600',
                        )}
                    >
                        {template.recommended && (
                            <span className="absolute -top-2 -right-2 inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] font-semibold bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow">
                                <Sparkles className="w-3 h-3" /> Recommended
                            </span>
                        )}
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <h5 className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{template.name}</h5>
                            <span className="text-[10px] text-slate-400 shrink-0">
                                {template.layers.length > 0
                                    ? `${template.layers.length} layer${template.layers.length !== 1 ? 's' : ''}`
                                    : 'no layers'}
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 leading-snug mb-3">
                            {template.description}
                        </p>
                        <TemplatePreview layers={template.layers as ViewLayerConfig[]} active={active} />
                        {template.category && (
                            <span className="inline-block mt-2.5 px-1.5 py-0.5 text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded capitalize">
                                {template.category.replace(/-/g, ' ')}
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}

// ============================================
// Component
// ============================================

export function LayoutStep({ formData, updateFormData, layoutTypes, dataSourceId, blank }: LayoutStepProps) {
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null)
    // Blank models have no data source to probe; their ontology schema is hydrated
    // into the schema store, so read entity types from there instead.
    const { entityTypes: dsEntityTypes } = useDataSourceSchema(dataSourceId)
    const storeEntityTypes = useSchemaEntityTypes()
    const schemaEntityTypes = blank ? storeEntityTypes : dsEntityTypes
    const availableEntityTypes = useMemo(
        () => schemaEntityTypes.slice().sort((a, b) => a.name.localeCompare(b.name)),
        [schemaEntityTypes]
    )

    // ── Quick Start templates (both creation flows) ───────────────────────────
    // Blank models: ontology + generic scaffolds from blankQuickStartTemplates.
    // Existing sources: an ontology-derived recommended template (their assigned
    // schema has levels too) ahead of the org's backend/local templates. Both
    // render through the same TemplateGallery.
    const blankSchema = useSchemaStore(s => s.schema)
    const blankTemplates = useMemo(
        () => (blank && blankSchema ? blankQuickStartTemplates(blankSchema) : []),
        [blank, blankSchema],
    )
    // Gallery stays open until a template is explicitly chosen, and re-opens when
    // the user switches. `layoutTemplateId` persists the choice across step nav.
    // Existing-source mode keeps its original semantics: the gallery shows while
    // there are no layers (no choice is REQUIRED — canProceed is unchanged there).
    const [galleryOpen, setGalleryOpen] = useState(false)
    const showGallery = galleryOpen
        || (blank ? !formData.layoutTemplateId : formData.layers.length === 0)

    const handleSwitchTemplate = useCallback(() => {
        if (formData.layers.length > 0 && !window.confirm('Switching templates will replace your current layers. Continue?')) {
            return
        }
        setGalleryOpen(true)
    }, [formData.layers.length])

    // ── Backend templates ────────────────────────────────────────────────────
    const [backendTemplates, setBackendTemplates] = useState<LayerTemplate[]>([])
    const [templatesLoading, setTemplatesLoading] = useState(false)

    useEffect(() => {
        setTemplatesLoading(true)
        fetchBackendTemplates()
            .then(results => {
                if (results.length > 0) {
                    // Map backend ContextModel → LayerTemplate
                    const mapped: LayerTemplate[] = results.map(cm => ({
                        id: cm.id,
                        name: cm.name,
                        description: cm.description ?? '',
                        category: cm.category ?? undefined,
                        layers: (cm.layersConfig ?? []).map(l => ({
                            name: l.name,
                            description: l.description,
                            color: l.color ?? '#6366f1',
                            icon: l.icon,
                            entityTypes: l.entityTypes ?? [],
                            rules: l.rules,
                        }))
                    }))
                    setBackendTemplates(mapped)
                }
            })
            .catch(() => { /* silent — fallback to local */ })
            .finally(() => setTemplatesLoading(false))
    }, [])

    // Use backend templates if available, otherwise local fallbacks
    const activeTemplates = backendTemplates.length > 0 ? backendTemplates : LOCAL_FALLBACK_TEMPLATES

    // The one list the gallery renders, per flow.
    const galleryTemplates: GalleryTemplate[] = useMemo(() => {
        if (blank) return blankTemplates
        const fromSchema: GalleryTemplate | null = schemaEntityTypes.length > 0 ? {
            id: 'from-schema',
            name: 'From your schema',
            description: 'One layer per level of your assigned ontology, with entity types pre-assigned.',
            category: 'schema',
            recommended: true,
            layers: deriveLayersFromOntology({ entityTypes: schemaEntityTypes }),
        } : null
        return [...(fromSchema ? [fromSchema] : []), ...activeTemplates]
    }, [blank, blankTemplates, schemaEntityTypes, activeTemplates])

    // One apply path for every template origin: normalize layers (mint ids/orders,
    // default colors) and record the choice so the picker can be revisited.
    const handleApplyGalleryTemplate = useCallback((template: GalleryTemplate) => {
        const layers: ViewLayerConfig[] = template.layers.map((l, i) => ({
            ...l,
            name: l.name,
            description: l.description ?? '',
            color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
            entityTypes: [...(l.entityTypes ?? [])],
            id: l.id ?? generateId(),
            order: i,
        }))
        updateFormData({ layers, layoutTemplateId: template.id })
        setGalleryOpen(false)
    }, [updateFormData])
    // ────────────────────────────────────────────────────────────────────────

    const handleSelectLayoutType = useCallback((type: 'graph' | 'hierarchy' | 'reference') => {
        updateFormData({ layoutType: type })
        // If switching to reference and no layers, start with empty
        if (type === 'reference' && formData.layers.length === 0) {
            // Don't auto-add—let user pick template
        }
    }, [updateFormData, formData.layers])

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

    // What the reference-layout section renders:
    //  - gallery open (either flow) → the shared Quick Start gallery
    //  - blank + empty template chosen → an add-your-own prompt
    //  - otherwise (layers exist) → the layer editor
    const showBlankEmptyState = blank && !showGallery && formData.layers.length === 0
    const showLayerList = formData.layers.length > 0 && !showGallery

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
                                'relative p-6 rounded-2xl border-2 text-left transition-colors duration-150',
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
                                    {showGallery ? 'Choose a starting template' : 'Configure Layers'}
                                </h4>
                                <p className="text-sm text-slate-500">
                                    {showGallery
                                        ? 'Pick a starting arrangement — you can refine the layers next'
                                        : 'Define the horizontal layers for your context view'}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                {!showGallery && (
                                    <button
                                        onClick={handleSwitchTemplate}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        <Repeat className="w-4 h-4" />
                                        Switch template
                                    </button>
                                )}
                                {/* Existing-source mode keeps manual building available even
                                    while the gallery shows (its original behavior); blank mode
                                    requires an explicit template choice first. */}
                                {(!showGallery || !blank) && (
                                    <button
                                        onClick={handleAddLayer}
                                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                                    >
                                        <Plus className="w-4 h-4" />
                                        Add Layer
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Quick Start template gallery — shared by both creation flows */}
                        {showGallery && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800"
                            >
                                <div className="flex items-center gap-2 mb-3">
                                    <Wand2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                    <span className="font-semibold text-slate-800 dark:text-slate-200">Quick Start Templates</span>
                                    {!blank && templatesLoading && (
                                        <span className="ml-auto text-[10px] text-indigo-500 animate-pulse">Loading from backend…</span>
                                    )}
                                </div>
                                <TemplateGallery
                                    templates={galleryTemplates}
                                    activeId={formData.layoutTemplateId}
                                    loading={!blank && templatesLoading}
                                    onApply={handleApplyGalleryTemplate}
                                />
                            </motion.div>
                        )}

                        {/* Blank models: empty template chosen — prompt to build layers */}
                        {showBlankEmptyState && (
                            <div className="flex flex-col items-center justify-center py-10 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-700">
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Starting from an empty canvas</p>
                                <p className="text-xs text-slate-400 max-w-[280px]">
                                    Add layers to organize your model, or switch to a template above.
                                </p>
                            </div>
                        )}

                        {/* Layer List */}
                        {showLayerList && (
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
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-500 uppercase">Entity Types</label>
                                                            <div className="flex flex-wrap gap-1.5 mt-1 min-h-[32px]">
                                                                {availableEntityTypes.map(et => {
                                                                    const active = (layer.entityTypes ?? []).includes(et.id)
                                                                    return (
                                                                        <button
                                                                            key={et.id}
                                                                            type="button"
                                                                            onClick={() => handleUpdateLayer(layer.id, {
                                                                                entityTypes: active
                                                                                    ? (layer.entityTypes ?? []).filter(id => id !== et.id)
                                                                                    : [...(layer.entityTypes ?? []), et.id]
                                                                            })}
                                                                            className={cn(
                                                                                'px-2 py-1 text-xs rounded-full border transition-colors',
                                                                                active
                                                                                    ? 'border-transparent text-white'
                                                                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                                                            )}
                                                                            style={active ? { backgroundColor: et.visual.color } : undefined}
                                                                        >
                                                                            {et.name}
                                                                        </button>
                                                                    )
                                                                })}
                                                                {availableEntityTypes.length === 0 && (
                                                                    <span className="text-xs text-slate-400 italic">No entity types in ontology yet</span>
                                                                )}
                                                            </div>
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
