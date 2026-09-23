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
 *
 * The Import journey (a view from a file exported elsewhere) runs through the same
 * three layers: its File and Target steps belong to the scope phase, and its Match
 * step leads the body, whose Basics → Preview steps edit the imported design. The
 * submit writes it through the import endpoint instead of create/update.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef, startTransition } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    X,
    Sparkles,
    Network,
    ListTree,
    LayoutTemplate,
    Eye,
    Loader2,
    ClipboardList,
    AlertCircle,
    Database,
    History,
    FileUp,
    ListChecks,
} from 'lucide-react'
import { timeAgo } from '@/lib/timeAgo'
import { Backdrop } from '@/components/ui/Backdrop'
import { WizardShell } from '@/components/wizard/WizardShell'
import {
    CreationProgressBody,
    CreationSuccessBody,
    CreationBusyFooter,
    CreationErrorFooter,
    CreationSuccessFooter,
    useAutoOpenCountdown,
    type CreationStage,
    type CreationStageId,
    type CreationStageState,
    type CreationSummaryStat,
} from './CreationPhase'
import { useWizardDraft, draftKey } from './useWizardDraft'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useFeatureList } from '@/store/features'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { viewService } from '@/services/viewService'
import {
    viewToViewConfig, updateViewLayout, requestViewPublication, getView,
} from '@/services/viewApiService'
import {
    importView, newRequestId, ViewTransferError,
    type ImportViewRequest, type ImportViewResult,
} from '@/services/viewTransferApiService'
import { recordEvent } from '@/services/telemetryService'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePublishGate } from '@/hooks/usePublishGate'
import { provisionBlankGraph, GraphNameUnavailableError, type BlankGraphResult } from '@/services/versioningApiService'
import type { ProviderResponse } from '@/services/providerService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { SchemaScope } from '@/components/schema/SchemaScope'
import { OntologyDriftBanner, hasOntologyDrifted } from '@/components/schema/OntologyDriftBanner'
import { useViewMetadata, useViewFull, VIEW_QUERY_KEY, type ViewMetadata } from '@/hooks/useViewMetadata'
import { invalidateViewVersions } from '@/hooks/useViewVersions'
import { useWizardScope } from '@/hooks/useWizardScope'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'
import { resolveWizardEntityScope } from './effectivePlacement'
import type { ViewConfiguration, ViewLayerConfig, LayerAssignmentEntry, LayerNodeSortAlgo, ScopeEdgeConfig } from '@/types/schema'
import { useBlankScopeOptions } from './useBlankScopeOptions'
import { useBlankSchemaHydration } from './useBlankSchemaHydration'
import { ontologyToWorkspaceSchema, slugifyGraphName, GRAPH_NAME_RE } from './blankModel'

import { BasicsStep } from './steps/BasicsStep'
import { LayoutStep } from './steps/LayoutStep'
import { EntitiesStep } from './steps/EntitiesStep'
import { PreviewStep } from './steps/PreviewStep'
import { AssignmentStep } from './steps/AssignmentStep'
import { ScopeStep, ScopeModeToggle } from './steps/ScopeStep'
import { viewTypeLabel } from '@/lib/domainLabels'
import { ImportSessionProvider, useImportSession, useImportSessionState } from './import/importSession'
import { ImportStep } from './import/ImportStep'
import { ReconcileStep } from './import/ReconcileStep'
import { TargetSuggestions } from './import/TargetSuggestions'
import { ImportMetadataPanel } from './import/ImportMetadataPanel'
import { ImportResultNote, ImportSummaryCard } from './import/ImportSummaryCard'
import {
    activeFiltersToFieldFilters, definitionToForm, fieldFiltersToActiveFilters, formToDefinition,
    formToMetadata, isBuildable, sameJson, type Definition,
} from './import/importForm'
import { WizardEntitySeedContext, fallbackNameFromUrn, type EntityIdentity } from './useWizardEntityIndex'
import { sameResolutions } from '@/features/view-transfer/reconcile/resolutions'
import { percent } from '@/features/view-transfer/format'

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
    /** 'import' opens the Import journey: a view from a file exported by another environment. */
    journey?: 'build' | 'import'
    /** Import journey: a file already chosen (dropped on the Explorer, say). */
    importFile?: File | null
    /** Import journey: update this view from the file ("Update from file…"). */
    importIntoViewId?: string
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

/** Which scope the create wizard is building for — or, for 'import', where it comes from. */
export type ScopeMode = 'existing' | 'blank' | 'import'

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
    /** Optional note carried into the publication request when the creator
     *  picks Enterprise but can't publish themselves. */
    publishNote?: string
    tags: string[]
    dataSourceId?: string
    layoutType: 'graph' | 'hierarchy' | 'reference'
    layers: ViewLayerConfig[]
    /** Canonical flattened physical-root-urn -> layer assignment map — the same
     *  shape the canvas writes via persistReferenceLayout. Never embedded back
     *  into `layers[].entityAssignments` (legacy, deprecated). */
    assignments: Record<string, LayerAssignmentEntry>
    /** Explicit view entity scope, PINNED by a gesture that needs it rather than
     *  left to derivation. `deriveEntityScope` answers 'curated' as soon as ONE
     *  assignment exists — which would make a rule-driven layout (layers carrying
     *  `entityTypes`, e.g. "one layer per top-level type") collapse to just the
     *  entities someone happened to drag, because curated scope ignores rules for
     *  root nodes and hydration then loads assigned URNs only. Undefined = derive
     *  exactly as before. */
    entityScope?: 'all' | 'curated'
    /** View-wide default node sort ("apply to all columns"). A layer's own
     *  `nodeSortMode` still wins; absent = 'alpha-asc'. Carried here because
     *  `referenceLayout` stores it beside layers/assignments, not on a layer. */
    defaultNodeSortMode?: LayerNodeSortAlgo
    visibleEntityTypes: string[]
    visibleRelationshipTypes: string[]
    advancedFilters: ActiveFilter[]
    scopeEdges?: ScopeEdgeConfig
    isValid: boolean
    /** Blank models only: the PHYSICAL FalkorDB graph name the model is stored under.
     *  Kept populated by BasicsStep — auto-derived from `name` and auto-uniquified
     *  when that slug is already taken on the connection. */
    graphName?: string
    /** False once the user edits the graph name by hand: their choice then survives
     *  a rename of the view (and we stop silently re-deriving it under them). */
    graphNameIsAuto?: boolean
    /** Blank models only: last known availability of the (derived or edited)
     *  graph name — false blocks Next on Basics; server re-validates at submit. */
    graphNameAvailable?: boolean
    /** Blank models only: the Quick Start template the user picked on Layout.
     *  Undefined until an explicit choice is made — gates Next in blank mode. */
    layoutTemplateId?: string
}

export type WizardStep =
    | 'file' | 'target' | 'scope' | 'reconcile'
    | 'basics' | 'layout' | 'assignment' | 'entities' | 'preview'

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
    /** Import journey: back to the File step. */
    onBackToFile?: () => void
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
        label: viewTypeLabel('hierarchy'),
        icon: <ListTree className="w-8 h-8" />,
        description: 'Nested tree view',
        features: ['Clear parent-child structure', 'Expandable/collapsible nodes', 'Best for organizational charts'],
    },
    {
        id: 'reference' as const,
        label: viewTypeLabel('reference'),
        icon: <LayoutTemplate className="w-8 h-8" />,
        description: 'Horizontal layer columns',
        features: ['Layer-based organization', 'Rule-driven entity assignment', 'Best for data pipelines'],
        recommended: true,
    },
]

// ============================================
// Import journey steps
// ============================================

/** The Import journey's steps. The target step only exists for a new view (an update's target
 *  view fixes the scope); the design steps only for layouts the wizard can build. */
function importStepDefs(opts: { needsTarget: boolean; buildable: boolean; withAssignments: boolean }): StepDef[] {
    return [
        { id: 'file', label: 'File', icon: <FileUp className="w-4 h-4" /> },
        ...(opts.needsTarget ? [{ id: 'target' as const, label: 'Target', icon: <Database className="w-4 h-4" /> }] : []),
        { id: 'reconcile', label: 'Match', icon: <ListChecks className="w-4 h-4" /> },
        { id: 'basics', label: 'Basics', icon: <Sparkles className="w-4 h-4" /> },
        ...(opts.buildable ? [
            { id: 'layout' as const, label: 'Layout', icon: <LayoutTemplate className="w-4 h-4" /> },
            ...(opts.withAssignments
                ? [{ id: 'assignment' as const, label: 'Assignments', icon: <ClipboardList className="w-4 h-4" /> }]
                : []),
            { id: 'entities' as const, label: 'Entities', icon: <Network className="w-4 h-4" /> },
        ] : []),
        { id: 'preview', label: 'Preview', icon: <Eye className="w-4 h-4" /> },
    ]
}

function importTitle(action: string | null): { title: string; submitLabel: string } {
    return action === 'update' || action === 'overwrite'
        ? { title: 'Update View', submitLabel: 'Update View' }
        : { title: 'Import View', submitLabel: 'Import View' }
}

// ============================================
// Inline loading / error shells
// ============================================

function WizardLoadingShell({ label, onClose }: { label: string; onClose?: () => void }) {
    return (
        <>
            <Backdrop open={true} zClassName="z-50" className="bg-black/60" />
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <div className="pointer-events-auto relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-lg flex flex-col items-center justify-center py-24 gap-4">
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
        </>
    )
}

function WizardErrorShell({ error, onClose }: { error?: Error | null; onClose: () => void }) {
    return (
        <>
            <Backdrop open={true} zClassName="z-50" className="bg-black/60" />
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <div className="pointer-events-auto relative w-full max-w-4xl bg-white dark:bg-slate-900 rounded-2xl shadow-lg flex flex-col items-center justify-center py-24 gap-4">
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
        </>
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

/** Create mode resolver — two-phase: ScopeStep (or the Import journey's File and Target steps)
 *  then SchemaScope + Body. */
function ViewWizardCreateResolver(props: ViewWizardProps & {
    activeWorkspaceId: string | null
    activeDataSourceId: string | null
    workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces']
}) {
    const { activeWorkspaceId, activeDataSourceId, workspaces, ...wizardProps } = props
    const lastScope = useMemo(() => readLastScope(), [])
    const startMode: ScopeMode = props.journey === 'import' ? 'import' : 'existing'

    // Determine initial selections: explicit props > active context > last used
    const initialWs = props.initialWorkspaceId ?? activeWorkspaceId ?? lastScope.wsId ?? null
    const initialDs = props.initialDataSourceId
        ?? (initialWs === activeWorkspaceId ? activeDataSourceId : null)
        ?? (initialWs === lastScope.wsId ? lastScope.dsId : null)
        ?? null

    const [selectedWsId, setSelectedWsId] = useState<string | null>(initialWs)
    const [selectedDsId, setSelectedDsId] = useState<string | null>(initialDs)
    const [scopeMode, setScopeMode] = useState<ScopeMode>(startMode)
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
    const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)
    const [scopeConfirmed, setScopeConfirmed] = useState(false)

    // Import journey: its first steps (the file, then where a new view goes) come before any
    // schema is loaded, so they live here, above both phases, with the session they build.
    const [importStep, setImportStep] = useState<'file' | 'target'>('file')
    const importSession = useImportSessionState({ file: props.importFile, intoViewId: props.importIntoViewId })
    const isImport = scopeMode === 'import'
    const importAction = importSession.action
    const importNeedsTarget = importAction === 'create' || importAction === 'copy'
    const importViewType = importSession.view?.metadata.viewType ?? null

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
            setScopeMode(startMode)
            setImportStep('file')
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

    /** Both at once: a suggestion names a data source in a workspace. */
    const selectScope = useCallback((wsId: string, dsId: string) => {
        setSelectedWsId(wsId)
        setSelectedDsId(dsId)
    }, [])

    const handleModeChange = useCallback((mode: ScopeMode) => {
        setScopeMode(mode)
        if (mode === 'import') setImportStep('file')
    }, [])

    // A new imported view starts where the file most likely belongs: the best suggestion, when
    // the sample found at least half of the view's entities there. Once per file, so a person's
    // own pick is never overridden.
    const suggestedFor = useRef<string | null>(null)
    const topSuggestion = importSession.suggestions[0]
    useEffect(() => {
        const key = importSession.view ? `${importSession.fileName}:${importSession.view.portableId}` : null
        if (!isImport || importStep !== 'target' || !key || suggestedFor.current === key) return
        suggestedFor.current = key
        if (topSuggestion && (topSuggestion.sampleHitRate ?? 0) >= 0.5) {
            selectScope(topSuggestion.workspaceId, topSuggestion.dataSourceId)
        }
    }, [isImport, importStep, importSession.view, importSession.fileName, topSuggestion, selectScope])

    const handleScopeConfirm = useCallback(() => {
        if (scopeMode === 'existing' || scopeMode === 'import') {
            if (selectedWsId && selectedDsId) {
                if (scopeMode === 'existing') saveLastScope(selectedWsId, selectedDsId)
                setScopeConfirmed(true)
            }
        } else if (selectedWsId && selectedProviderId && selectedOntologyId) {
            setScopeConfirmed(true)
        }
    }, [scopeMode, selectedWsId, selectedDsId, selectedProviderId, selectedOntologyId])

    /** Import: past the File step. A new view picks its target next; an update's target view
     *  already fixes the scope. */
    const confirmImportFile = useCallback(() => {
        if (importNeedsTarget) {
            setImportStep('target')
            return
        }
        const target = importSession.targetView
        if (!target) return
        setSelectedWsId(target.workspaceId)
        setSelectedDsId(target.dataSourceId ?? null)
        setScopeConfirmed(true)
    }, [importNeedsTarget, importSession.targetView])

    const handleBackToScope = useCallback(() => {
        setScopeConfirmed(false)
        if (isImport) setImportStep(importNeedsTarget ? 'target' : 'file')
    }, [isImport, importNeedsTarget])

    const handleBackToFile = useCallback(() => {
        setScopeConfirmed(false)
        setImportStep('file')
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
        if (scopeMode === 'import') {
            return importStepDefs({
                needsTarget: importNeedsTarget,
                buildable: isBuildable(importViewType),
                withAssignments: importViewType === 'reference',
            })
        }
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
    }, [scopeMode, importNeedsTarget, importViewType])

    // ── Phase A (import): the file, then where a new view goes ──
    if (isImport && !scopeConfirmed) {
        const { title, submitLabel } = importTitle(importAction)
        const fileReady = !!importSession.view && !importSession.inspecting && !!importAction
            && (importNeedsTarget || !!importSession.targetView)
        return (
            <ImportSessionProvider value={importSession}>
                {importStep === 'file' ? (
                    <WizardShell
                        title={title}
                        submitLabel={submitLabel}
                        currentStep="file"
                        activeSteps={allSteps}
                        currentStepIndex={0}
                        onStepClick={() => {}}
                        onBack={() => {}}
                        onNext={confirmImportFile}
                        onClose={props.onClose}
                        canProceed={fileReady}
                        isLastStep={false}
                        isSubmitting={false}
                        onSubmit={() => {}}
                        wide
                    >
                        <ImportStep
                            modeToggle={props.importIntoViewId
                                ? undefined
                                : <ScopeModeToggle mode={scopeMode} onChange={handleModeChange} />}
                        />
                    </WizardShell>
                ) : (
                    <WizardShell
                        title={title}
                        submitLabel={submitLabel}
                        currentStep="target"
                        activeSteps={allSteps}
                        currentStepIndex={1}
                        onStepClick={(id) => { if (id === 'file') setImportStep('file') }}
                        onBack={() => setImportStep('file')}
                        onNext={handleScopeConfirm}
                        onClose={props.onClose}
                        canProceed={!!(selectedWsId && selectedDsId)}
                        isLastStep={false}
                        isSubmitting={false}
                        onSubmit={() => {}}
                        wide
                    >
                        <ScopeStep
                            scopeMode="existing"
                            onScopeModeChange={() => {}}
                            showModeToggle={false}
                            title="Where should this view be imported?"
                            subtitle="Choose the data source here that holds the same graph the view was built on"
                            aboveSlot={(
                                <TargetSuggestions
                                    suggestions={importSession.suggestions}
                                    selectedDataSourceId={selectedDsId}
                                    onSelect={selectScope}
                                />
                            )}
                            availableWorkspaces={scopeData.workspaces}
                            schemaAvailability={scopeData.schemaAvailability}
                            selectedWorkspaceId={selectedWsId}
                            selectedDataSourceId={selectedDsId}
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
                )}
            </ImportSessionProvider>
        )
    }

    // ── Phase A: ScopeStep (no SchemaScope yet) ────────────────
    if (!scopeConfirmed) {
        const canProceed = scopeMode === 'existing'
            ? !!(selectedWsId && selectedDsId)
            : !!(selectedWsId && selectedProviderId && selectedOntologyId)

        return (
            <WizardShell
                title="Create New View"
                submitLabel="Create View"
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
                wide
            >
                <ScopeStep
                    scopeMode={scopeMode}
                    onScopeModeChange={handleModeChange}
                    availableWorkspaces={scopeData.workspaces}
                    schemaAvailability={scopeData.schemaAvailability}
                    selectedWorkspaceId={selectedWsId}
                    selectedDataSourceId={selectedDsId}
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
        <ImportSessionProvider value={isImport ? importSession : null}>
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
                    onBackToFile={handleBackToFile}
                    scopeMode={isImport ? 'import' : 'existing'}
                />
            </SchemaScope>
        </ImportSessionProvider>
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
    onBackToFile,
}: ViewWizardBodyProps) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const schema = useSchemaStore(s => s.schema)
    const { clearSelection } = useCanvasStore()
    const { clearAssignments } = useReferenceModelStore()
    const { notify } = useAppNotifications()
    const isBlank = scopeMode === 'blank'

    // ── Import journey ──
    // The session (file, choices, reconcile) is held by the resolver above; this body edits the
    // design the reconcile produced and writes it through the import endpoint.
    const importSession = useImportSession()
    const isImport = scopeMode === 'import' && importSession !== null
    const importAction = isImport ? importSession.action : null
    const isImportUpdate = importAction === 'update' || importAction === 'overwrite'
    const importTargetViewId = isImportUpdate ? importSession?.targetView?.viewId ?? null : null
    const importViewType = importSession?.view?.metadata.viewType ?? null
    const importBuildable = isBuildable(importViewType)
    const reconciled = isImport ? importSession.reconcile : null
    // An update keeps the view's current name and details unless the person picks the file's.
    const targetViewQuery = useQuery({
        queryKey: [...VIEW_QUERY_KEY, importTargetViewId],
        queryFn: () => getView(importTargetViewId!),
        enabled: !!importTargetViewId,
    })
    const currentTargetView = targetViewQuery.data ?? null
    /** The definition the form was filled from, and the form as filled: what `formToDefinition`
     *  patches, so only what changed in the wizard is written. */
    const [importFilled, setImportFilled] = useState<{ base: Definition; initial: WizardFormData } | null>(null)
    const importHydrated = importFilled !== null
    const [importResult, setImportResult] = useState<ImportViewResult | null>(null)
    const [importFailure, setImportFailure] = useState<ViewTransferError | null>(null)
    /** One request id per distinct import request, reused by its retries (safe to repeat). */
    const importRequestRef = useRef<{ fingerprint: string; id: string } | null>(null)
    const importTarget = useMemo(() => (importTargetViewId
        ? { viewId: importTargetViewId }
        : { workspaceId: resolvedWorkspaceId, dataSourceId: resolvedDataSourceId }),
    [importTargetViewId, resolvedWorkspaceId, resolvedDataSourceId])
    const importTargetLabel = isImportUpdate
        ? `“${importSession?.targetView?.name ?? 'the view'}”`
        : `${scopeContext.workspaceName} · ${scopeContext.dataSourceLabel}`
    // Entities the reconcile found missing here, as the file named them: the Assignments step
    // shows them by name, and never spends a lookup confirming what is already known.
    const importEntitySeed = useMemo(() => {
        if (!reconciled) return null
        const seed = new Map<string, EntityIdentity>()
        for (const row of reconciled.report.entities) {
            if (row.status !== 'missing') continue
            seed.set(row.urn, {
                name: row.exported?.name || fallbackNameFromUrn(row.urn),
                type: row.exported?.type || 'unknown',
                childCount: 0,
                missing: true,
            })
        }
        return seed
    }, [reconciled])
    // Picking Enterprise without the publish permission means "create it,
    // then ask" — the view has to exist before a request can attach to it.
    const { canPublish: canPublishHere } = usePublishGate(
        resolvedWorkspaceId, resolvedDataSourceId,
    )

    // Admin → Features → View modes. `null` means no restriction (see useFeatureList).
    //
    // The empty INTERSECTION is guarded too, and it isn't hypothetical: the registry offers four
    // layouts and this wizard can only build three (`layered-lineage` views exist and render, but
    // are not created here). An admin who allows only that one would otherwise be handed a layout
    // step with nothing in it and no explanation — a dead end. Showing the layouts instead defers
    // to the server, which refuses the create with a sentence a person can act on.
    const allowedViewModes = useFeatureList('allowedViewModes')
    const availableLayoutTypes = useMemo(() => {
        if (!allowedViewModes) return LAYOUT_TYPES
        const allowed = LAYOUT_TYPES.filter(t => allowedViewModes.includes(t.id))
        return allowed.length > 0 ? allowed : LAYOUT_TYPES
    }, [allowedViewModes])

    // Blank provisioning result — held so a failed createView retry reuses the
    // same data source instead of provisioning a duplicate.
    const provisionRef = useRef<BlankGraphResult | null>(null)
    const [provisionError, setProvisionError] = useState<string | null>(null)
    // The just-created view's id — held so that if createView succeeds but the
    // follow-up updateViewLayout fails, a retry re-drives ONLY the layout write
    // against this id instead of minting a second view.
    const createdViewIdRef = useRef<string | null>(null)

    // Create-mode initial form: layers start empty for both existing and blank
    // scopes — blank models choose their starting layers via a template on Layout.
    const makeCreateFormData = useCallback((): WizardFormData => {
        const base = getInitialFormData(schema)
        return {
            ...base,
            dataSourceId: resolvedDataSourceId ?? undefined,
        }
    }, [schema, resolvedDataSourceId])

    // When editing a draft, hydrate the wizard from the BRANCH-EFFECTIVE view
    // (base ⊕ overlay) — same branch the submit writes to (branchIdForScope
    // below) — so a metadata edit never re-writes the overlay with base layout.
    const wizardBranchId = useEffectiveBranchId(resolvedWorkspaceId, resolvedDataSourceId, viewId)
    const fullViewQuery = useViewFull(mode === 'edit' ? viewId : null, wizardBranchId ?? undefined)
    const editingView = useMemo(() => {
        if (mode !== 'edit' || !fullViewQuery.data) return null
        return viewToViewConfig(fullViewQuery.data)
    }, [mode, fullViewQuery.data])

    const [currentStep, setCurrentStep] = useState<WizardStep>('basics')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [previousSteps, setPreviousSteps] = useState<WizardStep[]>([])
    const [driftDismissed, setDriftDismissed] = useState(false)

    // Create mode runs a small phase machine after the form: 'creating' shows
    // the real stages (and absorbs failures with a resumable Retry), 'success'
    // confirms and hands over to the new view. Edit mode keeps the plain
    // save-and-close behaviour — there's nothing to navigate to.
    const [phase, setPhase] = useState<'steps' | 'creating' | 'success'>('steps')
    const [stageStates, setStageStates] = useState<Record<CreationStageId, CreationStageState>>({
        provision: 'pending', create: 'pending', layout: 'pending', import: 'pending', publication: 'pending',
    })
    const [submitError, setSubmitError] = useState<string | null>(null)
    /** A free graph name the server handed back after a late collision (blank models). */
    const [nameConflict, setNameConflict] = useState<string | null>(null)
    // The saved view, held until the user actually leaves the success step.
    // `onComplete` is what CLOSES the wizard (AppLayout wires it to closeViewEditor),
    // so calling it the moment the save lands would unmount us mid-celebration —
    // which is exactly why the success step never appeared and nothing navigated.
    const createdViewRef = useRef<ViewConfiguration | null>(null)

    const [formData, setFormData] = useState<WizardFormData>(makeCreateFormData)

    // Hydrate form from view in edit mode. normalizeReferenceLayout up-converts
    // legacy per-layer entityAssignments/rules into the flattened assignments
    // map, so canvas-created layer placements (canonical or legacy) become
    // visible in the wizard here.
    useEffect(() => {
        if (mode === 'edit' && editingView) {
            const { layers, assignments, defaultNodeSortMode } = normalizeReferenceLayout(editingView.layout?.referenceLayout)
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
                defaultNodeSortMode,
                visibleEntityTypes: editingView.content.visibleEntityTypes,
                visibleRelationshipTypes: editingView.content.visibleRelationshipTypes,
                advancedFilters: fieldFiltersToActiveFilters(editingView.filters.fieldFilters),
                scopeEdges: layers[0]?.scopeEdges,
                isValid: true,
            })
        }
    }, [mode, editingView])

    // ── Draft autosave (create mode only) ──
    // Assignment work on a big graph is a long session; closing the modal used to
    // discard all of it. Drafts are scoped to the exact target so they can never
    // be restored into a different workspace/source.
    const scopeKey = useMemo(() => draftKey({
        workspaceId: resolvedWorkspaceId,
        dataSourceId: resolvedDataSourceId,
        providerId: blankProviderId,
        ontologyId: blankOntologyId,
    }), [resolvedWorkspaceId, resolvedDataSourceId, blankProviderId, blankOntologyId])

    const { pendingDraft, dismissDraft, clearDraft, markDirty, tooLarge } = useWizardDraft({
        // An import's design lives in its file; there is nothing to resume that the file lacks.
        enabled: mode === 'create' && phase === 'steps' && !isImport,
        scopeKey,
        formData,
        currentStep,
    })

    // Reset on open / close.
    useEffect(() => {
        if (isOpen) {
            setCurrentStep(isImport ? 'reconcile' : 'basics')
            setPreviousSteps([])
            setDriftDismissed(false)
            setPhase('steps')
            setSubmitError(null)
            setStageStates({ provision: 'pending', create: 'pending', layout: 'pending', import: 'pending', publication: 'pending' })
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

    // Import: fill the form from the design the reconcile produced. Declared after the reset
    // above so, on mount with a reconcile already in hand, it is the one that sticks. Only a NEW
    // reconcile (new choices on the Match step) re-fills it, keeping the basics already typed; a
    // refetch of anything else must never reset edits made since.
    const filledFromRef = useRef<object | null>(null)
    useEffect(() => {
        const view = importSession?.view
        if (!isImport || !reconciled || !view || filledFromRef.current === reconciled) return
        if (importTargetViewId && !currentTargetView) return
        const fileMeta = view.metadata
        const meta = currentTargetView ? {
            ...fileMeta,
            name: currentTargetView.name,
            description: currentTargetView.description ?? null,
            icon: (currentTargetView.config?.icon as string | undefined) ?? fileMeta.icon,
            tags: currentTargetView.tags ?? [],
        } : fileMeta
        const hydrated = definitionToForm(reconciled.effectiveDefinition, meta, {
            dataSourceId: resolvedDataSourceId ?? undefined,
        })
        const hadForm = filledFromRef.current !== null
        filledFromRef.current = reconciled
        setFormData(prev => hadForm ? {
            ...hydrated,
            name: prev.name, description: prev.description, icon: prev.icon, tags: prev.tags,
            visibility: prev.visibility, publishNote: prev.publishNote,
        } : hydrated)
        setImportFilled({ base: reconciled.effectiveDefinition, initial: hydrated })
    }, [isImport, reconciled, importSession?.view, importTargetViewId, currentTargetView, resolvedDataSourceId])

    // Steps for the body phase (scope step is handled by the resolver)
    const activeSteps: StepDef[] = useMemo(() => {
        if (isImport) {
            return importStepDefs({
                needsTarget: !isImportUpdate,
                buildable: importBuildable,
                withAssignments: formData.layoutType === 'reference',
            })
        }
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
    }, [formData.layoutType, mode, isBlank, isImport, isImportUpdate, importBuildable])

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
            case 'reconcile': {
                // Past the Match step only with a verdict that allows it, and with every choice
                // made there re-checked, so the design edited next is the one the server scored.
                if (!isImport || !reconciled || !importHydrated || importSession.reconciling) return false
                if (!sameResolutions(importSession.resolutions, importSession.draft)) return false
                return reconciled.report.summary.verdict !== 'blocked'
            }
            case 'assignment': return true
            // An imported view's selection is its own; an empty one (a rule-driven view) is valid.
            case 'entities': return isImport || formData.visibleEntityTypes.length > 0
            case 'preview': return true
            default: return false
        }
    }, [currentStep, formData, isImport, reconciled, importHydrated, importSession])

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
        // The Match step leads an import's body: back is its target (or its file).
        if (isImport && currentStep === 'reconcile') {
            onBackToScope?.()
            return
        }
        // If we're at the first body step in create mode, go back to scope
        if (!isImport && currentStep === 'basics' && mode === 'create' && onBackToScope) {
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
    }, [previousSteps, currentStep, mode, onBackToScope, isImport])

    const handleStepClick = useCallback((stepId: WizardStep) => {
        // Clicking the scope step in create mode goes back to scope
        if ((stepId === 'scope' || stepId === 'target') && mode === 'create' && onBackToScope) {
            onBackToScope()
            return
        }
        if (stepId === 'file' && onBackToFile) {
            onBackToFile()
            return
        }
        const currentIndex = activeSteps.findIndex(s => s.id === currentStep)
        const targetIndex = activeSteps.findIndex(s => s.id === stepId)
        if (targetIndex <= currentIndex && targetIndex !== -1) {
            startTransition(() => {
                setCurrentStep(stepId)
            })
        }
    }, [currentStep, activeSteps, mode, onBackToScope, onBackToFile])

    // ── Import submit ──
    const importWantsPublication = isImport && !isImportUpdate
        && formData.visibility === 'enterprise' && !canPublishHere

    const handleImportSubmit = useCallback(async () => {
        const session = importSession
        const view = session?.view
        if (!session || !view || !session.action || !session.reconcile || !importFilled) return
        setIsSubmitting(true)
        setPhase('creating')
        setSubmitError(null)
        setImportFailure(null)
        setStageStates(s => ({ ...s, import: createdViewIdRef.current ? 'done' : 'active' }))
        try {
            let result = importResult
            if (!createdViewIdRef.current || !result) {
                const definition = formToDefinition(importFilled.base, importFilled.initial, formData)
                const viewType = importBuildable ? formData.layoutType : (importViewType ?? formData.layoutType)
                const request: ImportViewRequest = {
                    action: session.action,
                    strategy: session.strategy,
                    target: importTarget,
                    metadata: {
                        ...formToMetadata(formData, viewType),
                        // A member who picked Enterprise but can't publish gets the widest tier
                        // they can set; the request below asks for the rest.
                        ...(isImportUpdate ? {} : { visibility: importWantsPublication ? 'workspace' : formData.visibility }),
                    },
                    definition,
                    // What is written differs from the file: send the file's design, so the
                    // next file from the same lineage can still merge from this version.
                    originDefinition: sameJson(definition, view.definition) ? undefined : view.definition,
                    origin: {
                        portableId: view.portableId,
                        sourceViewId: view.sourceViewId,
                        version: view.version,
                        definitionHash: view.definitionHash,
                        name: view.metadata.name,
                        environment: session.inspect?.bundle.generator.environment,
                        exportedAt: session.inspect?.bundle.exportedAt,
                        exportedBy: session.inspect?.bundle.exportedBy.displayName,
                        fileName: session.fileName,
                    },
                    manifest: view.manifest,
                    history: view.history,
                    resolutions: session.resolutions,
                    expectedTargetHash: session.reconcile.update?.targetWorkingHash ?? null,
                }
                const fingerprint = JSON.stringify(request)
                if (importRequestRef.current?.fingerprint !== fingerprint) {
                    importRequestRef.current = { fingerprint, id: newRequestId() }
                }
                result = await importView({ ...request, requestId: importRequestRef.current.id })
                createdViewIdRef.current = result.viewId
                setImportResult(result)
                const saved = viewToViewConfig(result.view)
                useSchemaStore.getState().addOrUpdateView(saved)
                createdViewRef.current = saved
                invalidateViewVersions(queryClient, result.viewId)
                void queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, result.viewId] })
                void queryClient.invalidateQueries({ queryKey: ['views'] })
                void queryClient.invalidateQueries({ queryKey: ['explorer-views'] })
                const rate = result.report.summary.matchRate
                recordEvent('view.import', {
                    action: session.action,
                    strategy: session.strategy,
                    match: rate === null ? 'unchecked' : rate >= 0.95 ? '95+' : rate >= 0.8 ? '80-95' : rate >= 0.5 ? '50-80' : '<50',
                })
            }
            setStageStates(s => ({ ...s, import: 'done', publication: importWantsPublication ? 'active' : 'pending' }))
            if (importWantsPublication) {
                // The view exists, so the ask has something to attach to. A failure here doesn't
                // undo the import; the request can be sent again from Share.
                try {
                    await requestViewPublication(result.viewId, formData.publishNote?.trim() || undefined)
                    notify('success', 'View imported — your publication request was sent to your workspace admins')
                } catch {
                    notify('error', "View imported, but the publication request couldn't be sent. You can ask again from Share.")
                }
                setStageStates(s => ({ ...s, publication: 'done' }))
            }
            setPhase('success')
        } catch (err) {
            setStageStates(s => ({ ...s, import: 'failed' }))
            setImportFailure(err instanceof ViewTransferError ? err : null)
            setSubmitError(err instanceof Error ? err.message : 'The view could not be imported. Please try again.')
        } finally {
            setIsSubmitting(false)
        }
    }, [importSession, importFilled, importResult, formData, importBuildable, importViewType, importTarget,
        isImportUpdate, importWantsPublication, queryClient, notify])

    /** The view changed since it was reviewed (409): check it again from the Match step. */
    const handleCheckAgain = useCallback(() => {
        importSession?.invalidateReconcile()
        setSubmitError(null)
        setImportFailure(null)
        setPhase('steps')
        setCurrentStep('reconcile')
    }, [importSession])

    const handleSubmit = useCallback(async () => {
        if (isImport) {
            await handleImportSubmit()
            return
        }
        setIsSubmitting(true)
        setProvisionError(null)
        // Enterprise was chosen by someone who can't grant it: create at the
        // widest tier they can set, then ask on their behalf.
        const wantsPublication = formData.visibility === 'enterprise' && !canPublishHere
        try {
            const layersWithScope = formData.layers.map(l => ({ ...l, scopeEdges: formData.scopeEdges }))
            // Canonical-clean: strips any stray legacy entityAssignments and merges
            // them into the flattened map so nothing is silently lost.
            // Carry the scalar defaultNodeSortMode side-field from the view being
            // edited — the wizard rebuilds the layout from form state, and a bare
            // { layers, assignments } write would wipe the view-wide sort default.
            const priorDefaultSort = mode === 'edit'
                ? normalizeReferenceLayout(editingView?.layout?.referenceLayout).defaultNodeSortMode
                : undefined
            const effectiveDefaultSort = formData.defaultNodeSortMode ?? priorDefaultSort
            const normalizedLayout = normalizeReferenceLayout({
                layers: layersWithScope,
                assignments: formData.assignments,
                ...(effectiveDefaultSort ? { defaultNodeSortMode: effectiveDefaultSort } : {}),
            })
            const fieldFilters = activeFiltersToFieldFilters(formData.advancedFilters)

            if (mode === 'create') {
                // Show what's actually happening. Stages mirror the awaited calls
                // below — one row per call, no invented sub-steps.
                setPhase('creating')
                setSubmitError(null)
                setStageStates(prev => ({
                    ...prev,
                    provision: isBlank ? 'active' : 'done',
                    create: isBlank ? 'pending' : 'active',
                    layout: 'pending',
                }))

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
                            setStageStates(s => ({ ...s, provision: 'failed' }))
                            // Someone took the graph name while this wizard was open. The
                            // server refuses to write into an existing key (it would wipe
                            // whatever lives there), so retrying the SAME name can only fail
                            // again — offer the free name it handed back instead.
                            if (err instanceof GraphNameUnavailableError) {
                                setSubmitError(err.message)
                                setNameConflict(err.suggestion)
                                return
                            }
                            setSubmitError(err instanceof Error ? err.message : 'Could not create the blank model. Please try again.')
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
                    setStageStates(s => ({ ...s, provision: 'done', create: 'active' }))
                }
                // Reuse a successful create's id on retry — it's the layout write that's
                // being retried here, not the view itself, so a retry must never call
                // createView again (that would mint a second, half-baked view).
                let createdViewId = createdViewIdRef.current
                if (!createdViewId) {
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
                        // A member who picked Enterprise but can't publish
                        // gets the widest tier they CAN set; the request
                        // below asks for the rest. Creating at 'enterprise'
                        // would just 403.
                        visibility: wantsPublication ? 'workspace' : formData.visibility,
                        tags: formData.tags.length > 0 ? formData.tags : undefined,
                    })
                    if (!result.success || !result.data) {
                        setStageStates(s => ({ ...s, create: 'failed' }))
                        setSubmitError(result.error ?? 'The view could not be created. Please try again.')
                        return
                    }
                    createdViewId = result.data.id
                    createdViewIdRef.current = createdViewId

                    // The view exists now, so the ask has something to
                    // attach to. Failure here must not fail the create —
                    // the view is saved either way and the request can be
                    // re-sent from Share.
                    if (wantsPublication) {
                        try {
                            await requestViewPublication(
                                createdViewId,
                                formData.publishNote?.trim() || undefined,
                            )
                            notify(
                                'success',
                                'View created — your publication request was sent to your workspace admins',
                            )
                        } catch {
                            notify(
                                'error',
                                "View created, but the publication request couldn't be sent. You can ask again from Share.",
                            )
                        }
                    }
                }
                setStageStates(s => ({ ...s, create: 'done', layout: 'active' }))

                // The layout endpoint is the single writer of referenceLayout — write
                // the full layers+assignments (a new view has no prior layout to race).
                const entityScope = resolveWizardEntityScope(formData.entityScope, normalizedLayout, undefined)
                try {
                    const layoutResult = await updateViewLayout(createdViewId, {
                        referenceLayout: normalizedLayout,
                        entityScope,
                    })
                    const savedView = viewToViewConfig(layoutResult)
                    useSchemaStore.getState().addOrUpdateView(savedView)
                    // The view exists and is fully saved — the draft has served its
                    // purpose. Hold the view and hand over to the success step;
                    // onComplete/onClose/navigate all wait until the user leaves
                    // (onComplete closes the wizard, so firing it here would kill
                    // the success step and the redirect with it).
                    createdViewRef.current = savedView
                    clearDraft()
                    setStageStates(s => ({ ...s, layout: 'done' }))
                    setPhase('success')
                } catch (err) {
                    // The view itself was created; only its layout failed to save. Stay
                    // in the creating phase with a Retry — createdViewIdRef makes that
                    // retry skip straight back to here instead of minting a second view.
                    console.error('[ViewWizard] updateViewLayout failed after create', err)
                    setStageStates(s => ({ ...s, layout: 'failed' }))
                    setSubmitError(err instanceof Error ? err.message : 'The view was created, but its layout could not be saved.')
                }
            } else if (viewId) {
                // This updateView writes the published/base row (name/filters/visible-types
                // stay base-global even in a draft). buildViewConfig now preserves the base's
                // existing content.entityScope, so the config PUT no longer wipes it — the
                // scope for this branch's layout is owned by the branch overlay (below).
                const result = await viewService.updateView(viewId, {
                    name: formData.name,
                    description: formData.description,
                    icon: formData.icon,
                    layoutType: formData.layoutType,
                    layers: normalizedLayout.layers,
                    visibleEntityTypes: formData.visibleEntityTypes,
                    visibleRelationshipTypes: formData.visibleRelationshipTypes,
                    fieldFilters,
                    // Same rule as create: asking for Enterprise without the
                    // permission files a request rather than attempting a
                    // transition the server will refuse.
                    visibility: wantsPublication ? undefined : formData.visibility,
                    tags: formData.tags.length > 0 ? formData.tags : undefined,
                }, fullViewQuery.data?.config)
                if (wantsPublication) {
                    try {
                        await requestViewPublication(
                            viewId, formData.publishNote?.trim() || undefined,
                        )
                        notify(
                            'success',
                            'Saved — your publication request was sent to your workspace admins',
                        )
                    } catch {
                        notify(
                            'error',
                            "Saved, but the publication request couldn't be sent. You can ask again from Share.",
                        )
                    }
                }
                if (result.success && result.data) {
                    // A scope PINNED in this wizard session wins (the user just chose a
                    // rule-driven layout); else preserve an explicit
                    // editingView.content.entityScope; else derive from the submitted
                    // assignments — a deliberate wizard save is allowed to set scope
                    // explicitly, unlike implicit canvas gestures.
                    const entityScope = resolveWizardEntityScope(
                        formData.entityScope, normalizedLayout, editingView?.content,
                    )
                    // When a draft is open for THIS view, route the layout write to the branch
                    // overlay (null on Published → base write), so wizard layer/scope edits on a
                    // draft don't leak to Published — mirrors the canvas debounced saver.
                    const branchId = useBranchStore.getState().branchIdForScope(
                        resolvedWorkspaceId, resolvedDataSourceId, viewId,
                    ) ?? undefined
                    // The layout write replaces the reference layout wholesale, and the wizard
                    // edits only its layers, placements and default sort. Everything else it
                    // carries (display rules, anything newer) rides along, or a save here
                    // would silently delete it.
                    const priorSideFields = Object.fromEntries(
                        Object.entries((editingView?.layout?.referenceLayout ?? {}) as Record<string, unknown>)
                            .filter(([key]) => key !== 'layers' && key !== 'assignments' && key !== 'defaultNodeSortMode'),
                    )
                    try {
                        const layoutResult = await updateViewLayout(viewId, {
                            referenceLayout: { ...priorSideFields, ...normalizedLayout },
                            entityScope,
                        }, branchId)
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
    }, [mode, viewId, formData, resolvedWorkspaceId, resolvedDataSourceId, isBlank, blankProviderId, blankOntologyId, onComplete, onClose, navigate, fullViewQuery.data, editingView, clearDraft, canPublishHere, notify, isImport, handleImportSubmit])

    const updateFormData = useCallback((updates: Partial<WizardFormData>) => {
        markDirty()
        setFormData(prev => ({ ...prev, ...updates }))
    }, [markDirty])

    // `layoutType` defaults to 'reference'. If an admin has withdrawn that layout its card is no
    // longer rendered — but the default is still sitting in the form, so a user who presses Next
    // without clicking anything submits a layout the server will refuse. They never chose it and
    // cannot see it, so the 403 would be unattributable.
    //
    // Only when CREATING. An existing view keeps the layout it was built with: withdrawing a
    // layout stops new work in it, and must not silently rewrite the views already in it.
    useEffect(() => {
        if (mode === 'edit' || isImport) return
        if (availableLayoutTypes.some(t => t.id === formData.layoutType)) return
        updateFormData({ layoutType: availableLayoutTypes[0].id })
    }, [mode, isImport, availableLayoutTypes, formData.layoutType, updateFormData])

    /** Restore an autosaved draft, landing back on the step it was left on. */
    const handleResumeDraft = useCallback(() => {
        if (!pendingDraft) return
        setFormData(prev => ({
            ...prev,
            ...pendingDraft.data,
            // Re-run the live availability check rather than trusting a stale verdict.
            graphNameAvailable: undefined,
            isValid: true,
        }))
        const target = activeSteps.find(s => s.id === pendingDraft.step)
        if (target && target.id !== 'scope') setCurrentStep(target.id)
        dismissDraft()
    }, [pendingDraft, activeSteps, dismissDraft])

    // Ontology drift: view's stored digest vs current schema digest.
    const showDriftBanner =
        !driftDismissed &&
        hasOntologyDrifted(viewMetadata?.ontologyDigest, schema?.ontologyDigest)

    // ── Leaving the success step ─────────────────────────────────────────────
    // Order matters: navigate FIRST, then hand the view to the parent. `onComplete`
    // closes the wizard, and a close must never be able to cancel the redirect the
    // user just asked for.
    const handleOpenNow = useCallback(() => {
        const id = createdViewIdRef.current
        if (id) navigate(`/views/${id}`)
        const saved = createdViewRef.current
        if (saved) onComplete?.(saved)
        onClose()
    }, [navigate, onComplete, onClose])

    const handleStayHere = useCallback(() => {
        const saved = createdViewRef.current
        if (saved) onComplete?.(saved)
        onClose()
    }, [onComplete, onClose])

    const isTerminal = mode === 'create' && (phase === 'creating' || phase === 'success')

    // Auto-open: the view is saved and there is nowhere else to go, so open it for
    // the user unless they say otherwise ("Stay here").
    const countdown = useAutoOpenCountdown({
        enabled: mode === 'create' && phase === 'success',
        onFire: handleOpenNow,
    })

    // handleSubmit is re-created each render; the retry-with-a-new-name path needs
    // the CURRENT one after a setState, so route it through a ref.
    const handleSubmitRef = useRef<(() => void) | null>(null)
    handleSubmitRef.current = handleSubmit

    const creationStages: CreationStage[] = useMemo(() => isImport ? [
        {
            id: 'import' as const,
            label: isImportUpdate ? `Updating ${importTargetLabel}` : 'Importing the view',
            detail: 'Writing its design, checking every entity once more, and saving it as a version',
            state: stageStates.import,
        },
        ...(importWantsPublication ? [{
            id: 'publication' as const,
            label: 'Requesting publication',
            detail: 'Asking your workspace admins to publish it to everyone',
            state: stageStates.publication,
        }] : []),
    ] : [
        ...(isBlank ? [{
            id: 'provision' as const,
            label: 'Provisioning your model',
            detail: 'Checking the connection, then creating the graph and data source',
            state: stageStates.provision,
        }] : []),
        {
            id: 'create' as const,
            label: 'Creating the view',
            detail: 'Saving its name, scope and settings',
            state: stageStates.create,
        },
        {
            id: 'layout' as const,
            label: 'Applying layers and placements',
            detail: 'Writing the layout this view opens with',
            state: stageStates.layout,
        },
    ], [isBlank, stageStates, isImport, isImportUpdate, importTargetLabel, importWantsPublication])

    /** What the user just built — shown on the success step. */
    const successStats: CreationSummaryStat[] = useMemo(() => {
        const stats: CreationSummaryStat[] = []
        if (isImport && importResult) {
            const summary = importResult.report.summary
            stats.push({ label: 'Version', value: `v${importResult.version.version}` })
            stats.push({ label: 'Matched', value: percent(summary.matchRate) })
            stats.push({ label: 'Not found, kept', value: summary.entities.missing })
            stats.push({ label: 'Integrity', value: importResult.integrity.verified ? 'Verified' : 'Adjusted' })
            return stats
        }
        const layoutLabel = LAYOUT_TYPES.find(t => t.id === formData.layoutType)?.label ?? formData.layoutType
        stats.push({ label: 'Layout', value: layoutLabel })
        if (formData.layoutType === 'reference') {
            stats.push({ label: formData.layers.length === 1 ? 'Layer' : 'Layers', value: formData.layers.length })
            stats.push({ label: 'Placements', value: Object.keys(formData.assignments ?? {}).length })
        } else {
            stats.push({ label: 'Entity types', value: formData.visibleEntityTypes.length })
        }
        stats.push({ label: 'Visibility', value: formData.visibility })
        return stats
    }, [formData.layoutType, formData.layers.length, formData.assignments, formData.visibleEntityTypes.length, formData.visibility, isImport, importResult])

    /** Late graph-name collision: adopt the free name the server offered, then retry. */
    const handleUseSuggestedName = useCallback(() => {
        if (!nameConflict) return
        setFormData(prev => ({ ...prev, graphName: nameConflict, graphNameIsAuto: true, graphNameAvailable: undefined }))
        setNameConflict(null)
        setSubmitError(null)
        // Re-run submit on the next tick, with the new name in formData.
        setTimeout(() => handleSubmitRef.current?.(), 0)
    }, [nameConflict])

    const terminalFooter = phase === 'creating'
        ? (submitError
            ? (
                <CreationErrorFooter
                    onBack={() => setPhase('steps')}
                    onRetry={importFailure?.type === 'target_changed' ? handleCheckAgain : handleSubmit}
                    suggestedName={nameConflict}
                    onUseSuggestedName={handleUseSuggestedName}
                />
            )
            : <CreationBusyFooter />)
        : phase === 'success'
            ? (
                <CreationSuccessFooter
                    remaining={countdown.remaining}
                    onOpenNow={() => { countdown.cancel(); handleOpenNow() }}
                    onStayHere={() => { countdown.cancel(); handleStayHere() }}
                />
            )
            : undefined

    const shellTitle = isImport ? importTitle(importAction)
        : mode === 'create' ? { title: 'Create New View', submitLabel: 'Create View' }
            : { title: 'Edit View', submitLabel: 'Save Changes' }

    return (
        <WizardEntitySeedContext.Provider value={importEntitySeed}>
        <WizardShell
            title={shellTitle.title}
            submitLabel={shellTitle.submitLabel}
            wide={currentStep === 'scope' || currentStep === 'assignment' || currentStep === 'reconcile'}
            currentStep={currentStep}
            activeSteps={activeSteps}
            currentStepIndex={currentStepIndex}
            onStepClick={(id) => handleStepClick(id as WizardStep)}
            onBack={handleBack}
            onNext={handleNext}
            onClose={phase === 'success' ? handleStayHere : onClose}
            canProceed={canProceed}
            isLastStep={isLastStep}
            isSubmitting={isSubmitting}
            onSubmit={handleSubmit}
            terminalPhase={isTerminal ? phase : undefined}
            terminalLabel={phase === 'success'
                ? (isImport ? (isImportUpdate ? 'Updated' : 'Imported') : 'Created')
                : (isImport ? (isImportUpdate ? 'Update' : 'Import') : 'Create')}
            terminalSubtitle={
                phase === 'success'
                    ? 'All done — opening it next'
                    : submitError
                        ? 'Something went wrong — nothing was lost'
                        : isImport ? 'Importing your view…' : 'Saving your view…'
            }
            hideClose={phase === 'creating' && !submitError}
            footer={terminalFooter}
        >
            {isTerminal ? (
                phase === 'creating' ? (
                    <CreationProgressBody
                        stages={creationStages}
                        viewName={formData.name}
                        error={submitError}
                    />
                ) : (
                    <>
                        <CreationSuccessBody
                            icon={formData.icon}
                            graphName={isBlank ? (provisionRef.current?.graphName ?? formData.graphName) : undefined}
                            viewName={importResult?.view.name ?? formData.name}
                            scopeLabel={scopeContext?.dataSourceLabel}
                            isBlank={isBlank}
                            stats={successStats}
                        />
                        {isImport && importResult && <ImportResultNote result={importResult} />}
                    </>
                )
            ) : (
            <>
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

            {/* Resume an autosaved draft for this exact scope. */}
            {pendingDraft && !isImport && (
                <div className="mb-6 flex items-center gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                    <History className="w-4 h-4 text-blue-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
                            You have an unfinished view here
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Saved {timeAgo(pendingDraft.savedAt)}
                            {pendingDraft.data.name ? ` · "${pendingDraft.data.name}"` : ''}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleResumeDraft}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                        Resume
                    </button>
                    <button
                        type="button"
                        onClick={clearDraft}
                        className="shrink-0 px-2 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                    >
                        Discard
                    </button>
                </div>
            )}

            {tooLarge && (
                <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        This view is too large to autosave a draft — finish creating it in this session.
                    </p>
                </div>
            )}

            {currentStep === 'reconcile' && isImport && (
                <ReconcileStep
                    target={importTarget}
                    targetLabel={importTargetLabel}
                    onSkipToReview={() => {
                        startTransition(() => {
                            setPreviousSteps(prev => [...prev, 'reconcile'])
                            setCurrentStep('preview')
                        })
                    }}
                />
            )}
            {currentStep === 'basics' && (
                <BasicsStep
                    formData={formData}
                    updateFormData={updateFormData}
                    mode={isImportUpdate ? 'edit' : mode}
                    savedVisibility={mode === 'edit' ? editingView?.visibility : undefined}
                    scopeContext={scopeContext}
                    onChangeScope={mode === 'create' && !isImportUpdate ? onBackToScope : undefined}
                    blankNaming={isBlank && blankProviderId
                        ? { workspaceId: resolvedWorkspaceId, providerId: blankProviderId }
                        : undefined}
                    aboveFields={isImport && importSession?.view ? (
                        <ImportMetadataPanel
                            formData={formData}
                            updateFormData={updateFormData}
                            file={importSession.view.metadata}
                            environment={importSession.inspect?.bundle.generator.environment}
                            current={isImportUpdate ? currentTargetView : null}
                            workspaceId={resolvedWorkspaceId}
                        />
                    ) : undefined}
                    hideVisibility={isImportUpdate}
                />
            )}
            {currentStep === 'layout' && (
                <LayoutStep
                    formData={formData}
                    updateFormData={updateFormData}
                    layoutTypes={availableLayoutTypes}
                    dataSourceId={formData.dataSourceId}
                    blank={isBlank}
                    imported={isImport}
                />
            )}
            {currentStep === 'assignment' && (
                <AssignmentStep
                    formData={formData}
                    updateFormData={updateFormData}
                    viewEntityScope={editingView?.content?.entityScope}
                />
            )}
            {currentStep === 'entities' && (
                <EntitiesStep
                    formData={formData}
                    updateFormData={updateFormData}
                    dataSourceId={formData.dataSourceId}
                    // An imported selection is the file's, not a seed of ours to prune.
                    mode={isImport ? 'edit' : mode}
                    autoScopeEdges={!isImport}
                />
            )}
            {currentStep === 'preview' && isImport && (
                <ImportSummaryCard
                    targetLabel={importTargetLabel}
                    editedSinceCheck={!!importFilled && !sameJson(
                        formToDefinition(importFilled.base, importFilled.initial, formData),
                        importFilled.base,
                    )}
                />
            )}
            {currentStep === 'preview' && (
                <PreviewStep
                    formData={formData}
                    scopeContext={scopeContext}
                    viewEntityScope={editingView?.content?.entityScope}
                />
            )}
            </>
            )}
        </WizardShell>
        </WizardEntitySeedContext.Provider>
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
