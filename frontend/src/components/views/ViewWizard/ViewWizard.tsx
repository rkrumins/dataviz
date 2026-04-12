/**
 * ViewWizard — three-layer architecture that solves the bootstrapping
 * chicken-egg problem in the original single-component design.
 *
 *   ViewWizard              – public shell, gates on isOpen only.
 *
 *   ViewWizardScopeResolver – Phase 1: resolves (workspaceId, dataSourceId)
 *                             for the scope the wizard must operate under.
 *                             In edit mode this comes from the view row via
 *                             useViewMetadata — no schema store is touched.
 *                             Then mounts <SchemaScope> for that scope.
 *
 *   ViewWizardBody          – Phase 2: schema guaranteed loaded for the
 *                             resolved scope. May freely read useSchemaStore.
 *                             Fetches the full view via useViewFull (shares
 *                             the same React Query cache entry as
 *                             useViewMetadata — one HTTP call per wizard open).
 *
 * Why this fixes the original bug: the old code did
 *   schema.views.find(v => v.id === viewId)
 * which required schema to be loaded before we knew which scope to load
 * the schema for. ViewWizardScopeResolver breaks that cycle.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    X,
    ArrowRight,
    ArrowLeft,
    Check,
    Sparkles,
    Network,
    ListTree,
    LayoutTemplate,
    Save,
    Eye,
    Loader2,
    ClipboardList,
    AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewService } from '@/services/viewService'
import { viewToViewConfig } from '@/services/viewApiService'
import { SchemaScope } from '@/components/schema/SchemaScope'
import { OntologyDriftBanner, hasOntologyDrifted } from '@/components/schema/OntologyDriftBanner'
import { useViewMetadata, useViewFull, type ViewMetadata } from '@/hooks/useViewMetadata'
import type { ViewConfiguration, ViewLayerConfig, ScopeEdgeConfig, FieldFilter } from '@/types/schema'

import { BasicsStep } from './steps/BasicsStep'
import { LayoutStep } from './steps/LayoutStep'
import { EntitiesStep } from './steps/EntitiesStep'
import { PreviewStep } from './steps/PreviewStep'
import { AssignmentStep } from './steps/AssignmentStep'

// ============================================
// Types
// ============================================

export interface ViewWizardProps {
    mode: 'create' | 'edit'
    viewId?: string
    isOpen: boolean
    onClose: () => void
    onComplete?: (view: ViewConfiguration) => void
    dataSourceId?: string
}

export interface ActiveFilter {
    id: string
    type: 'tag' | 'name' | 'property'
    label: string
    value: any
}

export interface WizardFormData {
    name: string
    description: string
    icon: string
    visibility: 'private' | 'workspace' | 'enterprise'
    tags: string[]
    dataSourceId?: string
    layoutType: 'graph' | 'hierarchy' | 'reference'
    layers: ViewLayerConfig[]
    visibleEntityTypes: string[]
    visibleRelationshipTypes: string[]
    advancedFilters: ActiveFilter[]
    scopeEdges?: ScopeEdgeConfig
    isValid: boolean
}

type WizardStep = 'basics' | 'layout' | 'assignment' | 'entities' | 'preview'

interface ViewWizardBodyProps extends ViewWizardProps {
    /** Resolved workspace for this wizard session (view's ws in edit, active ws in create). */
    resolvedWorkspaceId: string
    /** Resolved data source for this wizard session. */
    resolvedDataSourceId: string | null
    /** Metadata fetched in phase 1 — null in create mode. */
    viewMetadata: ViewMetadata | null
}

const LAYOUT_TYPES = [
    {
        id: 'graph' as const,
        label: 'Graph',
        icon: <Network className="w-8 h-8" />,
        description: 'Force-directed or DAG layout',
        features: ['Flexible node positioning', 'Multiple layout algorithms', 'Best for exploring relationships'],
    },
    {
        id: 'hierarchy' as const,
        label: 'Hierarchy',
        icon: <ListTree className="w-8 h-8" />,
        description: 'Nested tree view',
        features: ['Clear parent-child structure', 'Expandable/collapsible nodes', 'Best for organizational charts'],
    },
    {
        id: 'reference' as const,
        label: 'Reference Model',
        icon: <LayoutTemplate className="w-8 h-8" />,
        description: 'Horizontal layer columns',
        features: ['Layer-based organization', 'Rule-driven entity assignment', 'Best for data pipelines'],
        recommended: true,
    },
]

// ============================================
// Inline loading / error shells (used before schema is ready)
// ============================================

function WizardLoadingShell({ label, onClose }: { label: string; onClose?: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl flex flex-col items-center justify-center py-24 gap-4">
                {onClose && (
                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                        <X className="w-5 h-5 text-slate-500" />
                    </button>
                )}
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                <p className="text-sm text-slate-500">{label}</p>
            </div>
        </div>
    )
}

function WizardErrorShell({ error, onClose }: { error?: Error | null; onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl flex flex-col items-center justify-center py-24 gap-4">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                    <X className="w-5 h-5 text-slate-500" />
                </button>
                <AlertCircle className="w-8 h-8 text-red-500" />
                <p className="text-sm font-medium text-slate-800 dark:text-white">Failed to load view</p>
                {error && (
                    <p className="text-xs text-slate-500 max-w-sm text-center">{error.message}</p>
                )}
                <button
                    onClick={onClose}
                    className="mt-2 px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-sm font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                    Close
                </button>
            </div>
        </div>
    )
}

// ============================================
// Phase 0 — Public shell
// ============================================

export function ViewWizard(props: ViewWizardProps) {
    if (!props.isOpen) return null
    return <ViewWizardScopeResolver {...props} />
}

// ============================================
// Phase 1 — Scope resolution
// ============================================

function ViewWizardScopeResolver(props: ViewWizardProps) {
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)

    if (props.mode === 'edit' && props.viewId) {
        // Fetch just the scope fields — no schema store involved.
        const meta = useViewMetadata(props.viewId)

        if (meta.isLoading) {
            return <WizardLoadingShell label="Loading view…" onClose={props.onClose} />
        }
        if (meta.isError || !meta.data) {
            return <WizardErrorShell error={meta.error instanceof Error ? meta.error : null} onClose={props.onClose} />
        }

        const resolvedWs = meta.data.workspaceId
        const resolvedDs = meta.data.dataSourceId ?? activeDataSourceId ?? null

        return (
            <SchemaScope
                workspaceId={resolvedWs}
                dataSourceId={resolvedDs}
                loadingLabel="Loading ontology…"
                fallback={<WizardLoadingShell label="Loading ontology…" onClose={props.onClose} />}
            >
                <ViewWizardBody
                    {...props}
                    resolvedWorkspaceId={resolvedWs}
                    resolvedDataSourceId={resolvedDs}
                    viewMetadata={meta.data}
                />
            </SchemaScope>
        )
    }

    // Create mode — use active workspace/dataSource.
    const resolvedWs = activeWorkspaceId ?? ''
    const resolvedDs = props.dataSourceId ?? activeDataSourceId ?? null

    return (
        <SchemaScope
            workspaceId={resolvedWs}
            dataSourceId={resolvedDs}
            loadingLabel="Loading ontology…"
            fallback={<WizardLoadingShell label="Loading ontology…" onClose={props.onClose} />}
        >
            <ViewWizardBody
                {...props}
                resolvedWorkspaceId={resolvedWs}
                resolvedDataSourceId={resolvedDs}
                viewMetadata={null}
            />
        </SchemaScope>
    )
}

// ============================================
// Phase 2 — Wizard body (schema guaranteed loaded)
// ============================================

function ViewWizardBody({
    mode,
    viewId,
    isOpen,
    onClose,
    onComplete,
    resolvedWorkspaceId,
    resolvedDataSourceId,
    viewMetadata,
}: ViewWizardBodyProps) {
    const navigate = useNavigate()
    const schema = useSchemaStore(s => s.schema)
    const { clearSelection } = useCanvasStore()
    const { clearAssignments, setLayers } = useReferenceModelStore()

    // Fetch the full view config in edit mode. Shares ['view', viewId] cache
    // entry with useViewMetadata — one HTTP call per wizard open regardless
    // of how many consumers mount.
    const fullViewQuery = useViewFull(mode === 'edit' ? viewId : null)
    const editingView = useMemo(() => {
        if (mode !== 'edit' || !fullViewQuery.data) return null
        return viewToViewConfig(fullViewQuery.data)
    }, [mode, fullViewQuery.data])

    const [currentStep, setCurrentStep] = useState<WizardStep>('basics')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [previousSteps, setPreviousSteps] = useState<WizardStep[]>([])
    const [linkedContextModelId, setLinkedContextModelId] = useState<string | null>(null)
    const [driftDismissed, setDriftDismissed] = useState(false)

    const [formData, setFormData] = useState<WizardFormData>(() => ({
        ...getInitialFormData(schema),
        dataSourceId: resolvedDataSourceId ?? undefined,
    }))

    // Hydrate form from view in edit mode.
    useEffect(() => {
        if (mode === 'edit' && editingView) {
            setFormData({
                name: editingView.name,
                description: editingView.description ?? '',
                icon: editingView.icon ?? 'Layout',
                visibility: (editingView as any).visibility ?? (editingView.isPublic ? 'enterprise' : 'private'),
                tags: (editingView as any).tags ?? [],
                dataSourceId: editingView.dataSourceId ?? undefined,
                layoutType: editingView.layout.type as 'graph' | 'hierarchy' | 'reference',
                layers: editingView.layout.referenceLayout?.layers ?? [],
                visibleEntityTypes: editingView.content.visibleEntityTypes,
                visibleRelationshipTypes: editingView.content.visibleRelationshipTypes,
                advancedFilters: (editingView.filters.fieldFilters || []).map(f => ({
                    id: `${f.field}-${Date.now()}-${Math.random()}`,
                    type: f.field === 'tags' ? 'tag' : f.field === 'name' ? 'name' : 'property',
                    label: f.field === 'tags'
                        ? `Tag: ${f.value}`
                        : f.field === 'name'
                            ? `Name contains "${f.value}"`
                            : `${f.field}=${f.value}`,
                    value: f.value,
                })),
                scopeEdges: editingView.layout.referenceLayout?.layers?.[0]?.scopeEdges,
                isValid: true,
            })
        }
    }, [mode, editingView])

    // Reset on open / close.
    useEffect(() => {
        if (isOpen) {
            setCurrentStep('basics')
            setPreviousSteps([])
            setDriftDismissed(false)
            clearSelection()
            clearAssignments()
            if (mode === 'create') {
                setFormData({
                    ...getInitialFormData(schema),
                    dataSourceId: resolvedDataSourceId ?? undefined,
                })
            }
        } else {
            clearAssignments()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen])

    const activeSteps = useMemo(() => {
        const base: { id: WizardStep; label: string; icon: React.ReactNode }[] = [
            { id: 'basics', label: 'Basics', icon: <Sparkles className="w-4 h-4" /> },
            { id: 'layout', label: 'Layout', icon: <LayoutTemplate className="w-4 h-4" /> },
        ]
        if (formData.layoutType === 'reference') {
            base.push({ id: 'assignment', label: 'Assignments', icon: <ClipboardList className="w-4 h-4" /> })
        }
        return [
            ...base,
            { id: 'entities' as WizardStep, label: 'Entities', icon: <Network className="w-4 h-4" /> },
            { id: 'preview' as WizardStep, label: 'Preview', icon: <Eye className="w-4 h-4" /> },
        ]
    }, [formData.layoutType])

    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'basics': return formData.name.trim().length > 0
            case 'layout': return formData.layoutType !== undefined
            case 'assignment': return true
            case 'entities': return formData.visibleEntityTypes.length > 0
            case 'preview': return true
            default: return false
        }
    }, [currentStep, formData])

    const handleNext = useCallback(() => {
        const idx = activeSteps.findIndex(s => s.id === currentStep)
        if (idx < activeSteps.length - 1) {
            setPreviousSteps(prev => [...prev, currentStep])
            setCurrentStep(activeSteps[idx + 1].id)
        }
    }, [currentStep, activeSteps])

    const handleBack = useCallback(() => {
        if (previousSteps.length > 0) {
            const prev = previousSteps[previousSteps.length - 1]
            setPreviousSteps(p => p.slice(0, -1))
            setCurrentStep(prev)
        }
    }, [previousSteps])

    const handleStepClick = useCallback((stepId: WizardStep) => {
        const currentIndex = activeSteps.findIndex(s => s.id === currentStep)
        const targetIndex = activeSteps.findIndex(s => s.id === stepId)
        if (targetIndex <= currentIndex && targetIndex !== -1) {
            setCurrentStep(stepId)
        }
    }, [currentStep, activeSteps])

    const buildFieldFilters = useCallback((filters: ActiveFilter[]): FieldFilter[] => {
        return filters.map(af => ({
            field: af.type === 'tag' ? 'tags' : af.type === 'name' ? 'name' : String(af.value).split('=')[0],
            operator: (af.type === 'name' ? 'contains' : 'equals') as FieldFilter['operator'],
            value: af.type === 'property' && String(af.value).includes('=')
                ? String(af.value).split('=')[1]
                : af.value,
        }))
    }, [])

    const handleSubmit = useCallback(async () => {
        setIsSubmitting(true)
        try {
            const layersWithScope = formData.layers.map(l => ({ ...l, scopeEdges: formData.scopeEdges }))
            const fieldFilters = buildFieldFilters(formData.advancedFilters)

            if (mode === 'create') {
                const result = await viewService.createView({
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: layersWithScope,
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters,
                    workspaceId: resolvedWorkspaceId,
                    dataSourceId: resolvedDataSourceId ?? undefined,
                    contextModelId: linkedContextModelId ?? undefined,
                    visibility: formData.visibility,
                    tags: formData.tags.length > 0 ? formData.tags : undefined,
                })
                if (result.success && result.data) {
                    const savedLayers = result.data.layout?.referenceLayout?.layers
                    if (savedLayers?.length) setLayers(savedLayers)
                    onComplete?.(result.data)
                    onClose()
                    navigate(`/views/${result.data.id}`)
                }
            } else if (viewId) {
                const result = await viewService.updateView(viewId, {
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: layersWithScope,
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters,
                    visibility: formData.visibility,
                    tags: formData.tags.length > 0 ? formData.tags : undefined,
                })
                if (result.success && result.data) {
                    const savedLayers = result.data.layout?.referenceLayout?.layers
                    if (savedLayers?.length) setLayers(savedLayers)
                    onComplete?.(result.data)
                    onClose()
                }
            }
        } finally {
            setIsSubmitting(false)
        }
    }, [mode, viewId, formData, resolvedWorkspaceId, resolvedDataSourceId, onComplete, onClose, navigate, setLayers, buildFieldFilters, linkedContextModelId])

    const updateFormData = useCallback((updates: Partial<WizardFormData>) => {
        setFormData(prev => ({ ...prev, ...updates }))
    }, [])

    const currentStepIndex = activeSteps.findIndex(s => s.id === currentStep)
    const isLastStep = currentStepIndex === activeSteps.length - 1

    // Ontology drift: view's stored digest vs current schema digest.
    const showDriftBanner =
        !driftDismissed &&
        hasOntologyDrifted(viewMetadata?.ontologyDigest, schema?.ontologyDigest)

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className={cn(
                    'relative w-full max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col',
                    currentStep === 'assignment' ? 'max-w-[1180px]' : 'max-w-4xl',
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/25">
                            {activeSteps[currentStepIndex].icon}
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                                {mode === 'create' ? 'Create New View' : 'Edit View'}
                            </h2>
                            <p className="text-sm text-slate-500">
                                Step {currentStepIndex + 1} of {activeSteps.length}: {activeSteps[currentStepIndex].label}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                        <X className="w-5 h-5 text-slate-500" />
                    </button>
                </div>

                {/* Progress Steps */}
                <div className="px-8 py-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2">
                        {activeSteps.map((step, index) => {
                            const isActive = step.id === currentStep
                            const isCompleted = currentStepIndex > index
                            const isClickable = isCompleted || isActive
                            return (
                                <div key={step.id} className="flex items-center">
                                    <button
                                        onClick={() => isClickable && handleStepClick(step.id)}
                                        disabled={!isClickable}
                                        className={cn(
                                            'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all',
                                            isActive
                                                ? 'bg-blue-600 text-white shadow-md ring-2 ring-blue-100 dark:ring-blue-900'
                                                : isCompleted
                                                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100'
                                                    : 'text-slate-400 cursor-not-allowed',
                                        )}
                                    >
                                        {isCompleted
                                            ? <Check className="w-4 h-4" />
                                            : (
                                                <span className={cn(
                                                    'w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border',
                                                    isActive ? 'border-transparent bg-white/20' : 'border-slate-300',
                                                )}>
                                                    {index + 1}
                                                </span>
                                            )}
                                        {step.label}
                                    </button>
                                    {index < activeSteps.length - 1 && (
                                        <div className="w-8 h-px bg-slate-200 dark:bg-slate-700 mx-2" />
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>

                {/* Step Content */}
                <div className="flex-1 overflow-y-auto">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={currentStep}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.2 }}
                            className="p-8"
                        >
                            {showDriftBanner && (
                                <OntologyDriftBanner
                                    viewDigest={viewMetadata?.ontologyDigest ?? null}
                                    currentDigest={schema?.ontologyDigest ?? null}
                                    onDismiss={() => setDriftDismissed(true)}
                                    className="mb-6"
                                />
                            )}

                            {currentStep === 'basics' && (
                                <BasicsStep formData={formData} updateFormData={updateFormData} mode={mode} />
                            )}
                            {currentStep === 'layout' && (
                                <LayoutStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                    layoutTypes={LAYOUT_TYPES}
                                    dataSourceId={formData.dataSourceId}
                                />
                            )}
                            {currentStep === 'assignment' && (
                                <AssignmentStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                    linkedContextModelId={linkedContextModelId}
                                    onDraftSaved={setLinkedContextModelId}
                                />
                            )}
                            {currentStep === 'entities' && (
                                <EntitiesStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                    dataSourceId={formData.dataSourceId}
                                />
                            )}
                            {currentStep === 'preview' && (
                                <PreviewStep formData={formData} />
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-8 py-5 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    <button
                        onClick={handleBack}
                        disabled={previousSteps.length === 0}
                        className={cn(
                            'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-all',
                            previousSteps.length > 0
                                ? 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                : 'text-slate-400 cursor-not-allowed',
                        )}
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back
                    </button>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={onClose}
                            className="px-5 py-2.5 rounded-xl font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                        >
                            Cancel
                        </button>

                        {isLastStep ? (
                            <button
                                onClick={handleSubmit}
                                disabled={!canProceed || isSubmitting}
                                className={cn(
                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-all',
                                    canProceed && !isSubmitting
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25'
                                        : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed',
                                )}
                            >
                                {isSubmitting ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" />Saving...</>
                                ) : (
                                    <><Save className="w-4 h-4" />{mode === 'create' ? 'Create View' : 'Save Changes'}</>
                                )}
                            </button>
                        ) : (
                            <button
                                onClick={handleNext}
                                disabled={!canProceed}
                                className={cn(
                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-all',
                                    canProceed
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25'
                                        : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed',
                                )}
                            >
                                Next
                                <ArrowRight className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>
            </motion.div>
        </motion.div>
    )
}

// ============================================
// Helpers
// ============================================

function getInitialFormData(schema: ReturnType<typeof useSchemaStore.getState>['schema']): WizardFormData {
    return {
        name: '',
        description: '',
        icon: 'Layout',
        visibility: 'private',
        tags: [],
        layoutType: 'reference',
        layers: [],
        visibleEntityTypes: schema?.entityTypes.map(e => e.id) ?? [],
        visibleRelationshipTypes: schema?.relationshipTypes.map(r => r.id) ?? [],
        advancedFilters: [],
        scopeEdges: {
            edgeTypes: schema?.containmentEdgeTypes ?? [],
            includeAll: false,
        },
        isValid: false,
    }
}

export default ViewWizard
