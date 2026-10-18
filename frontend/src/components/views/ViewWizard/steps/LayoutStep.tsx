/**
 * LayoutStep - Second wizard step for layout type selection and layer configuration
 * 
 * Beautiful card-based layout selection with recommended badge
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
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
    Repeat,
    Layers,
    LayoutTemplate,
    Search,
    Save,
    AlertTriangle,
    X,
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import type { WizardFormData } from '../ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { useLayoutTemplate, useLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { caseFold } from '@/features/ontology/lib/caseFold'
import { useSchemaEntityTypes, useSchemaStore } from '@/store/schema'
import type { LayoutTemplate as LibraryTemplate } from '@/services/layoutTemplateService'
import { TemplatePreview } from '@/components/templates/TemplatePreview'
import { SaveAsTemplateDialog } from '@/components/templates/SaveAsTemplateDialog'
import { fitTemplate, type TemplateFit } from '@/components/templates/templateFit'
import { AUDIENCE, LIBRARY_TABS, audienceOf, type LibraryTab, type TemplateAudience } from '@/components/templates/templateAudience'
import { blankQuickStartTemplates } from '../blankTemplates'
import { deriveLayersFromOntology } from '../blankModel'
import { deriveRootTypeCandidates, layersForRootTypes } from '../autoLayers'

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
    /** The layers came from an imported file. No Quick Start: a template replaces the layers
     *  and so unplaces everything the file placed. */
    imported?: boolean
    /** Opened from a library template ("Use template"): apply it once, as soon as the
     *  semantic layer it is matched against is known. */
    initialTemplateId?: string
}

/** Shared layer palette — also used by the Layer Studio's in-step "Add layer"
 *  so colours never drift between the two places layers can be created. */
export const LAYER_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#22c55e', '#ef4444', '#06b6d4', '#ec4899', '#6366f1']

// ============================================
// Quick Start template gallery
// ============================================

/** One template offering, whatever its origin (blank Quick Start, ontology-derived,
 *  or the template library). The gallery renders all of them identically so both
 *  creation flows share one visual language. */
interface GalleryTemplate {
    id: string
    name: string
    description: string
    category?: string
    recommended?: boolean
    layers: Array<Partial<ViewLayerConfig> & { name: string }>
    /** A library template: who it is for, and how well it fits this data. */
    audience?: TemplateAudience
    fit?: TemplateFit
    /** Pin the view's entity scope when the template's layers only work under one.
     *  A template whose layers carry `entityTypes` places entities BY RULE and
     *  writes no assignments — that resolves only in open ('all') scope, and
     *  `deriveEntityScope` would otherwise flip the view to 'curated' the moment
     *  the user drags a single entity, emptying every other column. */
    entityScope?: 'all' | 'curated'
}

/** "3 columns — Domains, Roots, Platforms — each carrying everything it contains."
 *  Long type lists are trimmed so the card stays a card. */
function describeColumns(labels: string[]): string {
    const shown = labels.slice(0, 4).join(', ')
    const rest = labels.length - 4
    const named = rest > 0 ? `${shown} and ${rest} more` : shown
    return labels.length === 1
        ? `One ${named} column, carrying everything those entities contain.`
        : `${labels.length} columns — ${named} — each carrying everything it contains.`
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
                        <TemplatePreview layers={template.layers} active={active} />
                        {(template.category || template.audience || template.fit) && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                {template.audience && (
                                    <span className={cn('px-1.5 py-0.5 text-[10px] font-semibold rounded border', AUDIENCE[template.audience].badge)}>
                                        {AUDIENCE[template.audience].label}
                                    </span>
                                )}
                                {template.category && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded capitalize">
                                        {template.category.replace(/-/g, ' ')}
                                    </span>
                                )}
                                {template.fit && template.fit.typedLayers > 0 && (
                                    <span className={cn(
                                        'ml-auto px-1.5 py-0.5 text-[10px] font-semibold rounded',
                                        template.fit.matchedLayers === template.fit.typedLayers
                                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                                    )}>
                                        {template.fit.matchedLayers === template.fit.typedLayers
                                            ? 'Fits your data'
                                            : `Matches ${template.fit.matchedLayers} of ${template.fit.typedLayers} layers`}
                                    </span>
                                )}
                            </div>
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

export function LayoutStep({ formData, updateFormData, layoutTypes, dataSourceId, blank, imported, initialTemplateId }: LayoutStepProps) {
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null)
    // Blank models have no data source to probe; their ontology schema is hydrated
    // into the schema store, so read entity types from there instead.
    const {
        entityTypes: dsEntityTypes,
        relationshipTypes: dsRelationshipTypes,
        rootEntityTypes: dsRootEntityTypes,
        containmentEdgeTypes: dsContainmentEdgeTypes,
        isLoading: dsSchemaLoading,
    } = useDataSourceSchema(dataSourceId)
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
    const showGallery = !imported && (galleryOpen
        || (blank ? !formData.layoutTemplateId : formData.layers.length === 0))

    const handleSwitchTemplate = useCallback(() => {
        if (formData.layers.length > 0 && !window.confirm('Switching templates will replace your current layers. Continue?')) {
            return
        }
        setGalleryOpen(true)
    }, [formData.layers.length])

    // ── The template library ─────────────────────────────────────────────
    // Built-ins, the organization's, the workspace's and the person's own — one
    // cached list shared with the Templates page. Each is matched to THIS data's
    // semantic layer before it is offered, so the card can say how well it fits.
    const { templates: library, isLoading: libraryLoading } = useLayoutTemplates()
    const [libraryTab, setLibraryTab] = useState<LibraryTab>('all')
    const [libraryQuery, setLibraryQuery] = useState('')
    const [dismissedFitFor, setDismissedFitFor] = useState<string | null>(null)
    const [savingAsTemplate, setSavingAsTemplate] = useState(false)
    const declaredTypes = useMemo(() => schemaEntityTypes.map(et => et.id), [schemaEntityTypes])
    const libraryTabs = useMemo(
        () => LIBRARY_TABS.filter(tab => tab.id === 'all' || library.some(tab.match)),
        [library],
    )
    const libraryTemplates: GalleryTemplate[] = useMemo(() => {
        const q = libraryQuery.trim().toLowerCase()
        const inTab = LIBRARY_TABS.find(tab => tab.id === libraryTab)?.match ?? (() => true)
        return library
            .filter(t => inTab(t) && (!q || t.name.toLowerCase().includes(q)
                || (t.description ?? '').toLowerCase().includes(q)))
            .map(t => ({
                id: t.id,
                name: t.name,
                description: t.description ?? '',
                category: t.category ?? undefined,
                layers: t.layers,
                audience: audienceOf(t),
                fit: fitTemplate(t.layers, declaredTypes),
            }))
    }, [library, libraryTab, libraryQuery, declaredTypes])

    // What the data itself suggests, per flow; the library follows it.
    const suggestedTemplates: GalleryTemplate[] = useMemo(() => {
        if (blank) return blankTemplates

        // One column per TOP-LEVEL type, so Domain and Root each get their own
        // rather than sharing a single level-0 column. Each layer carries its one
        // entityType, which IS the placement rule: every root of that type lands
        // there and its containment children inherit, with no per-entity
        // assignment written and no column to fill in by hand.
        const rootTypeCandidates = deriveRootTypeCandidates({
            entityTypes: schemaEntityTypes,
            relationshipTypes: dsRelationshipTypes,
            rootEntityTypes: dsRootEntityTypes,
            containmentEdgeTypes: dsContainmentEdgeTypes,
        })
        const perRootType: GalleryTemplate | null = rootTypeCandidates.length > 0 ? {
            id: 'per-root-type',
            name: 'One layer per top-level type',
            description: describeColumns(rootTypeCandidates.map(c => c.label)),
            category: 'schema',
            recommended: true,
            layers: layersForRootTypes(rootTypeCandidates),
            entityScope: 'all',
        } : null

        const fromSchema: GalleryTemplate | null = schemaEntityTypes.length > 0 ? {
            id: 'from-schema',
            name: 'From your schema',
            description: 'One layer per level of your assigned ontology, with entity types pre-assigned.',
            category: 'schema',
            // Rule-driven exactly like the card above — its layers carry
            // entityTypes and no assignments, so it needs the same open scope.
            entityScope: 'all',
            layers: deriveLayersFromOntology({ entityTypes: schemaEntityTypes }),
        } : null

        return [
            ...(perRootType ? [perRootType] : []),
            ...(fromSchema ? [fromSchema] : []),
        ]
    }, [
        blank, blankTemplates, schemaEntityTypes,
        dsRelationshipTypes, dsRootEntityTypes, dsContainmentEdgeTypes,
    ])

    // One apply path for every template origin: normalize layers (mint ids/orders,
    // default colors) and record the choice so the picker can be revisited.
    // Resets assignments to {} — a template's layers get fresh ids, so any prior
    // assignments (keyed to the OLD layer ids) would otherwise dangle. Never
    // copies assignments a template might carry; only layer STRUCTURE is copied.
    const handleApplyGalleryTemplate = useCallback((template: GalleryTemplate) => {
        // Template types are suggestions written for SOME ontology: keep only the ones
        // this data source's ontology declares, in its own spelling. A layer left with
        // none keeps its name and colour and is filled by assignment, like the local
        // fallbacks.
        const declared = new Map(schemaEntityTypes.map(et => [caseFold(et.id), et.id]))
        const layers: ViewLayerConfig[] = template.layers.map((l, i) => ({
            ...l,
            name: l.name,
            description: l.description ?? '',
            color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
            entityTypes: [...new Set((l.entityTypes ?? [])
                .map(t => declared.get(caseFold(t)))
                .filter((t): t is string => !!t))],
            id: l.id ?? generateId(),
            order: i,
        }))
        updateFormData({
            layers,
            assignments: {},
            layoutTemplateId: template.id,
            contextModelId: undefined,
            entityScope: template.entityScope,
        })
        setGalleryOpen(false)
    }, [updateFormData, schemaEntityTypes])

    // A library template: every structural field kept, types resolved against
    // this data's semantic layer (unknown ones reported, never silently empty),
    // fresh layer ids, and the template recorded as where the view started.
    const libraryTemplateUpdate = useCallback((template: Pick<LibraryTemplate, 'id' | 'layers'>): Partial<WizardFormData> => {
        const layers = fitTemplate(template.layers, declaredTypes).layers.map((l, i) => ({
            ...l,
            description: l.description ?? '',
            color: l.color ?? LAYER_COLORS[i % LAYER_COLORS.length],
        }))
        return {
            layoutType: 'reference',
            layers,
            assignments: {},
            layoutTemplateId: template.id,
            contextModelId: template.id,
            // Layers that place by rule resolve only in open scope (see GalleryTemplate.entityScope).
            entityScope: layers.some(l => l.entityTypes.length > 0 || (l.rules?.length ?? 0) > 0) ? 'all' : undefined,
        }
    }, [declaredTypes])

    const handleApplyLibraryTemplate = useCallback((template: Pick<LibraryTemplate, 'id' | 'layers'>) => {
        updateFormData(libraryTemplateUpdate(template))
        setDismissedFitFor(null)
        setGalleryOpen(false)
    }, [updateFormData, libraryTemplateUpdate])

    // Opened from "Use template": apply it once, when both it and this data's
    // semantic layer are known. A hidden or unshared one is fetched on its own,
    // and one that cannot be read leaves the gallery open.
    const listedInitial = initialTemplateId ? library.find(t => t.id === initialTemplateId) : undefined
    const fetchedInitial = useLayoutTemplate(
        initialTemplateId && !libraryLoading && !listedInitial ? initialTemplateId : null,
    )
    const autoApplied = useRef(false)
    useEffect(() => {
        if (!initialTemplateId || autoApplied.current || imported) return
        if (formData.contextModelId === initialTemplateId) { autoApplied.current = true; return }
        const template = listedInitial ?? fetchedInitial.data
        if (!template || dsSchemaLoading) return
        autoApplied.current = true
        updateFormData(libraryTemplateUpdate(template))
    }, [
        initialTemplateId, imported, formData.contextModelId, listedInitial, fetchedInitial.data,
        dsSchemaLoading, updateFormData, libraryTemplateUpdate,
    ])

    // How the template this view started from fits this data — derived, so it
    // reads the same however the step is reached, until it is dismissed.
    const appliedTemplate = formData.contextModelId
        ? library.find(t => t.id === formData.contextModelId)
            ?? (fetchedInitial.data?.id === formData.contextModelId ? fetchedInitial.data : undefined)
        : undefined
    const appliedFit = useMemo(
        () => appliedTemplate && dismissedFitFor !== appliedTemplate.id
            ? { name: appliedTemplate.name, fit: fitTemplate(appliedTemplate.layers, declaredTypes) }
            : null,
        [appliedTemplate, dismissedFitFor, declaredTypes],
    )
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
            {savingAsTemplate && (
                <SaveAsTemplateDialog
                    sourceName={formData.name.trim() || 'New view'}
                    description={formData.description}
                    layers={formData.layers}
                    onClose={() => setSavingAsTemplate(false)}
                />
            )}
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
                                {!showGallery && formData.layers.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setSavingAsTemplate(true)}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        <Save className="w-4 h-4" />
                                        Save as template
                                    </button>
                                )}
                                {!showGallery && !imported && (
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

                        {imported && (
                            <div className="flex items-start gap-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 px-4 py-3">
                                <Layers className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
                                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                                    <span className="font-semibold text-slate-800 dark:text-slate-100">These layers came from the file.</span>{' '}
                                    Rename, reorder or add layers freely; removing a layer also unplaces what was placed on it.
                                </p>
                            </div>
                        )}

                        {/* Quick Start: what the data suggests, then the template library —
                            shared by both creation flows */}
                        {showGallery && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="p-4 space-y-6 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800"
                            >
                                {(suggestedTemplates.length > 0 || (!blank && dsSchemaLoading)) && (
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <Wand2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                            <span className="font-semibold text-slate-800 dark:text-slate-200">Suggested for your data</span>
                                        </div>
                                        <TemplateGallery
                                            templates={suggestedTemplates}
                                            activeId={formData.layoutTemplateId}
                                            loading={!blank && dsSchemaLoading}
                                            onApply={handleApplyGalleryTemplate}
                                        />
                                    </div>
                                )}
                                <div>
                                    <div className="flex flex-wrap items-center gap-2 mb-3">
                                        <LayoutTemplate className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                        <span className="font-semibold text-slate-800 dark:text-slate-200">Template library</span>
                                        <span className="text-xs text-slate-500">Yours, your teams' and your organization's</span>
                                        <div className="relative ml-auto">
                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                            <input
                                                type="search"
                                                value={libraryQuery}
                                                onChange={e => setLibraryQuery(e.target.value)}
                                                placeholder="Search templates"
                                                aria-label="Search templates"
                                                className="h-8 w-52 pl-8 pr-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                                            />
                                        </div>
                                    </div>
                                    {libraryTabs.length > 1 && (
                                        <div role="tablist" aria-label="Template collections" className="flex flex-wrap gap-1 mb-3">
                                            {libraryTabs.map(tab => (
                                                <button
                                                    key={tab.id}
                                                    type="button"
                                                    role="tab"
                                                    aria-selected={libraryTab === tab.id}
                                                    onClick={() => setLibraryTab(tab.id)}
                                                    className={cn(
                                                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                                                        libraryTab === tab.id
                                                            ? 'bg-indigo-600 text-white'
                                                            : 'text-slate-600 dark:text-slate-300 hover:bg-white/70 dark:hover:bg-slate-800',
                                                    )}
                                                >
                                                    {tab.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <TemplateGallery
                                        templates={libraryTemplates}
                                        activeId={formData.layoutTemplateId}
                                        loading={libraryLoading || (!blank && dsSchemaLoading)}
                                        onApply={item => {
                                            const template = library.find(t => t.id === item.id)
                                            if (template) handleApplyLibraryTemplate(template)
                                        }}
                                    />
                                    {!libraryLoading && !(!blank && dsSchemaLoading) && libraryTemplates.length === 0 && (
                                        <p className="text-xs text-slate-500 py-2">
                                            {libraryQuery ? `No template matches "${libraryQuery}".` : 'No templates in this collection yet.'}
                                        </p>
                                    )}
                                </div>
                            </motion.div>
                        )}

                        {/* How a library template fit this data's semantic layer — say what
                            didn't match instead of leaving columns silently empty. */}
                        {appliedFit && showLayerList && (
                            appliedFit.fit.unmatchedTypes.length > 0 ? (
                                <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3">
                                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex-1">
                                        <span className="font-semibold text-slate-800 dark:text-slate-100">
                                            "{appliedFit.name}" matches {appliedFit.fit.matchedLayers} of {appliedFit.fit.typedLayers} layers to this data.
                                        </span>{' '}
                                        Not in its semantic layer: {appliedFit.fit.unmatchedTypes.join(', ')}. Pick types for those layers below, or place entities in them by hand.
                                    </p>
                                    <button type="button" onClick={() => setDismissedFitFor(formData.contextModelId ?? null)} aria-label="Dismiss" className="p-0.5 rounded text-slate-400 hover:text-slate-600">
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ) : (
                                <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 px-4 py-3">
                                    <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex-1">
                                        <span className="font-semibold text-slate-800 dark:text-slate-100">Started from "{appliedFit.name}".</span>{' '}
                                        {appliedFit.fit.typedLayers > 0
                                            ? 'Every layer matched this data\'s semantic layer. Refine them below.'
                                            : 'Its layers are filled by hand: place entities in them on the next step.'}
                                    </p>
                                    <button type="button" onClick={() => setDismissedFitFor(formData.contextModelId ?? null)} aria-label="Dismiss" className="p-0.5 rounded text-slate-400 hover:text-slate-600">
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )
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
