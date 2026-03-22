/**
 * AssetOnboardingWizard — Multi-step onboarding wizard that follows the ViewWizard pattern.
 * Triggered after registering catalog items in RegistryAssets.
 * Steps: Workspace Allocation → Aggregation Strategy → Semantic Layer → Review & Confirm.
 *
 * Architecture mirrors ViewWizard.tsx: centralized formData, canProceed via useMemo,
 * spring animations, AnimatePresence step transitions, previousSteps stack.
 */
import { useState, useMemo, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Database, Settings, BookOpen, Check, ChevronLeft, ChevronRight, Loader2, X, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceService } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import type { ProviderResponse } from '@/services/providerService'
import { useWorkspacesStore } from '@/store/workspaces'

import { WorkspaceStep } from './steps/WorkspaceStep'
import { AggregationStep } from './steps/AggregationStep'
import { SemanticStep } from './steps/SemanticStep'
import { ReviewStep } from './steps/ReviewStep'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OnboardingFormData {
    allocations: Record<string, {
        workspaceId: string      // '' = unselected, 'new' = create new
        newWorkspaceName: string
        newWorkspaceDescription: string
    }>
    projectionMode: 'in_source' | 'dedicated'
    ontologySelections: Record<string, {
        ontologyId: string       // '' = unselected
        suggestedOntology: any | null
        coverageStats: any | null
    }>
}

type WizardStep = 'workspace' | 'aggregation' | 'semantic' | 'review'

interface AssetOnboardingWizardProps {
    provider: ProviderResponse
    catalogItems: CatalogItemResponse[]
    isOpen: boolean
    onComplete: () => void
    onClose: () => void
}

// ─── Step Config ──────────────────────────────────────────────────────────────

const STEPS: { id: WizardStep; title: string; icon: typeof Database }[] = [
    { id: 'workspace', title: 'Workspace', icon: Database },
    { id: 'aggregation', title: 'Aggregation', icon: Settings },
    { id: 'semantic', title: 'Semantic Layer', icon: BookOpen },
    { id: 'review', title: 'Review', icon: Check },
]

// ─── Component ────────────────────────────────────────────────────────────────

export function AssetOnboardingWizard({
    provider,
    catalogItems,
    isOpen,
    onComplete,
    onClose,
}: AssetOnboardingWizardProps) {
    const navigate = useNavigate()
    const { setActiveWorkspace, setActiveDataSource } = useWorkspacesStore()

    // ─── Form State ───────────────────────────────────────────────────────────
    const [formData, setFormData] = useState<OnboardingFormData>(() => ({
        allocations: Object.fromEntries(
            catalogItems.map(c => [c.id, { workspaceId: '', newWorkspaceName: '', newWorkspaceDescription: '' }])
        ),
        projectionMode: 'in_source',
        ontologySelections: Object.fromEntries(
            catalogItems.map(c => [c.id, { ontologyId: '', suggestedOntology: null, coverageStats: null }])
        ),
    }))

    // ─── Navigation State ─────────────────────────────────────────────────────
    const [currentStep, setCurrentStep] = useState<WizardStep>('workspace')
    const [previousSteps, setPreviousSteps] = useState<WizardStep[]>([])
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [wizardPhase, setWizardPhase] = useState<'steps' | 'success'>('steps')

    // Track created workspace/ds IDs for success screen navigation
    const [createdContext, setCreatedContext] = useState<{ wsId: string; dsId: string } | null>(null)

    // Workspace + ontology name maps for ReviewStep display
    const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({})
    const [ontologyNames, _setOntologyNames] = useState<Record<string, string>>({})

    // Reset state when wizard opens
    useEffect(() => {
        if (isOpen) {
            setCurrentStep('workspace')
            setPreviousSteps([])
            setIsSubmitting(false)
            setWizardPhase('steps')
            setCreatedContext(null)
            setFormData({
                allocations: Object.fromEntries(
                    catalogItems.map(c => [c.id, { workspaceId: '', newWorkspaceName: '', newWorkspaceDescription: '' }])
                ),
                projectionMode: 'in_source',
                ontologySelections: Object.fromEntries(
                    catalogItems.map(c => [c.id, { ontologyId: '', suggestedOntology: null, coverageStats: null }])
                ),
            })
        }
    }, [isOpen, catalogItems])

    // ─── Form Data Update ─────────────────────────────────────────────────────
    const updateFormData = useCallback((updates: Partial<OnboardingFormData>) => {
        setFormData(prev => ({ ...prev, ...updates }))
    }, [])

    // ─── Validation ───────────────────────────────────────────────────────────
    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'workspace':
                return Object.values(formData.allocations).every(a =>
                    a.workspaceId !== '' && (a.workspaceId !== 'new' || a.newWorkspaceName.trim().length > 0)
                )
            case 'aggregation':
                return true // default 'in_source' always selected
            case 'semantic':
                // At minimum the primary ontology must be set; per-item overrides are optional
                return Object.values(formData.ontologySelections).some(s => s.ontologyId !== '')
            case 'review':
                return true
        }
    }, [currentStep, formData])

    // ─── Navigation ───────────────────────────────────────────────────────────
    const currentStepIndex = STEPS.findIndex(s => s.id === currentStep)

    const goNext = useCallback(() => {
        if (!canProceed) return
        const nextIndex = currentStepIndex + 1
        if (nextIndex < STEPS.length) {
            setPreviousSteps(prev => [...prev, currentStep])
            setCurrentStep(STEPS[nextIndex].id)
        }
    }, [canProceed, currentStepIndex, currentStep])

    const goBack = useCallback(() => {
        if (previousSteps.length > 0) {
            const prev = previousSteps[previousSteps.length - 1]
            setPreviousSteps(ps => ps.slice(0, -1))
            setCurrentStep(prev)
        }
    }, [previousSteps])

    const goToStep = useCallback((stepId: WizardStep) => {
        const targetIndex = STEPS.findIndex(s => s.id === stepId)
        if (targetIndex < currentStepIndex) {
            setPreviousSteps(prev => prev.slice(0, targetIndex))
            setCurrentStep(stepId)
        }
    }, [currentStepIndex])

    // ─── Submit ───────────────────────────────────────────────────────────────
    // Registration + workspace allocation happen atomically here (not before).
    // If the user cancels the wizard, nothing is persisted.
    const handleSubmit = useCallback(async () => {
        setIsSubmitting(true)
        try {
            // Step 1: Register catalog items (idempotent — backend returns existing if duplicate)
            const realCatalogItems: CatalogItemResponse[] = await Promise.all(
                catalogItems.map(placeholder =>
                    catalogService.create({
                        providerId: provider.id,
                        sourceIdentifier: placeholder.sourceIdentifier || placeholder.name,
                        name: placeholder.name,
                        permittedWorkspaces: ['*'],
                    })
                )
            )

            // Build a map from placeholder id → real catalog item
            const placeholderToReal = new Map<string, CatalogItemResponse>()
            catalogItems.forEach((placeholder, i) => {
                placeholderToReal.set(placeholder.id, realCatalogItems[i])
            })

            // Step 2: Group real catalog items by workspace destination
            const groups = new Map<string, { items: CatalogItemResponse[]; placeholderIds: string[]; alloc: typeof formData.allocations[string] }>()
            for (const placeholder of catalogItems) {
                const alloc = formData.allocations[placeholder.id]
                const real = placeholderToReal.get(placeholder.id)!
                const key = alloc.workspaceId === 'new' ? `new:${alloc.newWorkspaceName}` : alloc.workspaceId
                if (!groups.has(key)) groups.set(key, { items: [], placeholderIds: [], alloc })
                const group = groups.get(key)!
                group.items.push(real)
                group.placeholderIds.push(placeholder.id)
            }

            let firstWsId = ''
            let firstDsId = ''
            const wsNameMap: Record<string, string> = {}

            // Step 3: Create workspaces / add data sources
            for (const [key, group] of groups) {
                const isNew = key.startsWith('new:')
                let wsId: string

                if (isNew) {
                    const ws = await workspaceService.create({
                        name: group.alloc.newWorkspaceName.trim(),
                        description: group.alloc.newWorkspaceDescription.trim() || undefined,
                        dataSources: group.items.map((c, i) => ({
                            catalogItemId: c.id,
                            ontologyId: formData.ontologySelections[group.placeholderIds[i]]?.ontologyId || undefined,
                            label: c.name || c.sourceIdentifier || undefined,
                        })),
                    })
                    wsId = ws.id
                    wsNameMap[wsId] = ws.name
                    if (!firstWsId) {
                        firstWsId = ws.id
                        firstDsId = ws.dataSources[0]?.id || ''
                    }
                    if (formData.projectionMode === 'dedicated') {
                        for (const ds of ws.dataSources) {
                            await workspaceService.setProjectionMode(wsId, ds.id, 'dedicated')
                        }
                    }
                } else {
                    wsId = group.alloc.workspaceId
                    for (let i = 0; i < group.items.length; i++) {
                        const c = group.items[i]
                        const placeholderId = group.placeholderIds[i]
                        const ds = await workspaceService.addDataSource(wsId, {
                            catalogItemId: c.id,
                            ontologyId: formData.ontologySelections[placeholderId]?.ontologyId || undefined,
                            label: c.name || c.sourceIdentifier || undefined,
                        })
                        if (!firstWsId) {
                            firstWsId = wsId
                            firstDsId = ds.id
                        }
                        if (formData.projectionMode === 'dedicated') {
                            await workspaceService.setProjectionMode(wsId, ds.id, 'dedicated')
                        }
                    }
                }
            }

            setCreatedContext({ wsId: firstWsId, dsId: firstDsId })
            setWorkspaceNames(wsNameMap)
            setWizardPhase('success')
        } catch (err) {
            console.error('Onboarding failed:', err)
            // Stay on review step — user can retry
        } finally {
            setIsSubmitting(false)
        }
    }, [catalogItems, formData, provider.id])

    // ─── Success Navigation ───────────────────────────────────────────────────
    const handleNavigate = useCallback((destination: 'explore' | 'create-view' | 'configure-more') => {
        if (createdContext) {
            setActiveWorkspace(createdContext.wsId)
            setActiveDataSource(createdContext.dsId)
        }
        onComplete()
        switch (destination) {
            case 'explore':
                navigate(`/schema?workspaceId=${createdContext?.wsId}&dataSourceId=${createdContext?.dsId}`)
                break
            case 'create-view':
                navigate(`/explorer?workspace=${createdContext?.wsId}`)
                break
            case 'configure-more':
                navigate('/admin/registry?tab=assets')
                break
        }
    }, [createdContext, navigate, onComplete, setActiveWorkspace, setActiveDataSource])

    // ─── Render ───────────────────────────────────────────────────────────────
    if (!isOpen) return null

    const isLast = currentStepIndex === STEPS.length - 1

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 20 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="w-full max-w-3xl mx-4 bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl flex flex-col max-h-[85vh]"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border shrink-0">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                                <Wand2 className="w-5 h-5 text-indigo-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-ink">Asset Onboarding</h2>
                                <p className="text-sm text-ink-muted mt-0.5">
                                    {catalogItems.length} data source{catalogItems.length !== 1 ? 's' : ''} from {provider.name}
                                </p>
                            </div>
                        </div>
                        {wizardPhase === 'steps' && (
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                title="Cancel onboarding"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        )}
                    </div>

                    {/* Step Progress — following ViewWizard pattern */}
                    {wizardPhase === 'steps' && (
                        <div className="px-6 py-3 border-b border-glass-border flex items-center gap-2 shrink-0">
                            {STEPS.map((step, i) => {
                                const StepIcon = step.icon
                                const isComplete = i < currentStepIndex
                                const isCurrent = i === currentStepIndex
                                return (
                                    <div key={step.id} className="flex items-center gap-2">
                                        {i > 0 && (
                                            <div className={cn(
                                                "w-8 h-0.5 rounded-full",
                                                isComplete ? "bg-emerald-500" : "bg-glass-border"
                                            )} />
                                        )}
                                        <button
                                            onClick={() => isComplete ? goToStep(step.id) : undefined}
                                            disabled={!isComplete}
                                            className={cn(
                                                "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                                                isComplete
                                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 cursor-pointer hover:bg-emerald-500/20"
                                                    : isCurrent
                                                        ? "bg-indigo-500 text-white shadow-md shadow-indigo-500/25"
                                                        : "bg-black/5 dark:bg-white/5 text-ink-muted cursor-default"
                                            )}
                                        >
                                            {isComplete
                                                ? <Check className="w-3 h-3" />
                                                : <StepIcon className="w-3 h-3" />
                                            }
                                            <span className="hidden sm:inline">{step.title}</span>
                                        </button>
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {/* Content with step transitions */}
                    <div className="flex-1 overflow-y-auto px-6 py-5">
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={wizardPhase === 'success' ? 'success' : currentStep}
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                transition={{ duration: 0.2 }}
                            >
                                {wizardPhase === 'success' ? (
                                    <ReviewStep
                                        formData={formData}
                                        catalogItems={catalogItems}
                                        phase="success"
                                        onNavigate={handleNavigate}
                                        workspaceNames={workspaceNames}
                                        ontologyNames={ontologyNames}
                                    />
                                ) : currentStep === 'workspace' ? (
                                    <WorkspaceStep
                                        formData={formData}
                                        updateFormData={updateFormData}
                                        catalogItems={catalogItems}
                                    />
                                ) : currentStep === 'aggregation' ? (
                                    <AggregationStep
                                        formData={formData}
                                        updateFormData={updateFormData}
                                    />
                                ) : currentStep === 'semantic' ? (
                                    <SemanticStep
                                        formData={formData}
                                        updateFormData={updateFormData}
                                        catalogItems={catalogItems}
                                        providerId={provider.id}
                                    />
                                ) : currentStep === 'review' ? (
                                    <ReviewStep
                                        formData={formData}
                                        catalogItems={catalogItems}
                                        phase="review"
                                        onNavigate={handleNavigate}
                                        workspaceNames={workspaceNames}
                                        ontologyNames={ontologyNames}
                                    />
                                ) : null}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Footer — hidden during success phase */}
                    {wizardPhase === 'steps' && (
                        <div className="flex items-center justify-between px-6 py-4 border-t border-glass-border shrink-0">
                            {currentStepIndex > 0 ? (
                                <button
                                    onClick={goBack}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                    Back
                                </button>
                            ) : (
                                <button
                                    onClick={onClose}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                    Cancel
                                </button>
                            )}

                            <button
                                onClick={isLast ? handleSubmit : goNext}
                                disabled={!canProceed || isSubmitting}
                                className={cn(
                                    "flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all",
                                    isLast
                                        ? "bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/30 disabled:opacity-50"
                                        : canProceed
                                            ? "bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20"
                                            : "bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed"
                                )}
                            >
                                {isSubmitting ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" /> Setting up...</>
                                ) : isLast ? (
                                    <><Check className="w-4 h-4" /> Complete Setup</>
                                ) : (
                                    <>Next <ChevronRight className="w-4 h-4" /></>
                                )}
                            </button>
                        </div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}

export default AssetOnboardingWizard
