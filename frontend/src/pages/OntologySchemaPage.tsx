/**
 * OntologySchemaPage — Ontology management console (layout shell).
 *
 * Sidebar + detail pane layout. Ontology selection is URL-driven via
 * :ontologyId param so it survives refresh. All sub-panels are extracted
 * into features/ontology/components/.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams, useBlocker } from 'react-router-dom'
import { Loader2, BookOpen, Box, GitBranch, FolderTree, BarChart3, Users, Activity, Settings, X, LayoutDashboard, Trash2, RotateCcw, Clock, AlertTriangle, Unlink } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSemanticLayerAccess } from '@/features/ontology/lib/useSemanticLayerAccess'
import { EntityTypeEditor } from '@/components/schema/EntityTypeEditor'
import { RelationshipTypeEditor } from '@/components/schema/RelationshipTypeEditor'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import { workspaceService } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { fetchSchemaStats, fetchSchemaStatsWithMeta, generateSuggestedName, triggerIntrospectionRefresh } from '@/features/ontology/lib/ontology-utils'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { EntityTypeSummary, EdgeTypeSummary, GraphSchemaStats } from '@/providers/GraphDataProvider'

import { useOntologies, useOntology } from '@/features/ontology/hooks/useOntologies'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { useInvalidateGraphSchema } from '@/hooks/useGraphSchema'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import {
  entityDefToSchema,
  entitySchemaToBackend,
  relDefToSchema,
  relSchemaToBackend,
  humanizeId,
} from '@/features/ontology/lib/ontology-parsers'
import {
  foldEdgeStats,
  foldSimpleStats,
  foldRelTypeRows,
  foldEntityTypeRows,
  canonicalizeRelDefsForSave,
  canonicalizeEntityDefsForSave,
} from '@/features/ontology/lib/caseFold'
import { DEFAULT_REL_VISUAL, type OntologyTab, type EditorPanel, type RelTypeWithClassifications } from '@/features/ontology/lib/ontology-types'

import { OntologyDetailHeader } from '@/features/ontology/components/OntologyDetailHeader'
import { OntologySidebar } from '@/features/ontology/components/OntologySidebar'
import { useAppNotifications } from '@/components/ui/notifications'
import { CreateOntologyDialog } from '@/features/ontology/components/dialogs/CreateOntologyDialog'
import { SchemaPanel } from '@/features/ontology/components/panels/SchemaPanel'
import { HierarchyPanel } from '@/features/ontology/components/panels/HierarchyPanel'
import { CoveragePanel } from '@/features/ontology/components/panels/CoveragePanel'
import { AdoptionMatchSection } from '@/features/ontology/components/panels/AdoptionMatchSection'
import { SourceMappingSection } from '@/features/ontology/components/panels/SourceMappingSection'
import { UsagePanel } from '@/features/ontology/components/panels/UsagePanel'
import { SettingsPanel } from '@/features/ontology/components/panels/SettingsPanel'
import { DeleteConfirmDialog } from '@/features/ontology/components/dialogs/DeleteConfirmDialog'
import { UnsavedChangesDialog } from '@/features/ontology/components/dialogs/UnsavedChangesDialog'
import { PublishConfirmDialog, type PublishCheckRow, type PublishChecks } from '@/features/ontology/components/dialogs/PublishConfirmDialog'
import { ImportDialog } from '@/features/ontology/components/dialogs/ImportDialog'
import { SuggestConfirmDialog } from '@/features/ontology/components/dialogs/SuggestConfirmDialog'
import { ChangesReviewDialog } from '@/features/ontology/components/dialogs/ChangesReviewDialog'
import { ChangesTray } from '@/features/ontology/components/ChangesTray'
import { UnassignConfirmDialog } from '@/features/ontology/components/dialogs/UnassignConfirmDialog'
import { AssignmentManagerDialog } from '@/features/ontology/components/dialogs/AssignmentManagerDialog'
import { OverviewPanel } from '@/features/ontology/components/panels/OverviewPanel'
import { VersionHistoryPanel } from '@/features/ontology/components/panels/VersionHistoryPanel'
import { DeploymentDashboardPanel } from '@/features/ontology/components/panels/DeploymentDashboardPanel'
import { OntologyAlertBanner, type OntologyAlert } from '@/features/ontology/components/OntologyAlertBanner'
import { EvalContextBar } from '@/features/ontology/components/EvalContextBar'
import { DataSourcePicker } from '@/features/ontology/components/DataSourcePicker'
import type { OntologyImpactResponse, OntologyImportResponse } from '@/services/ontologyDefinitionService'
import { PageContainer, pageGeometry } from '@/components/layout/PageContainer'

// ---------------------------------------------------------------------------
// Tab configuration
// ---------------------------------------------------------------------------

const TAB_DEFS: Array<{
  id: OntologyTab
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'schema', label: 'Schema', icon: Box },
  { id: 'hierarchy', label: 'Hierarchy', icon: FolderTree },
  { id: 'coverage', label: 'Coverage', icon: BarChart3 },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'usage', label: 'Usage', icon: Users },
  { id: 'history', label: 'History', icon: Clock },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/** Map legacy tab URLs to new tab IDs for backward compatibility */
const LEGACY_TAB_MAP: Record<string, OntologyTab> = {
  entities: 'schema',
  relationships: 'schema',
  hierarchy: 'hierarchy',
  // Old combined "Adoption" tab is now split; land on Health (the match view).
  adoption: 'health',
  history: 'history',
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export function OntologySchemaPage() {
  const navigate = useNavigate()
  const { ontologyId } = useParams<{ ontologyId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab') || 'overview'
  const activeTab = (LEGACY_TAB_MAP[rawTab] || rawTab) as OntologyTab
  const dashboardMode = searchParams.get('view') === 'dashboard'

  // Who may do what here — RBAC *and* the admin's feature toggles, resolved together.
  //
  // Phase 18 gave readers a read-only page via ``workspace:ontology:manage``. That is still the
  // permission half. The other half is Admin → Features, whose six semantic-layer switches were
  // enforced nowhere: an admin could turn Import off and watch people go on importing. The server
  // refuses those calls now, and this hook keeps the UI from offering a button that will 403.
  const access = useSemanticLayerAccess()

  // ── Workspace context ──────────────────────────────────────────────
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
  const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
  const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
  const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)

  // ── URL ↔ Zustand bidirectional sync ────────────────────────────
  // Guard ref prevents the two effects from ping-ponging each other.
  const syncSourceRef = useRef<'url' | 'zustand' | null>(null)

  // URL → Zustand (on mount or when URL params change via external navigation)
  useEffect(() => {
    if (syncSourceRef.current === 'zustand') {
      syncSourceRef.current = null
      return
    }
    const urlWs = searchParams.get('workspaceId')
    const urlDs = searchParams.get('dataSourceId')
    if (urlWs && urlWs !== activeWorkspaceId) {
      syncSourceRef.current = 'url'
      setActiveWorkspace(urlWs)
    }
    if (urlDs && urlDs !== activeDataSourceId) {
      syncSourceRef.current = 'url'
      setActiveDataSource(urlDs)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Zustand → URL (when user switches via EnvironmentSwitcher)
  useEffect(() => {
    if (syncSourceRef.current === 'url') {
      syncSourceRef.current = null
      return
    }
    if (!activeWorkspaceId) return
    const currentWs = searchParams.get('workspaceId')
    const currentDs = searchParams.get('dataSourceId')
    if (currentWs !== activeWorkspaceId || (activeDataSourceId && currentDs !== activeDataSourceId)) {
      syncSourceRef.current = 'zustand'
      setSearchParams(prev => {
        prev.set('workspaceId', activeWorkspaceId)
        if (activeDataSourceId) prev.set('dataSourceId', activeDataSourceId)
        else prev.delete('dataSourceId')
        return prev
      }, { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, activeDataSourceId])

  // Helper: set tab while preserving workspace/data source params
  const setTab = useCallback((tab: string) => {
    setSearchParams(prev => {
      prev.set('tab', tab)
      prev.delete('view')  // exit dashboard mode when switching tabs
      return prev
    })
  }, [setSearchParams])

  // Helper: toggle dashboard view
  const toggleDashboard = useCallback(() => {
    setSearchParams(prev => {
      if (prev.get('view') === 'dashboard') prev.delete('view')
      else prev.set('view', 'dashboard')
      return prev
    })
  }, [setSearchParams])

  // Helper: build /schema/:id URL preserving workspace context
  const schemaUrl = useCallback((ontId: string, tab?: string) => {
    const params = new URLSearchParams()
    if (activeWorkspaceId) params.set('workspaceId', activeWorkspaceId)
    if (activeDataSourceId) params.set('dataSourceId', activeDataSourceId)
    if (tab) params.set('tab', tab)
    const qs = params.toString()
    return `/schema/${ontId}${qs ? `?${qs}` : ''}`
  }, [activeWorkspaceId, activeDataSourceId])

  // ── React Query data ───────────────────────────────────────────────
  const { data: ontologies = [], isLoading: isLoadingOntologies } = useOntologies()
  const { data: selectedOntology } = useOntology(ontologyId)
  useDocumentTitle(selectedOntology?.name ? `${selectedOntology.name} · Schema` : 'Schema')
  const mutations = useOntologyMutations()
  // Invalidate the cached graph schema whenever a data-source-to-ontology
  // assignment changes. useOntologyMutations already does this for ontology
  // CRUD, but workspaceService.updateDataSource calls below bypass that
  // hook — they still change which ontology the graph is resolved against,
  // so the schema cache must be evicted or the next fetcher will serve
  // stale data.
  const invalidateGraphSchema = useInvalidateGraphSchema()

  // ── Local state ────────────────────────────────────────────────────
  const [editorPanel, setEditorPanel] = useState<EditorPanel>(null)
  const { notify } = useAppNotifications()
  const [search, setSearch] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [isAssigning, setIsAssigning] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [publishImpact, setPublishImpact] = useState<OntologyImpactResponse | null>(null)
  const [publishChecks, setPublishChecks] = useState<PublishChecks | null>(null)
  const [isPublishing, setIsPublishing] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    isValid: boolean
    issues: Array<{ severity: string; message: string; code?: string; affected?: string }>
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null)
  const [showSuggestDialog, setShowSuggestDialog] = useState(false)
  // 'matches' opens the Assignment Manager on its coverage-ranked tab (the old Find Data Sources dialog).
  const [assignmentManagerTab, setAssignmentManagerTab] = useState<'all' | 'matches'>('all')
  // Pre-seed suggest dialog from dashboard (specific DS context)
  const [suggestPreSeed, setSuggestPreSeed] = useState<{ wsId: string; dsId: string } | null>(null)
  const suggestResponseRef = useRef<import('@/services/ontologyDefinitionService').OntologySuggestResponse | null>(null)
  const [showAssignmentManager, setShowAssignmentManager] = useState(false)
  // Unassign confirmation
  const [unassignTarget, setUnassignTarget] = useState<{
    wsId: string; dsId: string; dsLabel: string; wsName: string; ontologyName: string | null
  } | null>(null)
  // Bulk unassign confirmation (Deployment Dashboard multi-select)
  const [bulkUnassignTargets, setBulkUnassignTargets] = useState<
    Array<{ workspaceId: string; dataSourceId: string; dataSourceLabel: string }> | null
  >(null)

  // ── Edit mode + working copies (lazy initialization) ────────────
  // No explicit isEditing toggle — working copies are created on first edit attempt.
  const [workingEntityDefs, setWorkingEntityDefs] = useState<Record<string, unknown> | null>(null)
  const [workingRelDefs, setWorkingRelDefs] = useState<Record<string, unknown> | null>(null)
  const [workingContainment, setWorkingContainment] = useState<string[] | null>(null)
  const [workingLineage, setWorkingLineage] = useState<string[] | null>(null)
  const [workingDetails, setWorkingDetails] = useState<{ name: string; description: string; evolutionPolicy: string } | null>(null)
  const [showChangesReview, setShowChangesReview] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  // ── Derived ────────────────────────────────────────────────────────
  const isDeleted = !!selectedOntology?.deletedAt
  const isImmutable = !selectedOntology || selectedOntology.isSystem || selectedOntology.isPublished || isDeleted
  const isLocked = isImmutable  // simplified: no isEditing check, drafts are always editable
  const isInEditMode = !!workingEntityDefs  // true when working copies exist

  // Use working copies when available, otherwise server data
  const effectiveEntityDefs = useMemo(() => {
    if (workingEntityDefs) return workingEntityDefs
    return (selectedOntology?.entityTypeDefinitions as Record<string, unknown>) ?? {}
  }, [workingEntityDefs, selectedOntology])

  const effectiveRelDefs = useMemo(() => {
    if (workingRelDefs) return workingRelDefs
    return (selectedOntology?.relationshipTypeDefinitions as Record<string, unknown>) ?? {}
  }, [workingRelDefs, selectedOntology])

  // Raw rows straight from the ontology defs — folded below (after graph stats load) so that
  // case-variant keys collapse into one canonical row.
  const entityTypesRaw = useMemo((): EntityTypeSchema[] => {
    return Object.entries(effectiveEntityDefs as Record<string, Record<string, unknown>>)
      .map(([id, def]) => entityDefToSchema(id, def))
      .sort((a, b) => a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name))
  }, [effectiveEntityDefs])

  const relTypesRaw = useMemo((): RelTypeWithClassifications[] => {
    return Object.entries(effectiveRelDefs as Record<string, Record<string, unknown>>)
      .map(([id, def]) => relDefToSchema(id, def))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [effectiveRelDefs])

  // Detect pending changes (deep comparison against server state — reverting an
  // edit back to its original value automatically clears the dirty state)
  const hasDetailChanges = useMemo(() => {
    if (!workingDetails || !selectedOntology) return false
    return workingDetails.name !== selectedOntology.name ||
      workingDetails.description !== (selectedOntology.description ?? '') ||
      workingDetails.evolutionPolicy !== (selectedOntology.evolutionPolicy ?? 'reject')
  }, [workingDetails, selectedOntology])

  const hasPendingChanges = useMemo(() => {
    if (hasDetailChanges) return true
    if (!isInEditMode || !selectedOntology) return false
    // Key-order-insensitive map compare: staging then reverting a type appends
    // the key at a different position — that must NOT read as a change.
    const defsDiffer = (working: Record<string, unknown>, server: Record<string, unknown>) => {
      const workingKeys = Object.keys(working)
      if (workingKeys.length !== Object.keys(server).length) return true
      return workingKeys.some(k => JSON.stringify(working[k]) !== JSON.stringify(server[k]))
    }
    const listsDiffer = (working: string[], server: string[]) =>
      JSON.stringify([...working].sort()) !== JSON.stringify([...server].sort())
    if (workingEntityDefs && defsDiffer(workingEntityDefs, (selectedOntology.entityTypeDefinitions ?? {}) as Record<string, unknown>)) return true
    if (workingRelDefs && defsDiffer(workingRelDefs, (selectedOntology.relationshipTypeDefinitions ?? {}) as Record<string, unknown>)) return true
    if (workingContainment && listsDiffer(workingContainment, selectedOntology.containmentEdgeTypes ?? [])) return true
    if (workingLineage && listsDiffer(workingLineage, selectedOntology.lineageEdgeTypes ?? [])) return true
    return false
  }, [hasDetailChanges, isInEditMode, selectedOntology, workingEntityDefs, workingRelDefs, workingContainment, workingLineage])

  // Track which individual entity/rel IDs have been modified
  const changedEntityIds = useMemo((): Set<string> => {
    if (!isInEditMode || !selectedOntology || !workingEntityDefs) return new Set()
    const serverDefs = (selectedOntology.entityTypeDefinitions as Record<string, unknown>) ?? {}
    const changed = new Set<string>()
    const allIds = new Set([...Object.keys(serverDefs), ...Object.keys(workingEntityDefs)])
    for (const id of allIds) {
      if (JSON.stringify(serverDefs[id]) !== JSON.stringify(workingEntityDefs[id])) {
        changed.add(id)
      }
    }
    return changed
  }, [isInEditMode, selectedOntology, workingEntityDefs])

  const changedRelIds = useMemo((): Set<string> => {
    if (!isInEditMode || !selectedOntology || !workingRelDefs) return new Set()
    const serverDefs = (selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}
    const changed = new Set<string>()
    const allIds = new Set([...Object.keys(serverDefs), ...Object.keys(workingRelDefs)])
    for (const id of allIds) {
      if (JSON.stringify(serverDefs[id]) !== JSON.stringify(workingRelDefs[id])) {
        changed.add(id)
      }
    }
    return changed
  }, [isInEditMode, selectedOntology, workingRelDefs])

  // Types staged for removal (present on the server, absent from the working
  // copy) — rendered as ghost rows with a Restore affordance until Save All.
  const removedEntityTypes = useMemo((): EntityTypeSchema[] => {
    if (!workingEntityDefs || !selectedOntology) return []
    const serverDefs = (selectedOntology.entityTypeDefinitions as Record<string, Record<string, unknown>>) ?? {}
    return Object.keys(serverDefs)
      .filter(id => !(id in workingEntityDefs))
      .map(id => entityDefToSchema(id, serverDefs[id]))
  }, [workingEntityDefs, selectedOntology])

  const removedRelTypes = useMemo((): RelTypeWithClassifications[] => {
    if (!workingRelDefs || !selectedOntology) return []
    const serverDefs = (selectedOntology.relationshipTypeDefinitions as Record<string, Record<string, unknown>>) ?? {}
    return Object.keys(serverDefs)
      .filter(id => !(id in workingRelDefs))
      .map(id => relDefToSchema(id, serverDefs[id]))
  }, [workingRelDefs, selectedOntology])

  const hasEntityChanges = changedEntityIds.size > 0
  const hasContainmentListChanges = !!(workingContainment &&
    JSON.stringify(workingContainment) !== JSON.stringify(selectedOntology?.containmentEdgeTypes ?? []))
  const hasRelChanges = changedRelIds.size > 0 ||
    hasContainmentListChanges ||
    (workingLineage && JSON.stringify(workingLineage) !== JSON.stringify(selectedOntology?.lineageEdgeTypes ?? []))
  // Hierarchy tab dot: only actual hierarchy edits (reparenting / containment
  // list), not appearance-only entity changes like icon or color.
  const hasHierarchyChanges = useMemo(() => {
    if (hasContainmentListChanges) return true
    if (!isInEditMode || !selectedOntology || !workingEntityDefs) return false
    const serverDefs = (selectedOntology.entityTypeDefinitions as Record<string, Record<string, unknown>>) ?? {}
    const working = workingEntityDefs as Record<string, Record<string, unknown>>
    const allIds = new Set([...Object.keys(serverDefs), ...Object.keys(working)])
    for (const id of allIds) {
      if (JSON.stringify(serverDefs[id]?.hierarchy) !== JSON.stringify(working[id]?.hierarchy)) return true
    }
    return false
  }, [hasContainmentListChanges, isInEditMode, selectedOntology, workingEntityDefs])

  const assignmentCountMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId) m.set(ds.ontologyId, (m.get(ds.ontologyId) ?? 0) + 1)
      }
    }
    return m
  }, [workspaces])

  // ── Contextual alerts ──────────────────────────────────────────────
  const orphanDsCount = useMemo(() => {
    let count = 0
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (!ds.ontologyId) count++
      }
    }
    return count
  }, [workspaces])

  const contextAlerts = useMemo((): OntologyAlert[] => {
    const alerts: OntologyAlert[] = []
    if (orphanDsCount > 0) {
      alerts.push({
        id: 'orphan-ds',
        severity: 'warning',
        icon: AlertTriangle,
        title: `${orphanDsCount} data source${orphanDsCount !== 1 ? 's' : ''} without a semantic layer.`,
        description: '',
        action: { label: 'View Dashboard', onClick: () => { if (!dashboardMode) toggleDashboard() } },
      })
    }
    if (selectedOntology && !selectedOntology.isSystem && (assignmentCountMap.get(selectedOntology.id) ?? 0) === 0) {
      alerts.push({
        id: 'unassigned-ontology',
        severity: 'info',
        icon: Unlink,
        title: 'This ontology is not assigned to any data source.',
        description: '',
        action: { label: 'Find Matches', onClick: () => { setAssignmentManagerTab('matches'); setShowAssignmentManager(true) } },
      })
    }
    return alerts
  }, [orphanDsCount, selectedOntology, assignmentCountMap, dashboardMode, toggleDashboard])

  // ── Edit mode helpers ─────────────────────────────────────────────
  /** Lazily create working copies on first edit attempt. Returns false if immutable. */
  function ensureEditMode(): boolean {
    if (isImmutable || !selectedOntology) return false
    if (!workingEntityDefs) {
      setWorkingEntityDefs({ ...((selectedOntology.entityTypeDefinitions as Record<string, unknown>) ?? {}) })
      setWorkingRelDefs({ ...((selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}) })
      setWorkingContainment([...(selectedOntology.containmentEdgeTypes ?? [])])
      setWorkingLineage([...(selectedOntology.lineageEdgeTypes ?? [])])
    }
    return true
  }

  function discardChanges() {
    if (hasPendingChanges) {
      setShowDiscardConfirm(true)
      return
    }
    doDiscard()
  }

  function doDiscard() {
    setWorkingEntityDefs(null)
    setWorkingRelDefs(null)
    setWorkingContainment(null)
    setWorkingLineage(null)
    setWorkingDetails(null)
    setEditorPanel(null)
    setShowDiscardConfirm(false)
  }

  /** Returns true when the save persisted (or there was nothing to save),
   *  false when it failed — callers like the navigation blocker must not
   *  proceed with navigation after a failed save. */
  async function handleSaveAllChanges(): Promise<boolean> {
    if (!selectedOntology || !hasPendingChanges) return true
    setIsSaving(true)
    try {
      const req: Record<string, unknown> = {}
      if (workingEntityDefs) {
        // Collapse any case-variant entity keys to one canonical key (rewriting hierarchy
        // references) so the payload can't trip the backend's case-insensitive collision guard.
        req.entityTypeDefinitions = canonicalizeEntityDefsForSave(workingEntityDefs, entityStatFold).entityDefs
      }
      if (workingRelDefs) {
        // Built-in edges (e.g. AGGREGATED) are injected on read, marked is_system, and
        // shown read-only. Never send them back — the backend strips them too, but keeping
        // the payload clean avoids a pointless round-trip and any reconciliation on them.
        const nonSystem = Object.fromEntries(
          Object.entries(workingRelDefs).filter(([, def]) => !(def as Record<string, unknown>)?.is_system)
        )
        // Fold case-variant declared keys into ONE canonical key (the design's canonical fold),
        // OR-ing classification and aligning the containment/lineage list casing. Without this an
        // ontology that still carries both `TO` and `To` would 422 on the case-insensitive guard the
        // moment the (now-unblocked) editor lets the user save.
        const canon = canonicalizeRelDefsForSave(
          nonSystem,
          workingContainment ?? selectedOntology.containmentEdgeTypes ?? [],
          workingLineage ?? selectedOntology.lineageEdgeTypes ?? [],
          edgeFold,
        )
        req.relationshipTypeDefinitions = canon.relDefs
        req.containmentEdgeTypes = canon.containment
        req.lineageEdgeTypes = canon.lineage
      } else {
        if (workingContainment) req.containmentEdgeTypes = workingContainment
        if (workingLineage) req.lineageEdgeTypes = workingLineage
      }
      if (workingDetails) {
        req.name = workingDetails.name
        // Empty string is a valid value — the user cleared the description.
        req.description = workingDetails.description
        req.evolutionPolicy = workingDetails.evolutionPolicy
      }

      await mutations.update.mutateAsync({ id: selectedOntology.id, req })
      notify('success', 'All changes saved — views on this semantic layer will pick them up automatically')
      doDiscard()
      return true
    } catch (err: unknown) {
      notify('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
      return false
    } finally {
      setIsSaving(false)
    }
  }

  // ── Navigation guards ───────────────────────────────────────────
  // Browser close / reload
  useEffect(() => {
    if (!hasPendingChanges) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to actually show the leave-confirmation.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasPendingChanges])

  // React Router navigation — only block actual route changes, not tab/param changes
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!hasPendingChanges) return false
    // Allow same-path navigation (tab switches, search param changes)
    if (currentLocation.pathname === nextLocation.pathname) return false
    // Block everything else — including ontology-to-ontology switches within
    // /schema/, which would silently drop the working copies.
    return true
  })

  // ── Auto-activate dashboard when landing on /schema with no ontology selected ──
  useEffect(() => {
    if (!ontologyId && !dashboardMode) {
      setSearchParams(prev => {
        prev.set('view', 'dashboard')
        return prev
      }, { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyId])

  // ── Load workspaces ────────────────────────────────────────────────
  useEffect(() => { loadWorkspaces() }, [loadWorkspaces])

  // Clear editor / validation / edit mode on ontology change
  useEffect(() => {
    setEditorPanel(null)
    setValidationResult(null)
    setSearch('')
    setEvalOverrideWsId(null)
    setEvalOverrideDsId(null)
    setShowEvalPicker(false)
    discardChanges()
  }, [ontologyId])

  // ── Auto-select evaluation target from deployments ──────────────
  // When an ontology is selected, auto-pick the first assigned data source
  // as the evaluation target for Coverage/Overview/Suggest features.
  const autoEvalTarget = useMemo(() => {
    if (!selectedOntology) return null
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId === selectedOntology.id) {
          return { workspaceId: ws.id, dataSourceId: ds.id }
        }
      }
    }
    return null
  }, [selectedOntology, workspaces])

  // User can explicitly override the evaluation target (e.g. from CoveragePanel)
  const [evalOverrideWsId, setEvalOverrideWsId] = useState<string | null>(null)
  const [evalOverrideDsId, setEvalOverrideDsId] = useState<string | null>(null)
  // Target picker opened from the EvalContextBar's "Change" affordance
  const [showEvalPicker, setShowEvalPicker] = useState(false)

  // Priority: explicit override > auto-selected from deployments > Zustand store
  const evalWorkspaceId = evalOverrideWsId ?? autoEvalTarget?.workspaceId ?? activeWorkspaceId
  const evalDataSourceId = evalOverrideDsId ?? autoEvalTarget?.dataSourceId ?? activeDataSourceId

  // Graph stat maps — live instance counts per type from the evaluation data
  // source's cached stats, so the Schema panel can show "N in graph" chips.
  // Keyed lowercased (the panels look up et.id.toLowerCase()).
  const [graphStats, setGraphStats] = useState<GraphSchemaStats | null>(null)
  useEffect(() => {
    let cancelled = false
    setGraphStats(null)
    if (!evalWorkspaceId) return
    fetchSchemaStats(evalWorkspaceId, evalDataSourceId ?? undefined)
      .then(stats => { if (!cancelled) setGraphStats(stats) })
      .catch(() => { /* stats are decorative — panels degrade to no counts */ })
    return () => { cancelled = true }
  }, [evalWorkspaceId, evalDataSourceId])

  // Fold physical graph stats by case-fold. FalkorDB is case-sensitive, so `To`/`to`/`TO` arrive as
  // separate stats even though they are ONE ontology type; summing here gives each declared type its
  // true total and preserves every spelling for the "also seen as" merge badge.
  const edgeFold = useMemo(() => foldEdgeStats(graphStats?.edgeTypeStats ?? []), [graphStats])
  const entityStatFold = useMemo(() => foldSimpleStats(graphStats?.entityTypeStats ?? []), [graphStats])

  const entityStatMap = useMemo((): Map<string, EntityTypeSummary> => {
    const m = new Map<string, EntityTypeSummary>()
    const byId = new Map((graphStats?.entityTypeStats ?? []).map(s => [s.id, s]))
    for (const [key, e] of entityStatFold) {
      const rep = [...e.spellings].sort((a, b) => b.count - a.count)[0]?.spelling ?? key
      const base = byId.get(rep)
      m.set(key, { ...(base ?? { id: rep, name: rep, sampleNames: [] }), id: rep, name: rep, count: e.total })
    }
    return m
  }, [entityStatFold, graphStats])

  const edgeStatMap = useMemo((): Map<string, EdgeTypeSummary> => {
    const m = new Map<string, EdgeTypeSummary>()
    for (const [key, e] of edgeFold) {
      const rep = [...e.spellings].sort((a, b) => b.count - a.count)[0]?.spelling ?? key
      m.set(key, { id: rep, name: rep, count: e.total, sourceTypes: e.sourceTypes, targetTypes: e.targetTypes })
    }
    return m
  }, [edgeFold])

  // Canonical fold: collapse case-variant rows into one row per declared type and carry the merged
  // spellings (declared duplicates + physical graph spellings) for the "also seen as" badge.
  const { rows: entityTypes, variantsById: entityVariants } = useMemo(
    () => foldEntityTypeRows(entityTypesRaw, entityStatFold),
    [entityTypesRaw, entityStatFold],
  )
  const { rows: relTypes, variantsById: relVariants } = useMemo(
    () => foldRelTypeRows(relTypesRaw, edgeFold),
    [relTypesRaw, edgeFold],
  )


  // Resolved eval context objects for display
  const evalWorkspace = useMemo(
    () => workspaces.find(w => w.id === evalWorkspaceId) ?? null,
    [workspaces, evalWorkspaceId],
  )
  const evalDataSource = useMemo(
    () => evalWorkspace?.dataSources?.find(ds => ds.id === evalDataSourceId) ?? null,
    [evalWorkspace, evalDataSourceId],
  )

  // ── Handlers ───────────────────────────────────────────────────────

  /** Assign the current ontology to a specific data source (ontology-centric) */
  /** Assign an ontology to a data source. Defaults to the currently selected
   *  ontology; dashboard mode passes an explicit id (no selection there).
   *  Returns true when the assignment persisted. */
  async function handleAssignToDataSource(workspaceId: string, dataSourceId: string, ontologyId?: string): Promise<boolean> {
    const targetOntologyId = ontologyId ?? selectedOntology?.id
    if (!targetOntologyId) return false
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(workspaceId, dataSourceId, {
        ontologyId: targetOntologyId,
      })
      await loadWorkspaces()
      invalidateGraphSchema()
      notify('success', 'Schema assigned to data source')
      return true
    } catch (err: unknown) {
      notify('error', `Assignment failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      return false
    } finally {
      setIsAssigning(false)
    }
  }

  /** Request unassign — opens confirmation dialog with context */
  function requestUnassign(workspaceId: string, dataSourceId: string) {
    const ws = workspaces.find(w => w.id === workspaceId)
    const ds = ws?.dataSources?.find(d => d.id === dataSourceId)
    const ont = ds?.ontologyId ? ontologies.find(o => o.id === ds.ontologyId) : null
    setUnassignTarget({
      wsId: workspaceId,
      dsId: dataSourceId,
      dsLabel: ds?.label || ds?.id || dataSourceId,
      wsName: ws?.name || workspaceId,
      ontologyName: ont?.name ?? null,
    })
  }

  /** Execute unassign after confirmation */
  async function handleConfirmUnassign() {
    if (!unassignTarget) return
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(unassignTarget.wsId, unassignTarget.dsId, { ontologyId: '' })
      await loadWorkspaces()
      invalidateGraphSchema()
      notify('success', 'Schema unassigned from data source')
      setUnassignTarget(null)
    } catch (err: unknown) {
      notify('error', `Unassign failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  /** Bulk unassign (Deployment Dashboard selection) — one count-based confirm,
   *  then a settled batch with honest partial-failure reporting. Replaces the
   *  old forEach-into-single-dialog path where only the LAST selected source
   *  ever got confirmed/unassigned. */
  async function handleConfirmBulkUnassign() {
    if (!bulkUnassignTargets || bulkUnassignTargets.length === 0) return
    const targets = bulkUnassignTargets
    setIsAssigning(true)
    try {
      const results = await Promise.allSettled(targets.map(t =>
        workspaceService.updateDataSource(t.workspaceId, t.dataSourceId, { ontologyId: '' })))
      await loadWorkspaces()
      invalidateGraphSchema()
      const ok = results.filter(r => r.status === 'fulfilled').length
      if (ok === targets.length) {
        notify('success', `Unassigned ${ok} data source${ok !== 1 ? 's' : ''}`)
      } else {
        const failed = targets
          .filter((_, i) => results[i].status === 'rejected')
          .map(t => t.dataSourceLabel)
        notify('error',
          `Unassigned ${ok} of ${targets.length} — failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`)
      }
      setBulkUnassignTargets(null)
    } finally {
      setIsAssigning(false)
    }
  }

  /** Roll out the current ontology to ALL data sources in a workspace.
   *  Settled batch: one failing source no longer hides the ones that
   *  succeeded — the notification reports the real count. */
  async function handleRollOutToWorkspace(workspaceId: string) {
    if (!selectedOntology) return
    const ws = workspaces.find(w => w.id === workspaceId)
    if (!ws) return
    const targets = ws.dataSources ?? []
    setIsAssigning(true)
    try {
      const results = await Promise.allSettled(targets.map(ds =>
        workspaceService.updateDataSource(workspaceId, ds.id, { ontologyId: selectedOntology.id })))
      await loadWorkspaces()
      invalidateGraphSchema()
      const ok = results.filter(r => r.status === 'fulfilled').length
      if (ok === targets.length) {
        notify('success', `Schema rolled out to all ${ok} data source${ok !== 1 ? 's' : ''} in "${ws.name}"`)
      } else {
        const failed = targets
          .filter((_, i) => results[i].status === 'rejected')
          .map(ds => ds.label || ds.id)
        notify('error',
          `Rolled out to ${ok} of ${targets.length} in "${ws.name}" — failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`)
      }
    } finally {
      setIsAssigning(false)
    }
  }

  function handleSaveEntityType(entityType: EntityTypeSchema) {
    if (!selectedOntology || !workingEntityDefs) return
    if (isLocked) { notify('warning', 'Clone this semantic layer to make edits'); return }

    const currentDefs = { ...(workingEntityDefs as Record<string, Record<string, unknown>>) }

    const oldDef = currentDefs[entityType.id]
    const oldHierarchy = (oldDef?.hierarchy as Record<string, unknown>) ?? {}
    const oldCanContain: string[] = (oldHierarchy.can_contain as string[]) ?? []
    const oldCanBeContainedBy: string[] = (oldHierarchy.can_be_contained_by as string[]) ?? []
    const newCanContain = entityType.hierarchy.canContain
    const newCanBeContainedBy = entityType.hierarchy.canBeContainedBy

    const updatedDefs: Record<string, unknown> = {
      ...currentDefs,
      [entityType.id]: entitySchemaToBackend(entityType),
    }

    // Bidirectional sync — canContain side
    for (const childId of oldCanContain.filter(c => !newCanContain.includes(c))) {
      if (updatedDefs[childId]) {
        const d = updatedDefs[childId] as Record<string, unknown>
        const h = (d.hierarchy as Record<string, unknown>) ?? {}
        updatedDefs[childId] = { ...d, hierarchy: { ...h, can_be_contained_by: ((h.can_be_contained_by as string[]) ?? []).filter(p => p !== entityType.id) } }
      }
    }
    for (const childId of newCanContain.filter(c => !oldCanContain.includes(c))) {
      if (updatedDefs[childId]) {
        const d = updatedDefs[childId] as Record<string, unknown>
        const h = (d.hierarchy as Record<string, unknown>) ?? {}
        const existing: string[] = (h.can_be_contained_by as string[]) ?? []
        if (!existing.includes(entityType.id)) {
          updatedDefs[childId] = { ...d, hierarchy: { ...h, can_be_contained_by: [...existing, entityType.id] } }
        }
      }
    }

    // Bidirectional sync — canBeContainedBy side
    for (const parentId of oldCanBeContainedBy.filter(p => !newCanBeContainedBy.includes(p))) {
      if (updatedDefs[parentId]) {
        const d = updatedDefs[parentId] as Record<string, unknown>
        const h = (d.hierarchy as Record<string, unknown>) ?? {}
        updatedDefs[parentId] = { ...d, hierarchy: { ...h, can_contain: ((h.can_contain as string[]) ?? []).filter(c => c !== entityType.id) } }
      }
    }
    for (const parentId of newCanBeContainedBy.filter(p => !oldCanBeContainedBy.includes(p))) {
      if (updatedDefs[parentId]) {
        const d = updatedDefs[parentId] as Record<string, unknown>
        const h = (d.hierarchy as Record<string, unknown>) ?? {}
        const existing: string[] = (h.can_contain as string[]) ?? []
        if (!existing.includes(entityType.id)) {
          updatedDefs[parentId] = { ...d, hierarchy: { ...h, can_contain: [...existing, entityType.id] } }
        }
      }
    }

    setWorkingEntityDefs(updatedDefs)
    notify('info', `"${entityType.name}" updated — save to persist`)
    setEditorPanel(null)
  }

  function handleSaveRelType(relType: RelTypeWithClassifications) {
    if (!selectedOntology || !workingRelDefs) return
    if (relType.isSystem) {
      notify('info', `"${relType.name}" is a built-in edge maintained by the platform — it can't be edited.`)
      setEditorPanel(null)
      return
    }
    if (isLocked) { notify('warning', 'Clone this semantic layer to make edits'); return }

    // Type ids are opaque identifiers — preserve the declared casing verbatim. Normalizing
    // here (previously .toUpperCase()) corrupted any ontology whose ids aren't uppercase:
    // it added a second, differently-cased key (Has + HAS) and pushed the uppercased id into
    // the containment/lineage lists, which the backend then rejected as a duplicate type.
    const relId = relType.id
    const updatedRelDefs = {
      ...workingRelDefs,
      [relId]: relSchemaToBackend(relType),
    }

    let containment = [...(workingContainment ?? selectedOntology.containmentEdgeTypes ?? [])]
    if (relType.isContainment) {
      if (!containment.includes(relId)) containment.push(relId)
    } else {
      containment = containment.filter(t => t !== relId)
    }

    let lineage = [...(workingLineage ?? selectedOntology.lineageEdgeTypes ?? [])]
    if (relType.isLineage) {
      if (!lineage.includes(relId)) lineage.push(relId)
    } else {
      lineage = lineage.filter(t => t !== relId)
    }

    setWorkingRelDefs(updatedRelDefs)
    setWorkingContainment(containment)
    setWorkingLineage(lineage)
    notify('info', `"${relType.name}" updated — save to persist`)
    setEditorPanel(null)
  }

  // Type deletion is STAGED (nothing hits the server until Save All), so no
  // scary confirm — remove immediately with a one-click Undo, matching the
  // ontology-level delete-with-undo pattern. Deletion may be the FIRST edit,
  // so compute the base from the server snapshot when no working copy exists
  // yet (ensureEditMode's setState hasn't landed within this tick).
  function handleDeleteEntityType(id: string, name: string) {
    if (!selectedOntology || isLocked || !ensureEditMode()) return
    const base = workingEntityDefs ?? { ...((selectedOntology.entityTypeDefinitions as Record<string, unknown>) ?? {}) }
    const removedDef = base[id]
    const defs = { ...base }
    delete defs[id]
    setWorkingEntityDefs(defs)
    notify('info', `"${name}" removed — save to persist`, {
      label: 'Undo',
      onClick: () => setWorkingEntityDefs(prev => ({ ...(prev ?? {}), [id]: removedDef })),
    })
  }

  function handleDeleteRelType(id: string, name: string) {
    if (!selectedOntology || isLocked || !ensureEditMode()) return
    const base = workingRelDefs ?? { ...((selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}) }
    const removedDef = base[id]
    const defs = { ...base }
    delete defs[id]
    setWorkingRelDefs(defs)
    notify('info', `"${name}" removed — save to persist`, {
      label: 'Undo',
      onClick: () => setWorkingRelDefs(prev => ({ ...(prev ?? {}), [id]: removedDef })),
    })
  }

  /** Restore a type staged for removal (ghost row) from the server copy. */
  function handleRestoreEntityType(id: string) {
    if (!selectedOntology || !workingEntityDefs) return
    const serverDef = (selectedOntology.entityTypeDefinitions as Record<string, unknown>)?.[id]
    if (serverDef === undefined) return
    setWorkingEntityDefs({ ...workingEntityDefs, [id]: serverDef })
  }

  function handleRestoreRelType(id: string) {
    if (!selectedOntology || !workingRelDefs) return
    const serverDef = (selectedOntology.relationshipTypeDefinitions as Record<string, unknown>)?.[id]
    if (serverDef === undefined) return
    setWorkingRelDefs({ ...workingRelDefs, [id]: serverDef })
  }

  // ── ChangesTray: per-change revert + jump ─────────────────────────
  /** Revert ONE type back to server state: restore modified/removed, drop added. */
  function handleRevertEntityChange(id: string) {
    if (!selectedOntology || !workingEntityDefs) return
    const serverDef = (selectedOntology.entityTypeDefinitions as Record<string, unknown>)?.[id]
    const next = { ...workingEntityDefs }
    if (serverDef === undefined) delete next[id]
    else next[id] = serverDef
    setWorkingEntityDefs(next)
    if (editorPanel?.kind === 'entity' && editorPanel.data?.id === id) setEditorPanel(null)
  }

  function handleRevertRelChange(id: string) {
    if (!selectedOntology || !workingRelDefs) return
    const serverDef = (selectedOntology.relationshipTypeDefinitions as Record<string, unknown>)?.[id]
    const next = { ...workingRelDefs }
    if (serverDef === undefined) delete next[id]
    else next[id] = serverDef
    setWorkingRelDefs(next)
    if (editorPanel?.kind === 'rel' && editorPanel.data?.id === id) setEditorPanel(null)
  }

  function handleRevertClassification() {
    if (!selectedOntology) return
    setWorkingContainment([...(selectedOntology.containmentEdgeTypes ?? [])])
    setWorkingLineage([...(selectedOntology.lineageEdgeTypes ?? [])])
  }

  function handleJumpToType(scope: 'entity' | 'rel', id: string) {
    // 'relationships' is a legacy tab id that maps to schema + relationships sub-view.
    setTab(scope === 'rel' ? 'relationships' : 'schema')
    if (scope === 'entity') {
      // Give the tab switch a frame to mount the panel before scrolling.
      setTimeout(() => {
        document.getElementById(`entity-type-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 150)
    }
  }

  function handleSuggestOntology() {
    suggestResponseRef.current = null
    setSuggestPreSeed(null)
    setShowSuggestDialog(true)
  }

  /** Open suggest dialog pre-seeded with a specific data source (from dashboard) */
  function handleSuggestForDataSource(workspaceId: string, dataSourceId: string) {
    suggestResponseRef.current = null
    setSuggestPreSeed({ wsId: workspaceId, dsId: dataSourceId })
    setShowSuggestDialog(true)
  }

  /** Phase 2: analyze the graph, return matches + counts for the dialog to display.
   *  Uses the Postgres-cached stats when available; surfaces freshness so the
   *  dialog can offer a refresh button if the cache is stale. */
  async function handleAnalyzeGraph(workspaceId: string, dataSourceId: string) {
    const { stats, freshness } = await fetchSchemaStatsWithMeta(workspaceId, dataSourceId)
    const response = await ontologyDefinitionService.suggest(stats as unknown as Record<string, unknown>)
    suggestResponseRef.current = response
    return {
      matches: response.matchingOntologies,
      suggestedEntityCount: Object.keys(response.suggested.entityTypeDefinitions ?? {}).length,
      suggestedRelCount: Object.keys(response.suggested.relationshipTypeDefinitions ?? {}).length,
      mergedVariants: response.mergedVariants ?? {},
      freshness,
    }
  }

  /** Trigger a non-blocking background refresh of the Postgres schema cache
   *  for the given data source. Returns the job ID so the dialog can poll. */
  async function handleRefreshIntrospection(workspaceId: string, dataSourceId: string) {
    return triggerIntrospectionRefresh(workspaceId, dataSourceId)
  }

  /** Assign an ontology to the target data source picked in the suggest dialog.
   *  Returns true only when an assignment actually succeeded; false when there
   *  was no target to assign to, or the assignment failed. A failure is surfaced
   *  to the user (rather than swallowed) so callers never claim "assigned" when
   *  the data source was left pointing at its old ontology. */
  async function assignOntologyToTarget(ontologyId: string, targetWsId: string | null, targetDsId: string | null): Promise<boolean> {
    if (!targetWsId || !targetDsId) return false
    try {
      await workspaceService.updateDataSource(targetWsId, targetDsId, { ontologyId })
      await loadWorkspaces()
      invalidateGraphSchema()
      return true
    } catch (err: unknown) {
      notify('error', `Could not assign to the data source: ${err instanceof Error ? err.message : 'unknown error'}`)
      return false
    }
  }

  /** User chose "Use This" on an existing match — assign + navigate. */
  async function handleSuggestUseExisting(ontologyId: string, targetWsId: string | null, targetDsId: string | null) {
    setShowSuggestDialog(false)
    const assigned = await assignOntologyToTarget(ontologyId, targetWsId, targetDsId)
    navigate(schemaUrl(ontologyId))
    const dsLabel = targetDsId
      ? workspaces.flatMap(ws => ws.dataSources ?? []).find(ds => ds.id === targetDsId)?.label || targetDsId
      : null
    if (assigned && dsLabel) {
      notify('success', `Assigned to "${dsLabel}" and navigated to the semantic layer`)
    } else if (!targetDsId) {
      notify('success', 'Navigated to the matching semantic layer')
    }
    // A picked-but-failed assignment already surfaced an error notification above —
    // don't paper over it with a success message.

    // Don't throw away the classification Suggest computed: if this layer leaves edges in "Other"
    // that Suggest classified, offer a one-click patch (the whole point of onboarding an existing
    // graph is a working setup, not just matching type names).
    void offerApplySuggestedClassification(ontologyId)
  }

  /** After "Use This existing", if Suggest classified edges the picked layer leaves uncategorized
   *  AND the layer is editable, offer to apply that classification instead of discarding it. */
  async function offerApplySuggestedClassification(ontologyId: string) {
    const response = suggestResponseRef.current
    const match = response?.matchingOntologies.find(m => m.ontologyId === ontologyId)
    const uncategorized = match?.uncategorizedRelationshipTypes ?? []
    if (!response || uncategorized.length === 0) return

    // What did Suggest classify for those edges? (case-insensitive lookup — the suggested draft may
    // key the physical spelling while the layer declares another casing.)
    const suggestedByCf = new Map(
      Object.entries(response.suggested.relationshipTypeDefinitions ?? {})
        .map(([k, v]) => [k.toLowerCase(), v as Record<string, unknown>]),
    )
    const toClassify = uncategorized
      .map(rid => {
        const sd = suggestedByCf.get(rid.toLowerCase())
        const isC = !!(sd?.is_containment ?? sd?.isContainment)
        const isL = !!(sd?.is_lineage ?? sd?.isLineage)
        return isC || isL ? { rid, isC, isL } : null
      })
      .filter((x): x is { rid: string; isC: boolean; isL: boolean } => x !== null)
    if (toClassify.length === 0) return

    let target
    try {
      target = await ontologyDefinitionService.get(ontologyId)
    } catch { return }
    // Only in-place patch an editable draft — a published/system layer must be cloned first.
    if (target.isSystem || target.isPublished) return

    const n = toClassify.length
    notify('info',
      `This layer leaves ${n} edge${n !== 1 ? 's' : ''} the graph uses in "Other" — apply the suggested classification?`,
      {
        label: 'Apply',
        onClick: async () => {
          try {
            const relDefs = { ...(target.relationshipTypeDefinitions as Record<string, Record<string, unknown>>) }
            const containment = [...target.containmentEdgeTypes]
            const lineage = [...target.lineageEdgeTypes]
            for (const { rid, isC, isL } of toClassify) {
              relDefs[rid] = { ...(relDefs[rid] ?? {}), is_containment: isC, is_lineage: isL }
              if (isC && !containment.includes(rid)) containment.push(rid)
              if (isL && !lineage.includes(rid)) lineage.push(rid)
            }
            const req: Record<string, unknown> = {
              relationshipTypeDefinitions: relDefs,
              containmentEdgeTypes: containment,
              lineageEdgeTypes: lineage,
            }
            await mutations.update.mutateAsync({ id: ontologyId, req })
            invalidateGraphSchema()
            notify('success', `Classified ${n} edge${n !== 1 ? 's' : ''} — aggregation and lineage will use them now`)
          } catch (err: unknown) {
            notify('error', `Could not apply classification: ${err instanceof Error ? err.message : 'unknown error'}`)
          }
        },
      },
    )
  }

  /** User chose "Clone & Extend" — clone, assign to target DS, navigate. */
  async function handleSuggestCloneExisting(ontologyId: string, targetWsId: string | null, targetDsId: string | null) {
    setShowSuggestDialog(false)
    try {
      const cloned = await mutations.clone.mutateAsync(ontologyId)
      const assigned = await assignOntologyToTarget(cloned.id, targetWsId, targetDsId)
      navigate(schemaUrl(cloned.id, 'schema'))
      notify('success', assigned
        ? 'Cloned and assigned — now editing a new draft'
        : 'Cloned — now editing a new draft')
    } catch (err: unknown) {
      notify('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  /** User chose "Create New Draft" — create, assign to target DS, navigate. */
  async function handleSuggestCreateDraft(name: string | undefined, targetWsId: string | null, targetDsId: string | null) {
    const response = suggestResponseRef.current
    if (!response) {
      // Reached "Create from Graph" without an analysis run (e.g. after "Skip
      // Analysis"): there is no suggested schema to build from. Tell the user
      // instead of silently doing nothing.
      notify('error', 'Analyze the graph first to create a draft from it.')
      return
    }
    setIsSuggesting(true)
    try {
      const finalName = name || generateSuggestedName(
        evalDataSource?.label,
        evalWorkspace?.name,
        Object.keys(response.suggested.entityTypeDefinitions ?? {}),
      )
      const created = await mutations.create.mutateAsync({
        ...response.suggested,
        name: finalName,
      })
      const assigned = await assignOntologyToTarget(created.id, targetWsId, targetDsId)
      setShowSuggestDialog(false)
      navigate(schemaUrl(created.id, 'schema'))
      notify('info', assigned
        ? 'Draft created and assigned — review types and publish when ready'
        : 'Draft created — review types and publish when ready')
    } catch (err: unknown) {
      notify('error', `Failed to create draft: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSuggesting(false)
    }
  }

  async function handleClone() {
    if (!selectedOntology) return
    try {
      const cloned = await mutations.clone.mutateAsync(selectedOntology.id)
      navigate(schemaUrl(cloned.id))
      notify('success', 'Cloned — now editing an independent copy')
    } catch (err: unknown) {
      notify('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleCreateNewVersion() {
    if (!selectedOntology) return
    try {
      const newVersion = await mutations.createNewVersion.mutateAsync(selectedOntology.id)
      navigate(schemaUrl(newVersion.id))
      notify('success', `Draft v${newVersion.version} created — now editing`)
    } catch (err: unknown) {
      notify('error', `Failed to create new version: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleValidate() {
    if (!selectedOntology) return
    try {
      const result = await mutations.validate.mutateAsync(selectedOntology.id)
      setValidationResult(result)
      if (result.isValid) notify('success', 'Semantic layer is valid')
    } catch (err: unknown) {
      notify('error', `Validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  /** Open the publish dialog with impact PLUS advisory readiness checks
   *  (validation + coverage) fetched in one settled batch. Impact is the only
   *  hard requirement — a failed check FETCH renders as "couldn't check",
   *  never blocking the dialog. */
  async function handlePublish() {
    if (!selectedOntology) return
    const id = selectedOntology.id
    const [impactRes, validateRes, coverageRes] = await Promise.allSettled([
      ontologyDefinitionService.impact(id),
      ontologyDefinitionService.validate(id),
      ontologyDefinitionService.coverageRanking(id, { limit: 100, filter: 'assigned-this' }),
    ])
    if (impactRes.status === 'rejected') {
      const err = impactRes.reason
      notify('error', `Failed to check impact: ${err instanceof Error ? err.message : 'Unknown error'}`)
      return
    }

    let validation: PublishCheckRow
    if (validateRes.status === 'fulfilled') {
      const errors = validateRes.value.issues.filter(i => i.severity === 'error').length
      const warnings = validateRes.value.issues.length - errors
      validation = errors > 0
        ? { status: 'fail', summary: `${errors} error${errors !== 1 ? 's' : ''}${warnings ? ` + ${warnings} warning${warnings !== 1 ? 's' : ''}` : ''}`, tab: 'schema', tabLabel: 'Fix' }
        : warnings > 0
          ? { status: 'warn', summary: `${warnings} warning${warnings !== 1 ? 's' : ''}`, tab: 'schema', tabLabel: 'Review' }
          : { status: 'pass', summary: 'no issues' }
    } else {
      validation = { status: 'unavailable', summary: "couldn't check" }
    }

    let coverage: PublishCheckRow
    if (coverageRes.status === 'fulfilled') {
      const assigned = coverageRes.value.sources
      if (assigned.length === 0) {
        coverage = { status: 'warn', summary: 'no data sources use this schema yet — publishing has no immediate effect', tab: 'usage', tabLabel: 'Assign' }
      } else {
        const profiled = assigned.filter(s => s.profiled && s.coveragePercent != null)
        const worst = profiled.length
          ? Math.min(...profiled.map(s => s.coveragePercent as number))
          : null
        coverage = worst == null
          ? { status: 'warn', summary: `${assigned.length} assigned source${assigned.length !== 1 ? 's' : ''}, none profiled yet`, tab: 'health', tabLabel: 'Review' }
          : worst >= 100
            ? { status: 'pass', summary: `100% across ${assigned.length} assigned source${assigned.length !== 1 ? 's' : ''}` }
            : { status: 'warn', summary: `lowest ${Math.round(worst)}% across ${assigned.length} assigned source${assigned.length !== 1 ? 's' : ''}`, tab: 'coverage', tabLabel: 'Review' }
      }
    } else {
      coverage = { status: 'unavailable', summary: "couldn't check" }
    }

    setPublishChecks({ validation, coverage })
    setPublishImpact(impactRes.value)
  }

  async function handleConfirmPublish(force = false) {
    if (!selectedOntology) return
    setIsPublishing(true)
    try {
      await mutations.publish.mutateAsync({ id: selectedOntology.id, force })
      notify('success', force
        ? 'Force-published — breaking-change protection was overridden'
        : 'Published — active for all assigned data sources')
      setValidationResult(null)
      setPublishImpact(null)
    } catch (err: unknown) {
      notify('error', `Publish failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsPublishing(false)
    }
  }

  async function handleExport() {
    if (!selectedOntology) return
    try {
      const doc = await ontologyDefinitionService.exportJson(selectedOntology.id)
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${selectedOntology.name.replace(/\s+/g, '_')}_v${selectedOntology.version}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      notify('error', `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset input so the same file can be re-selected
    e.target.value = ''

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          notify('error', 'Invalid file: expected a JSON object')
          return
        }
        setImportData(parsed)
      } catch {
        notify('error', 'Invalid file: could not parse JSON')
      }
    }
    reader.onerror = () => notify('error', 'Failed to read file')
    reader.readAsText(file)
  }

  function handleImportSuccess(result: OntologyImportResponse) {
    setImportData(null)
    mutations.invalidateAll()
    if (result.ontology?.id) {
      navigate(schemaUrl(result.ontology.id))
    }
    const messages: Record<string, string> = {
      created: `Imported as new semantic layer "${result.ontology.name}"`,
      updated: `Updated draft with imported changes`,
      new_version: `Created new draft v${result.ontology.version} from import`,
    }
    notify('success', messages[result.status] || result.summary)
  }

  async function handleCreateDraft(name: string, prePopulate: boolean) {
    setShowCreateDialog(false)
    if (prePopulate) {
      setIsSuggesting(true)
      try {
        if (!evalWorkspaceId) throw new Error('No workspace selected')
        const stats = await fetchSchemaStats(evalWorkspaceId, evalDataSourceId ?? undefined)
        const response = await ontologyDefinitionService.suggest(stats as unknown as Record<string, unknown>)
        const created = await mutations.create.mutateAsync({ ...response.suggested, name })
        navigate(schemaUrl(created.id, 'schema'))
        notify('success', `"${name}" created with ${Object.keys(created.entityTypeDefinitions ?? {}).length} entity types from your graph`)
      } catch (err: unknown) {
        notify('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        setIsSuggesting(false)
      }
    } else {
      try {
        const created = await mutations.create.mutateAsync({ name })
        // Empty drafts land where the schema is BUILT (the from-graph path
        // already does) — Overview is a dead end with zero types.
        navigate(schemaUrl(created.id, 'schema'))
        notify('success', 'New draft created')
      } catch (err: unknown) {
        notify('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    }
  }

  function handleDeleteOntology() {
    if (!selectedOntology) return
    setShowDeleteDialog(true)
  }

  async function handleConfirmDelete() {
    if (!selectedOntology) return
    const deletedId = selectedOntology.id
    const deletedName = selectedOntology.name
    setShowDeleteDialog(false)
    try {
      await mutations.remove.mutateAsync(deletedId)
      const remaining = ontologies.filter(x => x.id !== deletedId)
      navigate(remaining.length > 0 ? schemaUrl(remaining[0].id) : '/schema', { replace: true })
      notify('success', `"${deletedName}" deleted`, {
        label: 'Undo',
        onClick: async () => {
          try {
            await ontologyDefinitionService.restore(deletedId)
            mutations.invalidateAll()
            navigate(schemaUrl(deletedId))
            notify('success', `"${deletedName}" restored`)
          } catch (err: unknown) {
            // The only call in this file that dropped the reason. An Undo
            // that fails silently on "why" is the one place an operator
            // most needs it — the row is still gone.
            notify('error', `Failed to restore "${deletedName}": ${
              err instanceof Error && err.message ? err.message : 'Unknown error'}`)
          }
        },
      })
    } catch (err: unknown) {
      notify('error', `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleRestore() {
    if (!selectedOntology) return
    try {
      await ontologyDefinitionService.restore(selectedOntology.id)
      mutations.invalidateAll()
      notify('success', `"${selectedOntology.name}" restored`)
    } catch (err: unknown) {
      notify('error', `Failed to restore: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  // DAG-aware containment-edge operations.
  //
  // Each of the three handlers mutates exactly one parent↔child edge and keeps
  // both sides (parent.can_contain and child.can_be_contained_by) in sync. They
  // never stomp on unrelated edges, so a type that lives under multiple parents
  // stays intact when one edge is added or removed. Self-referential edges
  // (parentId === childId) are treated as ordinary DAG edges — the backend's
  // resolver explicitly accepts them.

  function handleAddContainmentEdge(childId: string, parentId: string) {
    if (!selectedOntology || isLocked || !workingEntityDefs) return

    const defs = { ...(workingEntityDefs as Record<string, Record<string, unknown>>) }
    const childDef = defs[childId]
    const parentDef = defs[parentId]
    if (!childDef || !parentDef) return

    const childHierarchy = (childDef.hierarchy as Record<string, unknown>) ?? {}
    const childParents: string[] = (childHierarchy.can_be_contained_by as string[]) ?? []
    if (!childParents.includes(parentId)) {
      defs[childId] = {
        ...childDef,
        hierarchy: { ...childHierarchy, can_be_contained_by: [...childParents, parentId] },
      }
    }

    // When the edge is self-referential, the child and parent point at the
    // same def object — re-read it after the update above so the next write
    // doesn't clobber the can_be_contained_by change.
    const parentDefAfter = defs[parentId]
    const parentHierarchy = (parentDefAfter.hierarchy as Record<string, unknown>) ?? {}
    const parentChildren: string[] = (parentHierarchy.can_contain as string[]) ?? []
    if (!parentChildren.includes(childId)) {
      defs[parentId] = {
        ...parentDefAfter,
        hierarchy: { ...parentHierarchy, can_contain: [...parentChildren, childId] },
      }
    }

    setWorkingEntityDefs(defs)
    const msg = parentId === childId
      ? `"${humanizeId(childId)}" can now contain itself — save to persist`
      : `"${humanizeId(childId)}" also contained under "${humanizeId(parentId)}" — save to persist`
    notify('info', msg)
  }

  function handleRemoveContainmentEdge(childId: string, parentId: string) {
    if (!selectedOntology || isLocked || !workingEntityDefs) return

    const defs = { ...(workingEntityDefs as Record<string, Record<string, unknown>>) }
    const childDef = defs[childId]
    if (!childDef) return

    const childHierarchy = (childDef.hierarchy as Record<string, unknown>) ?? {}
    const childParents: string[] = (childHierarchy.can_be_contained_by as string[]) ?? []
    defs[childId] = {
      ...childDef,
      hierarchy: { ...childHierarchy, can_be_contained_by: childParents.filter(p => p !== parentId) },
    }

    const parentDefAfter = defs[parentId]
    if (parentDefAfter) {
      const parentHierarchy = (parentDefAfter.hierarchy as Record<string, unknown>) ?? {}
      const parentChildren: string[] = (parentHierarchy.can_contain as string[]) ?? []
      defs[parentId] = {
        ...parentDefAfter,
        hierarchy: { ...parentHierarchy, can_contain: parentChildren.filter(c => c !== childId) },
      }
    }

    setWorkingEntityDefs(defs)
    notify('info', `Removed "${humanizeId(childId)}" from "${humanizeId(parentId)}" — save to persist`)
  }

  function handleMakeRootType(childId: string) {
    if (!selectedOntology || isLocked || !workingEntityDefs) return

    const defs = { ...(workingEntityDefs as Record<string, Record<string, unknown>>) }
    const childDef = defs[childId]
    if (!childDef) return
    const childHierarchy = (childDef.hierarchy as Record<string, unknown>) ?? {}
    const oldParents: string[] = (childHierarchy.can_be_contained_by as string[]) ?? []

    for (const oldParentId of oldParents) {
      if (defs[oldParentId]) {
        const pDef = defs[oldParentId]
        const pH = (pDef.hierarchy as Record<string, unknown>) ?? {}
        const pCC: string[] = (pH.can_contain as string[]) ?? []
        defs[oldParentId] = { ...pDef, hierarchy: { ...pH, can_contain: pCC.filter(c => c !== childId) } }
      }
    }

    defs[childId] = { ...defs[childId], hierarchy: { ...((defs[childId].hierarchy as Record<string, unknown>) ?? {}), can_be_contained_by: [] } }

    setWorkingEntityDefs(defs)
    notify('info', `"${humanizeId(childId)}" is now a root type — save to persist`)
  }

  function handleUpdateContainmentEdgeTypes(newList: string[]) {
    if (!selectedOntology || isLocked) return
    setWorkingContainment(newList)
    // Keep the per-relationship is_containment flags in agreement with the list —
    // the backend treats the flags as the source of truth whenever relationship
    // definitions are present in the save payload (which the batch save always sends).
    const baseDefs = workingRelDefs ?? { ...((selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}) }
    const listUpper = new Set(newList.map(t => t.toUpperCase()))
    const syncedDefs = Object.fromEntries(
      Object.entries(baseDefs).map(([rid, def]) => {
        const d = def as Record<string, unknown>
        if (!d || d.is_system) return [rid, def]
        const flag = listUpper.has(rid.toUpperCase())
        if (Boolean(d.is_containment ?? d.isContainment ?? false) === flag) return [rid, def]
        const next: Record<string, unknown> = { ...d, is_containment: flag }
        delete next.isContainment
        return [rid, next]
      })
    )
    setWorkingRelDefs(syncedDefs)
    notify('info', 'Containment edge types updated — save to persist')
  }

  // ── Editor panel title helper ──────────────────────────────────────
  const editorTitle = editorPanel
    ? editorPanel.kind === 'entity'
      ? editorPanel.data ? `Edit: ${editorPanel.data.name}` : 'New Entity Type'
      : editorPanel.data ? `Edit: ${editorPanel.data.name}` : 'New Relationship Type'
    : ''

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-500">
      {/* Main layout: Sidebar + Detail */}
      <div className="flex-1 min-h-0 flex">
        {/* Sidebar — self-sizes via internal width state */}
        <OntologySidebar
            ontologies={ontologies}
            selectedOntologyId={dashboardMode ? undefined : ontologyId}
            activeDataSource={evalDataSource}
            assignmentCountMap={assignmentCountMap}
            workspaces={workspaces}
            isLoading={isLoadingOntologies}
            isSuggesting={isSuggesting}
            canManage={access.canEdit}
            onCreateDraft={() => setShowCreateDialog(true)}
            onSuggest={handleSuggestOntology}
            dashboardMode={dashboardMode}
            onToggleDashboard={toggleDashboard}
          />

        {/* Detail pane */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {dashboardMode ? (
            <div className="flex-1 overflow-y-auto">
              <DeploymentDashboardPanel
                workspaces={workspaces}
                ontologies={ontologies}
                onNavigateToOntology={(ontId) => {
                  navigate(schemaUrl(ontId))
                  toggleDashboard()
                }}
                onAssign={handleAssignToDataSource}
                onUnassign={requestUnassign}
                onBulkUnassign={entries => setBulkUnassignTargets(entries)}
                onSuggest={handleSuggestForDataSource}
                onCreateDraft={() => setShowCreateDialog(true)}
                onSuggestFromGraph={access.canSuggest ? handleSuggestOntology : undefined}
                canSuggest={access.canSuggest}
                isAssigning={isAssigning}
              />
            </div>
          ) : selectedOntology ? (
            <>
              {/* Deleted banner */}
              {isDeleted && (
                <div className="flex-shrink-0 mx-auto w-[calc(100%-4rem)] max-w-[1376px] mt-4 mb-0 flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20">
                  <Trash2 className="w-5 h-5 text-red-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-red-600 dark:text-red-400">This semantic layer has been deleted</p>
                    <p className="text-xs text-red-500/70 mt-0.5">
                      {selectedOntology?.deletedAt && `Deleted on ${new Date(selectedOntology.deletedAt).toLocaleDateString()}`}
                      {selectedOntology?.deletedBy && ` by ${selectedOntology.deletedBy}`}
                      . It is read-only and hidden from active lists.
                    </p>
                  </div>
                  <button
                    onClick={handleRestore}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm shadow-red-500/20 flex-shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Restore
                  </button>
                </div>
              )}

              {/* Detail header — extracted component with overflow menu */}
              <OntologyDetailHeader
                ontology={selectedOntology}
                isImmutable={isImmutable}
                access={access}
                hasPendingChanges={hasPendingChanges}
                isSaving={isSaving}
                workspaces={workspaces}
                ontologies={ontologies}
                isAssigning={isAssigning}
                onDiscard={discardChanges}
                onSave={handleSaveAllChanges}
                onReviewChanges={() => setShowChangesReview(true)}
                onValidate={handleValidate}
                onPublish={handlePublish}
                onClone={handleClone}
                onCreateNewVersion={handleCreateNewVersion}
                onExport={handleExport}
                onImport={() => fileInputRef.current?.click()}
                onEditDetails={() => setTab('settings')}
                onDelete={handleDeleteOntology}
                onFindDataSources={() => { setAssignmentManagerTab('matches'); setShowAssignmentManager(true) }}
                onOpenAssignments={() => { setAssignmentManagerTab('all'); setShowAssignmentManager(true) }}
              />

              {/* Contextual alerts */}
              {contextAlerts.length > 0 && (
                <OntologyAlertBanner alerts={contextAlerts} />
              )}

              {/* Tabs — underline style (AdminRegistry pattern) */}
              <div className="border-b border-glass-border shrink-0">
                <PageContainer gutter="shell" className="flex items-center gap-1">
                {TAB_DEFS.filter(t => t.id !== 'history' || access.canSeeHistory).map(t => {
                  const Icon = t.icon
                  const isActive = activeTab === t.id
                  const count = t.id === 'schema' ? entityTypes.length + relTypes.length
                    : undefined
                  const tabHasChanges =
                    (isInEditMode && (
                      (t.id === 'schema' && (hasEntityChanges || hasRelChanges)) ||
                      (t.id === 'hierarchy' && hasHierarchyChanges)
                    )) ||
                    (t.id === 'settings' && hasDetailChanges)
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={cn(
                        'flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-colors duration-150 border-b-2 relative',
                        isActive
                          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                          : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl',
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      {t.label}
                      {count !== undefined && count > 0 && (
                        <span className={cn(
                          'px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                          isActive
                            ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                            : 'bg-black/[0.06] dark:bg-white/[0.08] text-ink-muted',
                        )}>
                          {count}
                        </span>
                      )}
                      {tabHasChanges && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                      )}
                    </button>
                  )
                })}
                </PageContainer>
              </div>

              {/* Evaluation context — the schema's applications (the sources
                  that USE it), plus which one the single-target tabs
                  (overview/schema/coverage) are analyzing, with full identity
                  (graph · workspace · provider · host) and how that target
                  was chosen (picked / auto-selected / preview fallback). */}
              {(activeTab === 'overview' || activeTab === 'schema' || activeTab === 'coverage') && (
                <div className="shrink-0">
                  <PageContainer gutter="shell" className="pt-3 pb-1">
                    <EvalContextBar
                      ontologyId={selectedOntology.id}
                      workspaces={workspaces}
                      workspace={evalWorkspace}
                      dataSource={evalDataSource}
                      selectionSource={evalOverrideDsId ? 'user' : autoEvalTarget ? 'auto-assigned' : 'workspace-active'}
                      onSelectTarget={(wsId, dsId) => {
                        setEvalOverrideWsId(wsId)
                        setEvalOverrideDsId(dsId)
                        setShowEvalPicker(false)
                      }}
                      onChangeTarget={() => setShowEvalPicker(v => !v)}
                      onManageAssignments={() => { setAssignmentManagerTab('all'); setShowAssignmentManager(true) }}
                    />
                    {showEvalPicker && (
                      <div className="mt-2">
                        <DataSourcePicker
                          workspaces={workspaces}
                          selectedWorkspaceId={evalWorkspaceId}
                          selectedDataSourceId={evalDataSourceId}
                          ontologies={ontologies}
                          compact
                          onSelect={(wsId, dsId) => {
                            setEvalOverrideWsId(wsId)
                            setEvalOverrideDsId(dsId)
                            setShowEvalPicker(false)
                          }}
                        />
                      </div>
                    )}
                  </PageContainer>
                </div>
              )}

              {/* Tab content + editor panel */}
              <div className="flex-1 min-h-0 flex relative">
                <div className={cn('min-w-0 overflow-y-auto flex-1', editorPanel && 'mr-[440px]')}>
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeTab}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className={cn(pageGeometry({ gutter: 'shell' }), 'py-8')}
                    >
                      {/* Staged changes tray — persistent running total with per-change revert */}
                      {hasPendingChanges && (
                        <ChangesTray
                          ontology={selectedOntology}
                          workingEntityDefs={workingEntityDefs}
                          workingRelDefs={workingRelDefs}
                          workingContainment={workingContainment}
                          workingLineage={workingLineage}
                          workingDetails={workingDetails}
                          isSaving={isSaving}
                          onRevertEntity={handleRevertEntityChange}
                          onRevertRel={handleRevertRelChange}
                          onRevertClassification={handleRevertClassification}
                          onRevertDetails={() => setWorkingDetails(null)}
                          onJumpToType={handleJumpToType}
                          onReview={() => setShowChangesReview(true)}
                          onSaveAll={handleSaveAllChanges}
                        />
                      )}

                      {activeTab === 'overview' && (
                        <OverviewPanel
                          ontology={selectedOntology}
                          workspaceId={evalWorkspaceId}
                          dataSourceId={evalDataSourceId}
                          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
                          onNavigateTab={(tab) => setTab(tab)}
                          workspaces={workspaces}
                          onAssignToDataSource={handleAssignToDataSource}
                          onFindDataSources={() => { setAssignmentManagerTab('matches'); setShowAssignmentManager(true) }}
                        />
                      )}

                      {activeTab === 'schema' && (
                        <SchemaPanel
                          entityTypes={entityTypes}
                          relTypes={relTypes}
                          entityVariants={entityVariants}
                          relVariants={relVariants}
                          isLocked={isLocked}
                          search={search}
                          editorPanel={editorPanel}
                          onSearch={setSearch}
                          entityStatMap={entityStatMap}
                          changedEntityIds={changedEntityIds}
                          validationResult={validationResult}
                          onEditEntity={et => { ensureEditMode(); setEditorPanel({ kind: 'entity', data: et }) }}
                          onNewEntity={() => { ensureEditMode(); setEditorPanel({ kind: 'entity' }) }}
                          onDeleteEntity={handleDeleteEntityType}
                          onDismissValidation={() => setValidationResult(null)}
                          edgeStatMap={edgeStatMap}
                          changedRelIds={changedRelIds}
                          onEditRel={rt => { ensureEditMode(); setEditorPanel({ kind: 'rel', data: rt }) }}
                          onNewRel={() => { ensureEditMode(); setEditorPanel({ kind: 'rel' }) }}
                          onDeleteRel={handleDeleteRelType}
                          removedEntityTypes={removedEntityTypes}
                          onRestoreEntity={handleRestoreEntityType}
                          removedRelTypes={removedRelTypes}
                          onRestoreRel={handleRestoreRelType}
                          hasEntityChanges={hasEntityChanges}
                          hasRelChanges={!!hasRelChanges}
                          initialSubView={rawTab === 'relationships' ? 'relationships' : undefined}
                        />
                      )}

                      {activeTab === 'hierarchy' && (
                        <HierarchyPanel
                          selectedOntology={selectedOntology}
                          entityTypes={entityTypes}
                          relTypes={relTypes}
                          isLocked={isLocked}
                          isSaving={isSaving}
                          onAddParent={(childId, parentId) => { ensureEditMode(); handleAddContainmentEdge(childId, parentId) }}
                          onRemoveParent={(childId, parentId) => { ensureEditMode(); handleRemoveContainmentEdge(childId, parentId) }}
                          onMakeRoot={(childId) => { ensureEditMode(); handleMakeRootType(childId) }}
                          onEditType={et => { ensureEditMode(); setEditorPanel({ kind: 'entity', data: et }) }}
                          onUpdateContainmentEdgeTypes={(newList) => { ensureEditMode(); handleUpdateContainmentEdgeTypes(newList) }}
                        />
                      )}

                      {activeTab === 'coverage' && (
                        <CoveragePanel
                          ontologyId={selectedOntology.id}
                          workspaceId={evalWorkspaceId}
                          dataSourceId={evalDataSourceId}
                          onChangeEvalTarget={(wsId, dsId) => { setEvalOverrideWsId(wsId); setEvalOverrideDsId(dsId) }}
                          isLocked={isLocked}
                          onDefineEntity={typeId => {
                            ensureEditMode()
                            const name = humanizeId(typeId)
                            setEditorPanel({
                              kind: 'entity',
                              data: {
                                id: typeId, name, pluralName: `${name}s`, description: '',
                                visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
                                fields: [],
                                hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
                                behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
                              },
                            })
                            setTab('schema')
                          }}
                          onDefineRel={typeId => {
                            ensureEditMode()
                            const name = humanizeId(typeId)
                            setEditorPanel({
                              kind: 'rel',
                              data: {
                                id: typeId, name, description: '', sourceTypes: [], targetTypes: [],
                                visual: { ...DEFAULT_REL_VISUAL },
                                bidirectional: false, showLabel: false, isContainment: false, isLineage: false,
                              },
                            })
                            setTab('schema')
                          }}
                        />
                      )}

                      {activeTab === 'health' && (
                        <>
                          {/* Unlike overview/coverage (single evaluation target),
                              health always spans every assigned source. */}
                          <p className="text-xs text-ink-muted mb-4">
                            Evaluated across all{' '}
                            <span className="font-semibold text-ink">
                              {assignmentCountMap.get(selectedOntology.id) ?? 0} assigned data source{(assignmentCountMap.get(selectedOntology.id) ?? 0) !== 1 ? 's' : ''}
                            </span>
                            {' '}— not just the single evaluation target used by the Overview and Coverage tabs.
                          </p>
                          <AdoptionMatchSection ontologyId={selectedOntology.id} />
                          <SourceMappingSection ontologyId={selectedOntology.id} />
                        </>
                      )}

                      {activeTab === 'usage' && (
                        <UsagePanel
                          ontology={selectedOntology}
                          workspaces={workspaces}
                          ontologies={ontologies}
                          onManageAssignments={() => { setAssignmentManagerTab('all'); setShowAssignmentManager(true) }}
                        />
                      )}

                      {activeTab === 'history' && access.canSeeHistory && (
                        <VersionHistoryPanel ontology={selectedOntology} />
                      )}

                      {activeTab === 'settings' && (
                        <SettingsPanel
                          ontology={selectedOntology}
                          workingDetails={workingDetails}
                          onUpdateDetails={setWorkingDetails}
                          onDelete={handleDeleteOntology}
                          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
                        />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {/* Backdrop — CSS transition with immediate pointer-events removal (fixes Safari AnimatePresence freeze) */}
                <Backdrop open={!!editorPanel} onClick={() => setEditorPanel(null)} zClassName="z-20" className="bg-black/15 dark:bg-black/25" />

                {/* Editor slide-in panel */}
                <AnimatePresence>
                  {editorPanel && (
                    <motion.div
                      key="editor-panel"
                      initial={{ x: 40, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={{ x: 40, opacity: 0 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className="absolute top-0 bottom-0 right-0 w-[440px] border-l border-glass-border overflow-hidden flex flex-col z-30 bg-canvas-elevated"
                    >
                      {/* Editor header */}
                      <div className="flex items-center justify-between px-5 py-3.5 border-b border-glass-border bg-gradient-to-r from-indigo-500/[0.04] to-transparent">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {editorPanel.kind === 'entity'
                            ? <Box className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                            : <GitBranch className="w-4 h-4 text-indigo-500 flex-shrink-0" />}
                          <span className="text-sm font-semibold text-ink truncate">{editorTitle}</span>
                        </div>
                        <button
                          onClick={() => setEditorPanel(null)}
                          className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted hover:text-ink transition-colors flex-shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Saving overlay */}
                      {isSaving && (
                        <div className="absolute inset-0 bg-canvas/80 flex items-center justify-center z-10 backdrop-blur-sm">
                          <Loader2 className="w-5 h-5 animate-spin text-accent-lineage" />
                        </div>
                      )}

                      {editorPanel.kind === 'entity' && (
                        <EntityTypeEditor
                          entityType={editorPanel.data}
                          availableEntityTypes={entityTypes.map(et => ({ id: et.id, name: et.name }))}
                          readOnly={isLocked}
                          onSave={handleSaveEntityType}
                          onCancel={() => setEditorPanel(null)}
                        />
                      )}
                      {editorPanel.kind === 'rel' && (
                        <RelationshipTypeEditor
                          relType={editorPanel.data}
                          availableEntityTypes={entityTypes.map(et => ({ id: et.id, name: et.name }))}
                          existingTypeIds={relTypes.map(rt => rt.id)}
                          readOnly={isLocked || !!editorPanel.data?.isSystem}
                          onSave={handleSaveRelType as (rt: RelationshipTypeSchema & { isContainment?: boolean; isLineage?: boolean; category?: string; direction?: string }) => void}
                          onCancel={() => setEditorPanel(null)}
                        />
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-ink-muted">
              <div className="text-center">
                {isLoadingOntologies ? (
                  <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-30" />
                ) : (
                  <>
                    <div className="relative mx-auto mb-5 w-16 h-16 flex items-center justify-center">
                      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-500/10" />
                      <BookOpen className="w-8 h-8 relative z-10 text-indigo-400 opacity-60" />
                    </div>
                    <p className="text-sm font-semibold text-ink-secondary">No semantic layer selected</p>
                    <p className="text-xs mt-1.5 text-ink-muted">
                      Select one from the sidebar or create a new draft.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      {showCreateDialog && (
        <CreateOntologyDialog
          hasGraphContext={!!evalDataSourceId}
          ontologies={ontologies}
          onClose={() => setShowCreateDialog(false)}
          onCreate={handleCreateDraft}
        />
      )}
      {/* Delete Confirmation */}
      {showDeleteDialog && selectedOntology && (
        <DeleteConfirmDialog
          ontology={selectedOntology}
          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
          onConfirm={handleConfirmDelete}
          onClose={() => setShowDeleteDialog(false)}
        />
      )}

      {/* Publish Confirmation */}
      {publishImpact && selectedOntology && (
        <PublishConfirmDialog
          ontology={selectedOntology}
          impact={publishImpact}
          checks={publishChecks}
          isPublishing={isPublishing}
          onConfirm={handleConfirmPublish}
          onClose={() => { setPublishImpact(null); setPublishChecks(null) }}
          onNavigateTab={(tab) => { setPublishImpact(null); setPublishChecks(null); setTab(tab as Parameters<typeof setTab>[0]) }}
        />
      )}

      {/* Navigation blocker dialog */}
      {blocker.state === 'blocked' && (
        <UnsavedChangesDialog
          isSaving={isSaving}
          onSave={async () => {
            // Only navigate when the save actually persisted — a failed save
            // must keep the user (and their working copies) on the page.
            const saved = await handleSaveAllChanges()
            if (saved) blocker.proceed()
            else blocker.reset()
          }}
          onDiscard={() => {
            // Drop the working copies unconditionally — going through
            // discardChanges() here would just re-prompt (we KNOW there are
            // pending changes; the user already chose to discard them).
            doDiscard()
            blocker.proceed()
          }}
          onCancel={() => blocker.reset()}
        />
      )}

      {/* Suggest from Graph */}
      {showSuggestDialog && (
        <SuggestConfirmDialog
          workspaces={workspaces}
          initialWorkspaceId={suggestPreSeed?.wsId ?? evalWorkspaceId}
          initialDataSourceId={suggestPreSeed?.dsId ?? evalDataSourceId}
          suggestedName={generateSuggestedName(evalDataSource?.label, evalWorkspace?.name)}
          ontologies={ontologies}
          currentOntologyId={evalDataSource?.ontologyId ?? null}
          assignmentCountMap={assignmentCountMap}
          onAnalyze={handleAnalyzeGraph}
          onRefreshIntrospection={handleRefreshIntrospection}
          onUseExisting={handleSuggestUseExisting}
          onCloneExisting={handleSuggestCloneExisting}
          onCreateDraft={handleSuggestCreateDraft}
          onClose={() => { if (!isSuggesting) setShowSuggestDialog(false) }}
          isCreating={isSuggesting}
        />
      )}

      {/* Import Dialog */}
      {importData && (
        <ImportDialog
          importData={importData}
          currentOntology={selectedOntology ?? null}
          onClose={() => setImportData(null)}
          onImportNew={ontologyDefinitionService.importNew}
          onImportInto={ontologyDefinitionService.importInto}
          onSuccess={handleImportSuccess}
        />
      )}

      {/* Assignment Manager */}
      {showAssignmentManager && selectedOntology && (
        <AssignmentManagerDialog
          ontology={selectedOntology}
          workspaces={workspaces}
          ontologies={ontologies}
          isAssigning={isAssigning}
          onAssign={handleAssignToDataSource}
          onUnassign={requestUnassign}
          onRollOutToWorkspace={handleRollOutToWorkspace}
          onClose={() => setShowAssignmentManager(false)}
          initialTab={assignmentManagerTab}
        />
      )}

      {/* Unassign Confirmation */}
      {unassignTarget && (
        <UnassignConfirmDialog
          dataSourceLabel={unassignTarget.dsLabel}
          workspaceName={unassignTarget.wsName}
          ontologyName={unassignTarget.ontologyName}
          onConfirm={handleConfirmUnassign}
          onCancel={() => setUnassignTarget(null)}
          isLoading={isAssigning}
        />
      )}

      {/* Bulk Unassign Confirmation (Deployment Dashboard multi-select) */}
      {bulkUnassignTargets && bulkUnassignTargets.length > 0 && (
        <>
          <Backdrop open onClick={isAssigning ? undefined : () => setBulkUnassignTargets(null)} zClassName="z-50" className="bg-black/40" />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 p-6 pointer-events-auto">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
                  <Trash2 className="w-5 h-5 text-red-500" />
                </div>
                <h3 className="text-sm font-bold text-ink">
                  Unassign {bulkUnassignTargets.length} data source{bulkUnassignTargets.length !== 1 ? 's' : ''}?
                </h3>
              </div>
              <p className="text-xs text-ink-muted mb-3 leading-relaxed">
                Each source falls back to the platform default schema — views built on their
                current schemas may render differently.
              </p>
              <ul className="text-[11px] text-ink-secondary mb-5 space-y-0.5 max-h-32 overflow-y-auto">
                {bulkUnassignTargets.slice(0, 8).map(t => (
                  <li key={t.dataSourceId} className="truncate">· {t.dataSourceLabel}</li>
                ))}
                {bulkUnassignTargets.length > 8 && (
                  <li className="text-ink-muted">…and {bulkUnassignTargets.length - 8} more</li>
                )}
              </ul>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setBulkUnassignTargets(null)}
                  disabled={isAssigning}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmBulkUnassign}
                  disabled={isAssigning}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm disabled:opacity-50"
                >
                  {isAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Unassign All
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Discard Confirmation */}
      <Backdrop open={showDiscardConfirm} onClick={() => setShowDiscardConfirm(false)} zClassName="z-50" className="bg-black/40" />
      {showDiscardConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg animate-in fade-in zoom-in-95 p-6 pointer-events-auto">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <h3 className="text-sm font-bold text-ink">Discard all changes?</h3>
            </div>
            <p className="text-xs text-ink-muted mb-5 leading-relaxed">
              All unsaved changes to entity types, relationships, hierarchy, and settings will be lost. This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDiscardConfirm(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Keep Editing
              </button>
              <button
                onClick={doDiscard}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Changes Review Dialog */}
      {showChangesReview && selectedOntology && hasPendingChanges && (
        <ChangesReviewDialog
          ontology={selectedOntology}
          workingEntityDefs={(workingEntityDefs ?? selectedOntology.entityTypeDefinitions ?? {}) as Record<string, unknown>}
          workingRelDefs={(workingRelDefs ?? selectedOntology.relationshipTypeDefinitions ?? {}) as Record<string, unknown>}
          workingContainment={workingContainment ?? selectedOntology.containmentEdgeTypes ?? []}
          workingLineage={workingLineage ?? selectedOntology.lineageEdgeTypes ?? []}
          workingDetails={workingDetails}
          isSaving={isSaving}
          onSave={() => { setShowChangesReview(false); handleSaveAllChanges() }}
          onClose={() => setShowChangesReview(false)}
        />
      )}

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />

    </div>
  )
}
