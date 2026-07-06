/**
 * ViewWizard — three-layer architecture with decoupled scope selection.
 *
 *   ViewWizard              – public shell, gates on isOpen only.
 *
 *   ViewWizardScopeResolver – resolves (workspaceId, dataSourceId) for
 *                             the scope the wizard must operate under.
 *
 *                             Edit mode:  reads from useViewMetadata (unchanged).
 *                             Create mode: interactive ScopeStep lets user pick
 *                                          workspace + data source WITHOUT
 *                                          switching the global context.
 *
 *                             Then mounts <SchemaScope> for that scope.
 *
 *   ViewWizardBody          – schema guaranteed loaded for the resolved scope.
 *                             May freely read useSchemaStore.
 *
 *   WizardShell             – shared modal chrome (header, stepper, footer)
 *                             used by both the scope phase and body phase.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef, startTransition } from 'react'
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
    Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { viewService } from '@/services/viewService'
import { viewToViewConfig, updateViewLayout } from '@/services/viewApiService'
import { provisionBlankGraph, type BlankGraphResult } from '@/services/versioningApiService'
import type { ProviderResponse } from '@/services/providerService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { SchemaScope } from '@/components/schema/SchemaScope'
import { OntologyDriftBanner, hasOntologyDrifted } from '@/components/schema/OntologyDriftBanner'
import { useViewMetadata, useViewFull, type ViewMetadata } from '@/hooks/useViewMetadata'
import { useWizardScope } from '@/hooks/useWizardScope'
import { normalizeReferenceLayout, deriveEntityScope } from '@/utils/referenceLayout'
import type { ViewConfiguration, ViewLayerConfig, LayerAssignmentEntry, ScopeEdgeConfig, FieldFilter } from '@/types/schema'
import { useBlankScopeOptions } from './useBlankScopeOptions'
import { useBlankSchemaHydration } from './useBlankSchemaHydration'
import { ontologyToWorkspaceSchema, slugifyGraphName, GRAPH_NAME_RE } from './blankModel'

import { BasicsStep } from './steps/BasicsStep'
import { LayoutStep } from './steps/LayoutStep'
import { EntitiesStep } from './steps/EntitiesStep'
import { PreviewStep } from './steps/PreviewStep'
import { AssignmentStep } from './steps/AssignmentStep'
import { ScopeStep } from './steps/ScopeStep'

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
    /** Optional pre-selected scope (e.g. from a data source card). */
    initialWorkspaceId?: string
    initialDataSourceId?: string
}

export interface ScopeContext {
    workspaceId: string
    workspaceName: string
    dataSourceId: string
    dataSourceLabel: string
    hasOntology: boolean
    /** Blank-model scope: no data source yet — provider + ontology chosen instead. */
    isBlank?: boolean
    providerName?: string
    ontologyName?: string
}

/** Which scope the create wizard is building for. */
export type ScopeMode = 'existing' | 'blank'

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
    /** Canonical flattened physical-root-urn -> layer assignment map — the same
     *  shape the canvas writes via persistReferenceLayout. Never embedded back
     *  into `layers[].entityAssignments` (legacy, deprecated). */
    assignments: Record<string, LayerAssignmentEntry>
    visibleEntityTypes: string[]
    visibleRelationshipTypes: string[]
    advancedFilters: ActiveFilter[]
    scopeEdges?: ScopeEdgeConfig
    isValid: boolean
    /** Blank models only: the user-chosen PHYSICAL FalkorDB graph name.
     *  Undefined = auto-derived from `name` (slugified) until the user edits it. */
    graphName?: string
    /** Blank models only: last known availability of the (derived or edited)
     *  graph name — false blocks Next on Basics; server re-validates at submit. */
    graphNameAvailable?: boolean
    /** Blank models only: the Quick Start template the user picked on Layout.
     *  Undefined until an explicit choice is made — gates Next in blank mode. */
    layoutTemplateId?: string
}

type WizardStep = 'scope' | 'basics' | 'layout' | 'assignment' | 'entities' | 'preview'

interface StepDef {
    id: WizardStep
    label: string
    icon: React.ReactNode
}

interface ViewWizardBodyProps extends Omit<ViewWizardProps, 'initialWorkspaceId' | 'initialDataSourceId'> {
    resolvedWorkspaceId: string
    resolvedDataSourceId: string | null
    viewMetadata: ViewMetadata | null
    scopeContext: ScopeContext
    onBackToScope?: () => void
    /** Create-mode scope kind (defaults to 'existing'). Blank skips entities/assignment. */
    scopeMode?: ScopeMode
    /** Blank mode: provider + ontology to provision against on submit. */
    blankProviderId?: string | null
    blankOntologyId?: string | null
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
        label: 'Context View',
        icon: <LayoutTemplate className="w-8 h-8" />,
        description: 'Horizontal layer columns',
        features: ['Layer-based organization', 'Rule-driven entity assignment', 'Best for data pipelines'],
        recommended: true,
    },
]

// ============================================
// WizardShell — shared modal chrome
// ============================================

interface WizardShellProps {
    mode: 'create' | 'edit'
    currentStep: WizardStep
    activeSteps: StepDef[]
    currentStepIndex: number
    onStepClick: (stepId: WizardStep) => void
    onBack: () => void
    onNext: () => void
    onClose: () => void
    canProceed: boolean
    isLastStep: boolean
    isSubmitting: boolean
    onSubmit: () => void
    children: React.ReactNode
}

function WizardShell({
    mode,
    currentStep,
    activeSteps,
    currentStepIndex,
    onStepClick,
    onBack,
    onNext,
    onClose,
    canProceed,
    isLastStep,
    isSubmitting,
    onSubmit,
    children,
}: WizardShellProps) {
    const isWide = currentStep === 'scope' || currentStep === 'assignment'

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ duration: 0.12 }}
                className={cn(
                    'relative w-full max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-lg overflow-hidden flex flex-col',
                    isWide ? 'max-w-[1180px]' : 'max-w-5xl',
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-md">
                            {activeSteps[currentStepIndex]?.icon}
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                                {mode === 'create' ? 'Create New View' : 'Edit View'}
                            </h2>
                            <p className="text-sm text-slate-500">
                                Step {currentStepIndex + 1} of {activeSteps.length}: {activeSteps[currentStepIndex]?.label}
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

                {/* Progress Steps — overflow-proof: connectors flex instead of fixed
                    widths, pills can shrink with truncating labels, and non-active
                    labels drop out below lg so all six steps always fit the modal. */}
                <div className="px-8 py-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                    <div className="flex items-center min-w-0">
                        {activeSteps.map((step, index) => {
                            const isActive = step.id === currentStep
                            const isCompleted = currentStepIndex > index
                            const isClickable = isCompleted || isActive
                            return (
                                <div key={step.id} className={cn('flex items-center min-w-0', index < activeSteps.length - 1 && 'flex-1')}>
                                    <button
                                        onClick={() => isClickable && onStepClick(step.id)}
                                        disabled={!isClickable}
                                        title={step.label}
                                        className={cn(
                                            'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-150 min-w-0 shrink',
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
                                        <span className={cn('truncate', !isActive && 'hidden lg:inline')}>
                                            {step.label}
                                        </span>
                                    </button>
                                    {index < activeSteps.length - 1 && (
                                        <div className="flex-1 min-w-2 h-px bg-slate-200 dark:bg-slate-700 mx-2" />
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>

                {/* Step Content */}
                <div className="flex-1 overflow-y-auto min-h-[520px]">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={currentStep}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.06 }}
                            className="p-8"
                        >
                            {children}
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-8 py-5 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                    <button
                        onClick={onBack}
                        disabled={currentStepIndex === 0}
                        className={cn(
                            'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-colors duration-150',
                            currentStepIndex > 0
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
                            className="px-5 py-2.5 rounded-xl font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors duration-150"
                        >
                            Cancel
                        </button>

                        {isLastStep ? (
                            <button
                                onClick={onSubmit}
                                disabled={!canProceed || isSubmitting}
                                className={cn(
                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    canProceed && !isSubmitting
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md'
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
                                onClick={onNext}
                                disabled={!canProceed}
                                className={cn(
                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-colors duration-150',
                                    canProceed
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md'
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
// Inline loading / error shells
// ============================================

function WizardLoadingShell({ label, onClose }: { label: string; onClose?: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
            <div className="relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-lg flex flex-col items-center justify-center py-24 gap-4">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
            <div className="relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-lg flex flex-col items-center justify-center py-24 gap-4">
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

/** localStorage key for remembering last-used wizard scope */
const WIZARD_SCOPE_KEY = 'synodic-wizard-last-scope'

function readLastScope(): { wsId?: string; dsId?: string } {
    try {
        const raw = localStorage.getItem(WIZARD_SCOPE_KEY)
        return raw ? JSON.parse(raw) : {}
    } catch {
        return {}
    }
}

function saveLastScope(wsId: string, dsId: string) {
    try {
        localStorage.setItem(WIZARD_SCOPE_KEY, JSON.stringify({ wsId, dsId }))
    } catch { /* noop */ }
}

function ViewWizardScopeResolver(props: ViewWizardProps) {
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)

    // Refresh workspace list when wizard opens so newly onboarded sources appear
    useEffect(() => {
        if (props.isOpen) {
            loadWorkspaces()
        }
    }, [props.isOpen, loadWorkspaces])

    // ── Edit mode — unchanged ──────────────────────────────────
    if (props.mode === 'edit' && props.viewId) {
        return <ViewWizardEditResolver {...props} />
    }

    // ── Create mode — interactive scope selection ──────────────
    return (
        <ViewWizardCreateResolver
            {...props}
            activeWorkspaceId={activeWorkspaceId}
            activeDataSourceId={activeDataSourceId}
            workspaces={workspaces}
        />
    )
}

/** Edit mode resolver — resolves scope from the view's own metadata. */
function ViewWizardEditResolver(props: ViewWizardProps) {
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const meta = useViewMetadata(props.viewId!)

    // Resolve dataSourceId from the view itself. For legacy views without an
    // explicit dataSourceId, fall back to the view's workspace's primary data
    // source — NOT the active workspace's data source.
    // Hook must be called before any early returns (Rules of Hooks).
    const resolvedDs = useMemo(() => {
        if (!meta.data) return null
        if (meta.data.dataSourceId) return meta.data.dataSourceId
        const ws = workspaces.find(w => w.id === meta.data.workspaceId)
        const primaryDs = ws?.dataSources?.find(ds => ds.isPrimary) ?? ws?.dataSources?.[0]
        return primaryDs?.id ?? null
    }, [meta.data, workspaces])

    if (meta.isLoading) {
        return <WizardLoadingShell label="Loading view\u2026" onClose={props.onClose} />
    }
    if (meta.isError || !meta.data) {
        return <WizardErrorShell error={meta.error instanceof Error ? meta.error : null} onClose={props.onClose} />
    }

    const resolvedWs = meta.data.workspaceId
    const scopeContext = buildScopeContext(workspaces, resolvedWs, resolvedDs)

    return (
        <SchemaScope
            workspaceId={resolvedWs}
            dataSourceId={resolvedDs}
            loadingLabel="Loading ontology\u2026"
            fallback={<WizardLoadingShell label="Loading ontology\u2026" onClose={props.onClose} />}
        >
            <ViewWizardBody
                {...props}
                resolvedWorkspaceId={resolvedWs}
                resolvedDataSourceId={resolvedDs}
                viewMetadata={meta.data}
                scopeContext={scopeContext}
            />
        </SchemaScope>
    )
}

/** Create mode resolver — two-phase: ScopeStep then SchemaScope + Body. */
function ViewWizardCreateResolver(props: ViewWizardProps & {
    activeWorkspaceId: string | null
    activeDataSourceId: string | null
    workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces']
}) {
    const { activeWorkspaceId, activeDataSourceId, workspaces, ...wizardProps } = props
    const lastScope = useMemo(() => readLastScope(), [])

    // Determine initial selections: explicit props > active context > last used
    const initialWs = props.initialWorkspaceId ?? activeWorkspaceId ?? lastScope.wsId ?? null
    const initialDs = props.initialDataSourceId
        ?? (initialWs === activeWorkspaceId ? activeDataSourceId : null)
        ?? (initialWs === lastScope.wsId ? lastScope.dsId : null)
        ?? null

    const [selectedWsId, setSelectedWsId] = useState<string | null>(initialWs)
    const [selectedDsId, setSelectedDsId] = useState<string | null>(initialDs)
    const [scopeMode, setScopeMode] = useState<ScopeMode>('existing')
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
    const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)
    const [scopeConfirmed, setScopeConfirmed] = useState(false)

    // Fetch stats + probe schema while scope step is visible (existing mode)
    const probeScope = selectedWsId && selectedDsId
        ? { workspaceId: selectedWsId, dataSourceId: selectedDsId }
        : null
    const scopeData = useWizardScope(!scopeConfirmed, probeScope)

    // Blank-mode pickers: FalkorDB providers + published semantic layers.
    const blankOptions = useBlankScopeOptions(selectedWsId)
    const chosenProvider = useMemo(
        () => blankOptions.providers.find(o => o.provider.id === selectedProviderId)?.provider ?? null,
        [blankOptions.providers, selectedProviderId],
    )
    const chosenOntology = useMemo(
        () => blankOptions.ontologies.find(o => o.id === selectedOntologyId) ?? null,
        [blankOptions.ontologies, selectedOntologyId],
    )

    // Reset on wizard reopen
    useEffect(() => {
        if (props.isOpen) {
            setSelectedWsId(initialWs)
            setSelectedDsId(initialDs)
            setScopeMode('existing')
            setSelectedProviderId(null)
            setSelectedOntologyId(null)
            setScopeConfirmed(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.isOpen])

    // Clear the downstream selections when workspace changes
    const handleSelectWorkspace = useCallback((wsId: string) => {
        setSelectedWsId(prev => {
            if (prev !== wsId) {
                setSelectedDsId(null)
                setSelectedProviderId(null)
                setSelectedOntologyId(null)
            }
            return wsId
        })
    }, [])

    const handleSelectDataSource = useCallback((dsId: string) => {
        setSelectedDsId(dsId)
    }, [])

    const handleScopeConfirm = useCallback(() => {
        if (scopeMode === 'existing') {
            if (selectedWsId && selectedDsId) {
                saveLastScope(selectedWsId, selectedDsId)
                setScopeConfirmed(true)
            }
        } else if (selectedWsId && selectedProviderId && selectedOntologyId) {
            setScopeConfirmed(true)
        }
    }, [scopeMode, selectedWsId, selectedDsId, selectedProviderId, selectedOntologyId])

    const handleBackToScope = useCallback(() => {
        setScopeConfirmed(false)
    }, [])

    const scopeContext = useMemo(
        () => scopeMode === 'blank'
            ? buildBlankScopeContext(workspaces, selectedWsId, chosenProvider, chosenOntology)
            : buildScopeContext(workspaces, selectedWsId, selectedDsId),
        [scopeMode, workspaces, selectedWsId, selectedDsId, chosenProvider, chosenOntology],
    )

    // Derive the blank model's schema from the chosen ontology and hydrate the
    // schema store for the blank body's lifetime (no SchemaScope). Starting
    // layers are chosen explicitly on the Layout step, not pre-filled here.
    const blankSchema = useMemo(
        () => chosenOntology ? ontologyToWorkspaceSchema(chosenOntology) : null,
        [chosenOntology],
    )
    const blankActive = scopeConfirmed && scopeMode === 'blank'
    const blankReady = useBlankSchemaHydration(blankActive ? blankSchema : null, selectedWsId)

    // ── Build step list for create mode (blank skips entities + assignment) ──
    const allSteps: StepDef[] = useMemo(() => {
        const steps: StepDef[] = [
            { id: 'scope', label: 'Scope', icon: <Database className="w-4 h-4" /> },
            { id: 'basics', label: 'Basics', icon: <Sparkles className="w-4 h-4" /> },
            { id: 'layout', label: 'Layout', icon: <LayoutTemplate className="w-4 h-4" /> },
        ]
        if (scopeMode !== 'blank') {
            // assignment is added dynamically by ViewWizardBody
            steps.push({ id: 'entities', label: 'Entities', icon: <Network className="w-4 h-4" /> })
        }
        steps.push({ id: 'preview', label: 'Preview', icon: <Eye className="w-4 h-4" /> })
        return steps
    }, [scopeMode])

    // ── Phase A: ScopeStep (no SchemaScope yet) ────────────────
    if (!scopeConfirmed) {
        const canProceed = scopeMode === 'existing'
            ? !!(selectedWsId && selectedDsId)
            : !!(selectedWsId && selectedProviderId && selectedOntologyId)

        return (
            <WizardShell
                mode="create"
                currentStep="scope"
                activeSteps={allSteps}
                currentStepIndex={0}
                onStepClick={() => {}}
                onBack={() => {}}
                onNext={handleScopeConfirm}
                onClose={props.onClose}
                canProceed={canProceed}
                isLastStep={false}
                isSubmitting={false}
                onSubmit={() => {}}
            >
                <ScopeStep
                    scopeMode={scopeMode}
                    onScopeModeChange={setScopeMode}
                    availableWorkspaces={scopeData.workspaces}
                    schemaAvailability={scopeData.schemaAvailability}
                    selectedWorkspaceId={selectedWsId}
                    selectedDataSourceId={selectedDsId}
                    activeWorkspaceId={activeWorkspaceId}
                    onSelectWorkspace={handleSelectWorkspace}
                    onSelectDataSource={handleSelectDataSource}
                    providers={blankOptions.providers}
                    ontologies={blankOptions.ontologies}
                    blankOptionsLoading={blankOptions.isLoading}
                    selectedProviderId={selectedProviderId}
                    selectedOntologyId={selectedOntologyId}
                    onSelectProvider={setSelectedProviderId}
                    onSelectOntology={setSelectedOntologyId}
                />
            </WizardShell>
        )
    }

    // ── Phase B (blank): hydrate the schema store, no SchemaScope ──
    if (scopeMode === 'blank') {
        if (!blankReady) {
            return <WizardLoadingShell label="Preparing blank model…" onClose={props.onClose} />
        }
        return (
            <ViewWizardBody
                {...wizardProps}
                resolvedWorkspaceId={selectedWsId!}
                resolvedDataSourceId={null}
                viewMetadata={null}
                scopeContext={scopeContext}
                onBackToScope={handleBackToScope}
                scopeMode="blank"
                blankProviderId={selectedProviderId}
                blankOntologyId={selectedOntologyId}
            />
        )
    }

    // ── Phase B: SchemaScope + ViewWizardBody ──────────────────
    return (
        <SchemaScope
            workspaceId={selectedWsId!}
            dataSourceId={selectedDsId}
            loadingLabel="Loading ontology\u2026"
            fallback={<WizardLoadingShell label="Loading ontology\u2026" onClose={props.onClose} />}
        >
            <ViewWizardBody
                {...wizardProps}
                resolvedWorkspaceId={selectedWsId!}
                resolvedDataSourceId={selectedDsId}
                viewMetadata={null}
                scopeContext={scopeContext}
                onBackToScope={handleBackToScope}
                scopeMode="existing"
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
    scopeContext,
    onBackToScope,
    scopeMode = 'existing',
    blankProviderId,
    blankOntologyId,
}: ViewWizardBodyProps) {
    const navigate = useNavigate()
    const schema = useSchemaStore(s => s.schema)
    const { clearSelection } = useCanvasStore()
    const { clearAssignments } = useReferenceModelStore()
    const isBlank = scopeMode === 'blank'

    // Blank provisioning result — held so a failed createView retry reuses the
    // same data source instead of provisioning a duplicate.
    const provisionRef = useRef<BlankGraphResult | null>(null)
    const [provisionError, setProvisionError] = useState<string | null>(null)

    // Create-mode initial form: layers start empty for both existing and blank
    // scopes — blank models choose their starting layers via a template on Layout.
    const makeCreateFormData = useCallback((): WizardFormData => {
        const base = getInitialFormData(schema)
        return {
            ...base,
            dataSourceId: resolvedDataSourceId ?? undefined,
        }
    }, [schema, resolvedDataSourceId])

    const fullViewQuery = useViewFull(mode === 'edit' ? viewId : null)
    const editingView = useMemo(() => {
        if (mode !== 'edit' || !fullViewQuery.data) return null
        return viewToViewConfig(fullViewQuery.data)
    }, [mode, fullViewQuery.data])

    const [currentStep, setCurrentStep] = useState<WizardStep>('basics')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [previousSteps, setPreviousSteps] = useState<WizardStep[]>([])
    const [driftDismissed, setDriftDismissed] = useState(false)

    const [formData, setFormData] = useState<WizardFormData>(makeCreateFormData)

    // Hydrate form from view in edit mode. normalizeReferenceLayout up-converts
    // legacy per-layer entityAssignments/rules into the flattened assignments
    // map, so canvas-created layer placements (canonical or legacy) become
    // visible in the wizard here.
    useEffect(() => {
        if (mode === 'edit' && editingView) {
            const { layers, assignments } = normalizeReferenceLayout(editingView.layout?.referenceLayout)
            setFormData({
                name: editingView.name,
                description: editingView.description ?? '',
                icon: editingView.icon ?? 'Layout',
                visibility: (editingView as any).visibility ?? (editingView.isPublic ? 'enterprise' : 'private'),
                tags: (editingView as any).tags ?? [],
                dataSourceId: editingView.dataSourceId ?? undefined,
                layoutType: editingView.layout.type as 'graph' | 'hierarchy' | 'reference',
                layers,
                assignments,
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
                scopeEdges: layers[0]?.scopeEdges,
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
                setFormData(makeCreateFormData())
            }
        } else {
            clearAssignments()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen])

    // Steps for the body phase (scope step is handled by the resolver)
    const activeSteps: StepDef[] = useMemo(() => {
        const steps: StepDef[] = []
        // In create mode, scope is step 0 (handled externally) — include it for the stepper
        if (mode === 'create') {
            steps.push({ id: 'scope', label: 'Scope', icon: <Database className="w-4 h-4" /> })
        }
        steps.push(
            { id: 'basics', label: 'Basics', icon: <Sparkles className="w-4 h-4" /> },
            { id: 'layout', label: 'Layout', icon: <LayoutTemplate className="w-4 h-4" /> },
        )
        // Blank models skip per-entity scoping + rule assignment — the ontology
        // defines the whole graph and the derived layers are the starting point.
        if (!isBlank) {
            if (formData.layoutType === 'reference') {
                steps.push({ id: 'assignment', label: 'Assignments', icon: <ClipboardList className="w-4 h-4" /> })
            }
            steps.push({ id: 'entities', label: 'Entities', icon: <Network className="w-4 h-4" /> })
        }
        steps.push({ id: 'preview', label: 'Preview', icon: <Eye className="w-4 h-4" /> })
        return steps
    }, [formData.layoutType, mode, isBlank])

    const currentStepIndex = activeSteps.findIndex(s => s.id === currentStep)
    const isLastStep = currentStepIndex === activeSteps.length - 1

    const canProceed = useMemo(() => {
        switch (currentStep) {
            case 'basics': {
                if (formData.name.trim().length === 0) return false
                if (isBlank) {
                    // The physical graph name must be shaped right and not known-taken
                    // (unknown availability passes — the server re-validates at submit).
                    const gname = formData.graphName ?? slugifyGraphName(formData.name)
                    return GRAPH_NAME_RE.test(gname) && formData.graphNameAvailable !== false
                }
                return true
            }
            case 'layout': {
                // Blank models must make an explicit Quick Start template choice
                // before proceeding (empty is a valid, explicit choice). Reference
                // layout is where templates/layers apply; other layouts pass through.
                if (isBlank && formData.layoutType === 'reference') {
                    return formData.layoutTemplateId !== undefined
                }
                return formData.layoutType !== undefined
            }
            case 'assignment': return true
            case 'entities': return formData.visibleEntityTypes.length > 0
            case 'preview': return true
            default: return false
        }
    }, [currentStep, formData])

    const handleNext = useCallback(() => {
        const idx = activeSteps.findIndex(s => s.id === currentStep)
        if (idx < activeSteps.length - 1) {
            // startTransition keeps the UI responsive while the next step
            // mounts (often 200-300 ms of synchronous work). The Next click
            // registers as instant; React renders the new step in the background.
            startTransition(() => {
                setPreviousSteps(prev => [...prev, currentStep])
                setCurrentStep(activeSteps[idx + 1].id)
            })
        }
    }, [currentStep, activeSteps])

    const handleBack = useCallback(() => {
        // If we're at the first body step in create mode, go back to scope
        if (currentStep === 'basics' && mode === 'create' && onBackToScope) {
            onBackToScope()
            return
        }
        if (previousSteps.length > 0) {
            const prev = previousSteps[previousSteps.length - 1]
            startTransition(() => {
                setPreviousSteps(p => p.slice(0, -1))
                setCurrentStep(prev)
            })
        }
    }, [previousSteps, currentStep, mode, onBackToScope])

    const handleStepClick = useCallback((stepId: WizardStep) => {
        // Clicking the scope step in create mode goes back to scope
        if (stepId === 'scope' && mode === 'create' && onBackToScope) {
            onBackToScope()
            return
        }
        const currentIndex = activeSteps.findIndex(s => s.id === currentStep)
        const targetIndex = activeSteps.findIndex(s => s.id === stepId)
        if (targetIndex <= currentIndex && targetIndex !== -1) {
            startTransition(() => {
                setCurrentStep(stepId)
            })
        }
    }, [currentStep, activeSteps, mode, onBackToScope])

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
        setProvisionError(null)
        try {
            const layersWithScope = formData.layers.map(l => ({ ...l, scopeEdges: formData.scopeEdges }))
            // Canonical-clean: strips any stray legacy entityAssignments and merges
            // them into the flattened map so nothing is silently lost.
            const normalizedLayout = normalizeReferenceLayout({ layers: layersWithScope, assignments: formData.assignments })
            const fieldFilters = buildFieldFilters(formData.advancedFilters)

            if (mode === 'create') {
                let dataSourceId = resolvedDataSourceId ?? undefined
                if (isBlank) {
                    // Provision the blank model (data source + genesis graph). Reuse a
                    // prior result on retry so a failed createView never duplicates it.
                    let provisioned = provisionRef.current
                    if (!provisioned) {
                        try {
                            provisioned = await provisionBlankGraph(resolvedWorkspaceId, {
                                name: formData.name,
                                description: formData.description || undefined,
                                providerId: blankProviderId!,
                                ontologyId: blankOntologyId!,
                                // Always name the physical graph — the user's edit, or the
                                // slug of the model name. The server validates authoritatively
                                // (a 422 lands in the provisionError banner).
                                graphName: formData.graphName ?? slugifyGraphName(formData.name),
                            })
                            provisionRef.current = provisioned
                        } catch (err) {
                            setProvisionError(err instanceof Error ? err.message : 'Could not create the blank model. Please try again.')
                            return
                        }
                    }
                    dataSourceId = provisioned.dataSourceId
                    // The workspaces store is the app's cache of each workspace's data
                    // sources (ViewPage's health check and the view execution context
                    // both read it). It was loaded before this data source existed —
                    // refresh it or the new view opens onto a false "data source has
                    // been deleted" overlay.
                    await useWorkspacesStore.getState().loadWorkspaces().catch(() => {})
                }
                const result = await viewService.createView({
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: normalizedLayout.layers,
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters,
                    workspaceId: resolvedWorkspaceId,
                    dataSourceId,
                    visibility: formData.visibility,
                    tags: formData.tags.length > 0 ? formData.tags : undefined,
                })
                if (result.success && result.data) {
                    // The layout endpoint is the single writer of referenceLayout — write
                    // the full layers+assignments (a new view has no prior layout to race).
                    const entityScope = deriveEntityScope(undefined, normalizedLayout)
                    try {
                        const layoutResult = await updateViewLayout(result.data.id, {
                            referenceLayout: { layers: normalizedLayout.layers, assignments: normalizedLayout.assignments },
                            entityScope,
                        })
                        const savedView = viewToViewConfig(layoutResult)
                        useSchemaStore.getState().addOrUpdateView(savedView)
                        onComplete?.(savedView)
                        onClose()
                        navigate(`/views/${result.data.id}`)
                    } catch (err) {
                        // The view itself was created; only its layout failed to save. Leave
                        // the modal open (isSubmitting resets below) so the user can retry
                        // rather than silently losing their layer/assignment edits.
                        console.error('[ViewWizard] updateViewLayout failed after create', err)
                    }
                }
            } else if (viewId) {
                const result = await viewService.updateView(viewId, {
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: normalizedLayout.layers,
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters,
                    visibility: formData.visibility,
                    tags: formData.tags.length > 0 ? formData.tags : undefined,
                }, fullViewQuery.data?.config)
                if (result.success && result.data) {
                    // Preserve an explicit editingView.content.entityScope; otherwise derive
                    // from the submitted assignments — a deliberate wizard save is allowed to
                    // set scope explicitly, unlike implicit canvas gestures.
                    const entityScope = deriveEntityScope(editingView?.content, normalizedLayout)
                    try {
                        const layoutResult = await updateViewLayout(viewId, {
                            referenceLayout: { layers: normalizedLayout.layers, assignments: normalizedLayout.assignments },
                            entityScope,
                        })
                        const savedView = viewToViewConfig(layoutResult)
                        useSchemaStore.getState().addOrUpdateView(savedView)
                        onComplete?.(savedView)
                        onClose()
                    } catch (err) {
                        // The rest of the view saved; only its layout failed. Leave the modal
                        // open (isSubmitting resets below) so the user can retry rather than
                        // silently losing their layer/assignment edits.
                        console.error('[ViewWizard] updateViewLayout failed after update', err)
                    }
                }
            }
        } finally {
            setIsSubmitting(false)
        }
    }, [mode, viewId, formData, resolvedWorkspaceId, resolvedDataSourceId, isBlank, blankProviderId, blankOntologyId, onComplete, onClose, navigate, buildFieldFilters, fullViewQuery.data, editingView])

    const updateFormData = useCallback((updates: Partial<WizardFormData>) => {
        setFormData(prev => ({ ...prev, ...updates }))
    }, [])

    // Ontology drift: view's stored digest vs current schema digest.
    const showDriftBanner =
        !driftDismissed &&
        hasOntologyDrifted(viewMetadata?.ontologyDigest, schema?.ontologyDigest)

    return (
        <WizardShell
            mode={mode}
            currentStep={currentStep}
            activeSteps={activeSteps}
            currentStepIndex={currentStepIndex}
            onStepClick={handleStepClick}
            onBack={handleBack}
            onNext={handleNext}
            onClose={onClose}
            canProceed={canProceed}
            isLastStep={isLastStep}
            isSubmitting={isSubmitting}
            onSubmit={handleSubmit}
        >
            {showDriftBanner && (
                <OntologyDriftBanner
                    viewDigest={viewMetadata?.ontologyDigest ?? null}
                    currentDigest={schema?.ontologyDigest ?? null}
                    onDismiss={() => setDriftDismissed(true)}
                    className="mb-6"
                />
            )}

            {provisionError && (
                <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-red-700 dark:text-red-300">Couldn't create the blank model</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{provisionError}</p>
                    </div>
                </div>
            )}

            {currentStep === 'basics' && (
                <BasicsStep
                    formData={formData}
                    updateFormData={updateFormData}
                    mode={mode}
                    scopeContext={scopeContext}
                    onChangeScope={mode === 'create' ? onBackToScope : undefined}
                    blankNaming={isBlank && blankProviderId
                        ? { workspaceId: resolvedWorkspaceId, providerId: blankProviderId }
                        : undefined}
                />
            )}
            {currentStep === 'layout' && (
                <LayoutStep
                    formData={formData}
                    updateFormData={updateFormData}
                    layoutTypes={LAYOUT_TYPES}
                    dataSourceId={formData.dataSourceId}
                    blank={isBlank}
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
                    dataSourceId={formData.dataSourceId}
                />
            )}
            {currentStep === 'preview' && (
                <PreviewStep formData={formData} scopeContext={scopeContext} />
            )}
        </WizardShell>
    )
}

// ============================================
// Helpers
// ============================================

function buildScopeContext(
    workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces'],
    wsId: string | null,
    dsId: string | null,
): ScopeContext {
    const ws = workspaces.find(w => w.id === wsId)
    const ds = ws?.dataSources?.find(d => d.id === dsId)
    return {
        workspaceId: wsId ?? '',
        workspaceName: ws?.name ?? 'Unknown',
        dataSourceId: dsId ?? '',
        dataSourceLabel: ds?.label || ds?.catalogItemId || 'Data Source',
        hasOntology: !!ds?.ontologyId,
    }
}

/** Blank-model scope context — no data source yet, so surface the chosen provider + ontology. */
function buildBlankScopeContext(
    workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces'],
    wsId: string | null,
    provider: ProviderResponse | null,
    ontology: OntologyDefinitionResponse | null,
): ScopeContext {
    const ws = workspaces.find(w => w.id === wsId)
    return {
        workspaceId: wsId ?? '',
        workspaceName: ws?.name ?? 'Unknown',
        dataSourceId: '',
        dataSourceLabel: ontology?.name ?? 'Blank model',
        hasOntology: true,
        isBlank: true,
        providerName: provider?.name,
        ontologyName: ontology?.name,
    }
}

function getInitialFormData(schema: ReturnType<typeof useSchemaStore.getState>['schema']): WizardFormData {
    return {
        name: '',
        description: '',
        icon: 'Layout',
        visibility: 'private',
        tags: [],
        layoutType: 'reference',
        layers: [],
        assignments: {},
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
