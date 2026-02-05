/**
 * ViewWizard - Modern, intuitive wizard for creating and editing views
 * 
 * Features:
 * - Step-by-step guided flow
 * - Beautiful animations and transitions
 * - Smart defaults and suggestions
 * - Real-time preview
 * - Works for both CREATE and EDIT modes
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react'
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
    ClipboardList
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { viewService } from '@/services/viewService'
import type { ViewConfiguration, ViewLayerConfig, ScopeEdgeConfig } from '@/types/schema'

// Import step components
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
}

export interface ActiveFilter {
    id: string
    type: 'tag' | 'name' | 'property'
    label: string
    value: any
}

export interface WizardFormData {
    // Step 1: Basics
    name: string
    description: string
    icon: string

    // Step 2: Layout Type
    layoutType: 'graph' | 'hierarchy' | 'reference'
    layers: ViewLayerConfig[]

    // Step 3: Entities
    visibleEntityTypes: string[]
    visibleRelationshipTypes: string[]

    // Advanced Filtering (New)
    advancedFilters: ActiveFilter[]

    // Hierarchy Scope (New)
    scopeEdges?: ScopeEdgeConfig

    // Computed
    isValid: boolean
}

type WizardStep = 'basics' | 'layout' | 'assignment' | 'entities' | 'preview'



const LAYOUT_TYPES = [
    {
        id: 'graph' as const,
        label: 'Graph',
        icon: <Network className="w-8 h-8" />,
        description: 'Force-directed or DAG layout',
        features: ['Flexible node positioning', 'Multiple layout algorithms', 'Best for exploring relationships']
    },
    {
        id: 'hierarchy' as const,
        label: 'Hierarchy',
        icon: <ListTree className="w-8 h-8" />,
        description: 'Nested tree view',
        features: ['Clear parent-child structure', 'Expandable/collapsible nodes', 'Best for organizational charts']
    },
    {
        id: 'reference' as const,
        label: 'Reference Model',
        icon: <LayoutTemplate className="w-8 h-8" />,
        description: 'Horizontal layer columns',
        features: ['Layer-based organization', 'Rule-driven entity assignment', 'Best for data pipelines'],
        recommended: true
    }
]

// ============================================
// Main Component
// ============================================

export function ViewWizard({ mode, viewId, isOpen, onClose, onComplete }: ViewWizardProps) {
    const schema = useSchemaStore(s => s.schema)
    const { clearSelection } = useCanvasStore()
    const { clearAssignments, setLayers } = useReferenceModelStore()

    // Current step
    const [currentStep, setCurrentStep] = useState<WizardStep>('basics')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [previousSteps, setPreviousSteps] = useState<WizardStep[]>([])

    // Form data
    const [formData, setFormData] = useState<WizardFormData>(() => getInitialFormData(schema))

    // Load existing view for edit mode
    useEffect(() => {
        if (mode === 'edit' && viewId && schema) {
            const existingView = schema.views.find(v => v.id === viewId)
            if (existingView) {
                setFormData({
                    name: existingView.name,
                    description: existingView.description ?? '',
                    icon: existingView.icon ?? 'Layout',
                    layoutType: existingView.layout.type as 'graph' | 'hierarchy' | 'reference',
                    layers: existingView.layout.referenceLayout?.layers ?? [],
                    visibleEntityTypes: existingView.content.visibleEntityTypes,
                    visibleRelationshipTypes: existingView.content.visibleRelationshipTypes,
                    advancedFilters: (existingView.filters.fieldFilters || []).map(f => ({
                        id: `${f.field}-${Date.now()}-${Math.random()}`,
                        type: f.field === 'tags' ? 'tag' : f.field === 'name' ? 'name' : 'property',
                        label: f.field === 'tags' ? `Tag: ${f.value}` : f.field === 'name' ? `Name contains "${f.value}"` : `${f.field}=${f.value}`,
                        value: f.value
                    })),
                    scopeEdges: existingView.layout.referenceLayout?.layers?.[0]?.scopeEdges, // Simplified for now, usually per layer but can be globalized
                    isValid: true
                })
            }
        }
    }, [mode, viewId, schema])

    // Dynamic steps based on layout
    const activeSteps = useMemo(() => {
        const baseSteps: { id: WizardStep; label: string; icon: React.ReactNode }[] = [
            { id: 'basics', label: 'Basics', icon: <Sparkles className="w-4 h-4" /> },
            { id: 'layout', label: 'Layout', icon: <LayoutTemplate className="w-4 h-4" /> }
        ]

        if (formData.layoutType === 'reference') {
            baseSteps.push({ id: 'assignment' as const, label: 'Assignments', icon: <ClipboardList className="w-4 h-4" /> })
        }

        return [
            ...baseSteps,
            { id: 'entities' as const, label: 'Entities', icon: <Network className="w-4 h-4" /> },
            { id: 'preview' as const, label: 'Preview', icon: <Eye className="w-4 h-4" /> }
        ]
    }, [formData.layoutType])

    // Reset on open
    useEffect(() => {
        if (isOpen) {
            setCurrentStep('basics')
            setPreviousSteps([])
            clearSelection()

            // Always clear store assignments on opening wizard to avoid stale leakage
            clearAssignments()

            if (mode === 'create') {
                setFormData(getInitialFormData(schema))
            }
        }
    }, [isOpen, mode, schema, clearSelection, clearAssignments])

    // Step validation
    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'basics':
                return formData.name.trim().length > 0
            case 'layout':
                return formData.layoutType !== undefined
            case 'assignment':
                return true
            case 'entities':
                return formData.visibleEntityTypes.length > 0
            case 'preview':
                return true
            default:
                return false
        }
    }, [currentStep, formData])

    // Navigation
    const handleNext = useCallback(() => {
        const stepIndex = activeSteps.findIndex(s => s.id === currentStep)
        if (stepIndex < activeSteps.length - 1) {
            setPreviousSteps(prev => [...prev, currentStep])
            setCurrentStep(activeSteps[stepIndex + 1].id)
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

        // Can only go back or stay on current
        if (targetIndex <= currentIndex && targetIndex !== -1) {
            setCurrentStep(stepId)
        }
    }, [currentStep, activeSteps])

    // Submit
    const handleSubmit = useCallback(async () => {
        setIsSubmitting(true)
        try {
            if (mode === 'create') {
                const result = await viewService.createView({
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: formData.layers.map(l => ({ ...l, scopeEdges: formData.scopeEdges })), // Apply scope to all layers
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters: formData.advancedFilters.map(af => ({
                        field: af.type === 'tag' ? 'tags' : af.type === 'name' ? 'name' : af.type === 'property' ? String(af.value).split('=')[0] : 'property',
                        operator: af.type === 'name' ? 'contains' : 'equals',
                        value: af.type === 'property' && String(af.value).includes('=') ? String(af.value).split('=')[1] : af.value
                    }))
                })
                if (result.success && result.data) {
                    // Sync layers to referenceModelStore after saving
                    const savedLayers = result.data.layout?.referenceLayout?.layers
                    if (savedLayers && savedLayers.length > 0) {
                        setLayers(savedLayers)
                    }
                    onComplete?.(result.data)
                    onClose()
                }
            } else if (viewId) {
                const result = await viewService.updateView(viewId, {
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: formData.layers.map(l => ({ ...l, scopeEdges: formData.scopeEdges })), // Apply scope to all layers
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters: formData.advancedFilters.map(af => ({
                        field: af.type === 'tag' ? 'tags' : af.type === 'name' ? 'name' : af.type === 'property' ? String(af.value).split('=')[0] : 'property',
                        operator: af.type === 'name' ? 'contains' : 'equals',
                        value: af.type === 'property' && String(af.value).includes('=') ? String(af.value).split('=')[1] : af.value
                    }))
                })
                if (result.success && result.data) {
                    // Sync layers to referenceModelStore after saving
                    const savedLayers = result.data.layout?.referenceLayout?.layers
                    if (savedLayers && savedLayers.length > 0) {
                        setLayers(savedLayers)
                    }
                    onComplete?.(result.data)
                    onClose()
                }
            }
        } finally {
            setIsSubmitting(false)
        }
    }, [mode, viewId, formData, onComplete, onClose])

    // Update form data
    const updateFormData = useCallback((updates: Partial<WizardFormData>) => {
        setFormData(prev => ({ ...prev, ...updates }))
    }, [])

    if (!isOpen) return null

    const currentStepIndex = activeSteps.findIndex(s => s.id === currentStep)
    const isLastStep = currentStepIndex === activeSteps.length - 1

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
                className="relative w-full max-w-4xl max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
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
                    <div className="flex items-center justify-between max-w-2xl mx-auto">
                        {/* Steps Indicator */}
                        <div className="flex items-center gap-2">
                            {activeSteps.map((step, index) => {
                                const isActive = step.id === currentStep
                                const isCompleted = activeSteps.findIndex(s => s.id === currentStep) > index
                                const isClickable = isCompleted || isActive

                                return (
                                    <div key={step.id} className="flex items-center">
                                        <button
                                            onClick={() => isClickable && handleStepClick(step.id)}
                                            disabled={!isClickable}
                                            className={cn(
                                                "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all",
                                                isActive
                                                    ? "bg-blue-600 text-white shadow-md ring-2 ring-blue-100 dark:ring-blue-900"
                                                    : isCompleted
                                                        ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
                                                        : "text-slate-400 cursor-not-allowed"
                                            )}
                                        >
                                            {isCompleted ? (
                                                <Check className="w-4 h-4" />
                                            ) : (
                                                <span className={cn("w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-bold border",
                                                    isActive ? "border-transparent bg-white/20" : "border-slate-300"
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
                            {currentStep === 'basics' && (
                                <BasicsStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                    mode={mode}
                                />
                            )}
                            {currentStep === 'layout' && (
                                <LayoutStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                    layoutTypes={LAYOUT_TYPES}
                                />
                            )}
                            {currentStep === 'assignment' && (
                                <AssignmentStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                />
                            )}
                            {currentStep === 'entities' && (
                                <EntitiesStep
                                    formData={formData}
                                    updateFormData={updateFormData}
                                />
                            )}
                            {currentStep === 'preview' && (
                                <PreviewStep
                                    formData={formData}
                                />
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
                                : 'text-slate-400 cursor-not-allowed'
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
                                        : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
                                )}
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Save className="w-4 h-4" />
                                        {mode === 'create' ? 'Create View' : 'Save Changes'}
                                    </>
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
                                        : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
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
        layoutType: 'reference',
        layers: [],
        visibleEntityTypes: schema?.entityTypes.map(e => e.id) ?? [],
        visibleRelationshipTypes: schema?.relationshipTypes.map(r => r.id) ?? [],
        advancedFilters: [],
        scopeEdges: {
            edgeTypes: schema?.containmentEdgeTypes ?? [],
            includeAll: false
        },
        isValid: false
    }
}

export default ViewWizard
