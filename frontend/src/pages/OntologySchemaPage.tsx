/**
 * OntologySchemaPage — Ontology management console (layout shell).
 *
 * Sidebar + detail pane layout. Ontology selection is URL-driven via
 * :ontologyId param so it survives refresh. All sub-panels are extracted
 * into features/ontology/components/.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useBlocker } from 'react-router'
import { Loader2, BookOpen, Box, GitBranch, FolderTree, BarChart3, Users, Settings, X, LayoutDashboard, Trash2, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { EntityTypeEditor } from '@/components/schema/EntityTypeEditor'
import { RelationshipTypeEditor } from '@/components/schema/RelationshipTypeEditor'
import {
  ontologyDefinitionService,
  type OntologyDefinitionResponse,
} from '@/services/ontologyDefinitionService'
import { workspaceService } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { fetchSchemaStats, generateSuggestedName } from '@/features/ontology/lib/ontology-utils'
import { cn } from '@/lib/utils'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { EntityTypeSummary, EdgeTypeSummary } from '@/providers/GraphDataProvider'

import { useOntologies, useOntology } from '@/features/ontology/hooks/useOntologies'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { useInvalidateGraphSchema } from '@/hooks/useGraphSchema'
import {
  entityDefToSchema,
  entitySchemaToBackend,
  relDefToSchema,
  relSchemaToBackend,
  humanizeId,
} from '@/features/ontology/lib/ontology-parsers'
import type { OntologyTab, EditorPanel, RelTypeWithClassifications } from '@/features/ontology/lib/ontology-types'

import { OntologyContextBanner } from '@/features/ontology/components/OntologyContextBanner'
import { OntologyDetailHeader } from '@/features/ontology/components/OntologyDetailHeader'
import { OntologySidebar } from '@/features/ontology/components/OntologySidebar'
import { useToast } from '@/components/ui/toast'
import { CreateOntologyDialog } from '@/features/ontology/components/dialogs/CreateOntologyDialog'
import { EditDetailsDialog } from '@/features/ontology/components/dialogs/EditDetailsDialog'
import { SchemaPanel } from '@/features/ontology/components/panels/SchemaPanel'
import { HierarchyPanel } from '@/features/ontology/components/panels/HierarchyPanel'
import { CoveragePanel } from '@/features/ontology/components/panels/CoveragePanel'
import { AdoptionPanel } from '@/features/ontology/components/panels/AdoptionPanel'
import { SettingsPanel } from '@/features/ontology/components/panels/SettingsPanel'
import { DeleteConfirmDialog } from '@/features/ontology/components/dialogs/DeleteConfirmDialog'
import { UnsavedChangesDialog } from '@/features/ontology/components/dialogs/UnsavedChangesDialog'
import { PublishConfirmDialog } from '@/features/ontology/components/dialogs/PublishConfirmDialog'
import { ImportDialog } from '@/features/ontology/components/dialogs/ImportDialog'
import { SuggestConfirmDialog } from '@/features/ontology/components/dialogs/SuggestConfirmDialog'
import { ChangesReviewDialog } from '@/features/ontology/components/dialogs/ChangesReviewDialog'
import { OverviewPanel } from '@/features/ontology/components/panels/OverviewPanel'
import type { OntologyImpactResponse, OntologyImportResponse } from '@/services/ontologyDefinitionService'

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
  { id: 'adoption', label: 'Adoption', icon: Users },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/** Map legacy tab URLs to new tab IDs for backward compatibility */
const LEGACY_TAB_MAP: Record<string, OntologyTab> = {
  entities: 'schema',
  relationships: 'schema',
  hierarchy: 'hierarchy',
  usage: 'adoption',
  history: 'adoption',
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

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  )
  const activeDataSource = useMemo(
    () => activeWorkspace?.dataSources?.find(ds => ds.id === activeDataSourceId) ?? null,
    [activeWorkspace, activeDataSourceId],
  )

  // ── React Query data ───────────────────────────────────────────────
  const { data: ontologies = [], isLoading: isLoadingOntologies } = useOntologies()
  const { data: selectedOntology } = useOntology(ontologyId)
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
  const { showToast } = useToast()
  const [search, setSearch] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [isAssigning, setIsAssigning] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [publishImpact, setPublishImpact] = useState<OntologyImpactResponse | null>(null)
  const [isPublishing, setIsPublishing] = useState(false)
  const [editDetailsTarget, setEditDetailsTarget] = useState<OntologyDefinitionResponse | null>(null)
  const [validationResult, setValidationResult] = useState<{
    isValid: boolean
    issues: Array<{ severity: string; message: string }>
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null)
  const [showSuggestDialog, setShowSuggestDialog] = useState(false)
  const suggestResponseRef = useRef<import('@/services/ontologyDefinitionService').OntologySuggestResponse | null>(null)

  // ── Edit mode + working copies (lazy initialization) ────────────
  // No explicit isEditing toggle — working copies are created on first edit attempt.
  const [workingEntityDefs, setWorkingEntityDefs] = useState<Record<string, unknown> | null>(null)
  const [workingRelDefs, setWorkingRelDefs] = useState<Record<string, unknown> | null>(null)
  const [workingContainment, setWorkingContainment] = useState<string[] | null>(null)
  const [workingLineage, setWorkingLineage] = useState<string[] | null>(null)
  const [workingDetails, setWorkingDetails] = useState<{ name: string; description: string; evolutionPolicy: string } | null>(null)
  const hasStagedChangesRef = useRef(false)
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

  const entityTypes = useMemo((): EntityTypeSchema[] => {
    return Object.entries(effectiveEntityDefs as Record<string, Record<string, unknown>>)
      .map(([id, def]) => entityDefToSchema(id, def))
      .sort((a, b) => a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name))
  }, [effectiveEntityDefs])

  const relTypes = useMemo((): RelTypeWithClassifications[] => {
    return Object.entries(effectiveRelDefs as Record<string, Record<string, unknown>>)
      .map(([id, def]) => relDefToSchema(id, def))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [effectiveRelDefs])

  // Detect pending changes (explicit dirty flag + deep comparison fallback)
  const hasDetailChanges = useMemo(() => {
    if (!workingDetails || !selectedOntology) return false
    return workingDetails.name !== selectedOntology.name ||
      workingDetails.description !== (selectedOntology.description ?? '') ||
      workingDetails.evolutionPolicy !== (selectedOntology.evolutionPolicy ?? 'reject')
  }, [workingDetails, selectedOntology])

  const hasPendingChanges = useMemo(() => {
    if (hasDetailChanges) return true
    if (!isInEditMode || !selectedOntology) return false
    if (hasStagedChangesRef.current) return true
    if (workingEntityDefs && JSON.stringify(workingEntityDefs) !== JSON.stringify(selectedOntology.entityTypeDefinitions ?? {})) return true
    if (workingRelDefs && JSON.stringify(workingRelDefs) !== JSON.stringify(selectedOntology.relationshipTypeDefinitions ?? {})) return true
    if (workingContainment && JSON.stringify(workingContainment) !== JSON.stringify(selectedOntology.containmentEdgeTypes ?? [])) return true
    if (workingLineage && JSON.stringify(workingLineage) !== JSON.stringify(selectedOntology.lineageEdgeTypes ?? [])) return true
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

  const hasEntityChanges = changedEntityIds.size > 0
  const hasRelChanges = changedRelIds.size > 0 ||
    (workingContainment && JSON.stringify(workingContainment) !== JSON.stringify(selectedOntology?.containmentEdgeTypes ?? [])) ||
    (workingLineage && JSON.stringify(workingLineage) !== JSON.stringify(selectedOntology?.lineageEdgeTypes ?? []))
  const hasHierarchyChanges = hasEntityChanges // hierarchy changes come from entity reparenting

  // Graph stat maps — populated when a data source is active and stats are fetched.
  // Currently empty at page level; CoveragePanel fetches its own stats.
  const entityStatMap = useMemo((): Map<string, EntityTypeSummary> => new Map(), [])
  const edgeStatMap = useMemo((): Map<string, EdgeTypeSummary> => new Map(), [])

  const assignmentCountMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId) m.set(ds.ontologyId, (m.get(ds.ontologyId) ?? 0) + 1)
      }
    }
    return m
  }, [workspaces])

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
    hasStagedChangesRef.current = false
    setEditorPanel(null)
    setShowDiscardConfirm(false)
  }

  async function handleSaveAllChanges() {
    if (!selectedOntology || !hasPendingChanges) return
    setIsSaving(true)
    try {
      const req: Record<string, unknown> = {}
      if (workingEntityDefs) req.entityTypeDefinitions = workingEntityDefs
      if (workingRelDefs) req.relationshipTypeDefinitions = workingRelDefs
      if (workingContainment) req.containmentEdgeTypes = workingContainment
      if (workingLineage) req.lineageEdgeTypes = workingLineage
      if (workingDetails) {
        req.name = workingDetails.name
        if (workingDetails.description) req.description = workingDetails.description
        req.evolutionPolicy = workingDetails.evolutionPolicy
      }

      await mutations.update.mutateAsync({ id: selectedOntology.id, req })
      showToast('success', 'All changes saved')
      doDiscard()
    } catch (err: unknown) {
      showToast('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasPendingChanges])

  // React Router navigation — only block actual route changes, not tab/param changes
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!hasPendingChanges) return false
    // Allow same-path navigation (tab switches, search param changes)
    if (currentLocation.pathname === nextLocation.pathname) return false
    // Allow navigation within /schema/ (switching between ontologies)
    if (nextLocation.pathname.startsWith('/schema/') && currentLocation.pathname.startsWith('/schema/')) return true
    // Block navigation away from schema page
    return true
  })

  // ── Auto-redirect to first ontology if none selected ───────────────
  useEffect(() => {
    if (!ontologyId && ontologies.length > 0) {
      const target = (activeDataSource?.ontologyId && ontologies.find(o => o.id === activeDataSource.ontologyId))
        ? activeDataSource.ontologyId
        : ontologies[0].id
      navigate(schemaUrl(target), { replace: true })
    }
  }, [ontologyId, ontologies, activeDataSource?.ontologyId, navigate])

  // ── Load workspaces ────────────────────────────────────────────────
  useEffect(() => { loadWorkspaces() }, [loadWorkspaces])

  // Clear editor / validation / edit mode on ontology change
  useEffect(() => {
    setEditorPanel(null)
    setValidationResult(null)
    setSearch('')
    discardChanges()
  }, [ontologyId])

  // ── Handlers ───────────────────────────────────────────────────────

  function handleSwitchEnvironment(wsId: string, dsId: string) {
    setActiveWorkspace(wsId)
    setActiveDataSource(dsId)
  }

  /** Assign the current ontology to a specific data source (ontology-centric) */
  async function handleAssignToDataSource(workspaceId: string, dataSourceId: string) {
    if (!selectedOntology) return
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(workspaceId, dataSourceId, {
        ontologyId: selectedOntology.id,
      })
      await loadWorkspaces()
      invalidateGraphSchema()
      showToast('success', 'Schema assigned to data source')
    } catch (err: unknown) {
      showToast('error', `Assignment failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  /** Unassign the current ontology from a specific data source */
  async function handleUnassignFromDataSource(workspaceId: string, dataSourceId: string) {
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(workspaceId, dataSourceId, { ontologyId: '' })
      await loadWorkspaces()
      invalidateGraphSchema()
      showToast('success', 'Schema unassigned from data source')
    } catch (err: unknown) {
      showToast('error', `Unassign failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  /** Roll out the current ontology to ALL data sources in a workspace */
  async function handleRollOutToWorkspace(workspaceId: string) {
    if (!selectedOntology) return
    const ws = workspaces.find(w => w.id === workspaceId)
    if (!ws) return
    setIsAssigning(true)
    try {
      await Promise.all(
        (ws.dataSources ?? []).map(ds =>
          workspaceService.updateDataSource(workspaceId, ds.id, { ontologyId: selectedOntology.id })
        )
      )
      await loadWorkspaces()
      invalidateGraphSchema()
      showToast('success', `Schema rolled out to all data sources in "${ws.name}"`)
    } catch (err: unknown) {
      showToast('error', `Rollout failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  /** Legacy handler kept for backward compatibility */
  async function handleAssignOntology(assignId: string | undefined) {
    if (!activeWorkspace || !activeDataSource) return
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(activeWorkspace.id, activeDataSource.id, {
        ontologyId: assignId ?? '',
      })
      await loadWorkspaces()
      invalidateGraphSchema()
      if (assignId) navigate(schemaUrl(assignId))
      showToast('success', assignId ? 'Semantic layer assigned to data source' : 'Semantic layer assignment cleared')
    } catch (err: unknown) {
      showToast('error', `Assignment failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  function handleSaveEntityType(entityType: EntityTypeSchema) {
    if (!selectedOntology || !workingEntityDefs) return
    if (isLocked) { showToast('warning', 'Clone this semantic layer to make edits'); return }

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
    hasStagedChangesRef.current = true
    showToast('info', `"${entityType.name}" updated — save to persist`)
    setEditorPanel(null)
  }

  function handleSaveRelType(relType: RelTypeWithClassifications) {
    if (!selectedOntology || !workingRelDefs) return
    if (isLocked) { showToast('warning', 'Clone this semantic layer to make edits'); return }

    const relId = relType.id.toUpperCase()
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
    hasStagedChangesRef.current = true
    showToast('info', `"${relType.name}" updated — save to persist`)
    setEditorPanel(null)
  }

  function handleDeleteEntityType(id: string, name: string) {
    if (!selectedOntology || isLocked || !workingEntityDefs) return
    if (!window.confirm(`Delete entity type "${name}"?`)) return
    const defs = { ...workingEntityDefs }
    delete defs[id]
    setWorkingEntityDefs(defs)
    hasStagedChangesRef.current = true
    showToast('info', `"${name}" removed — save to persist`)
  }

  function handleDeleteRelType(id: string, name: string) {
    if (!selectedOntology || isLocked || !workingRelDefs) return
    if (!window.confirm(`Delete relationship type "${name}"?`)) return
    const defs = { ...workingRelDefs }
    delete defs[id.toUpperCase()]
    setWorkingRelDefs(defs)
    hasStagedChangesRef.current = true
    showToast('info', `"${name}" removed — save to persist`)
  }

  function handleSuggestOntology() {
    suggestResponseRef.current = null
    setShowSuggestDialog(true)
  }

  /** Phase 2: analyze the graph, return matches + counts for the dialog to display. */
  async function handleAnalyzeGraph() {
    if (!activeWorkspaceId) throw new Error('No workspace selected')
    const stats = await fetchSchemaStats(activeWorkspaceId, activeDataSourceId ?? undefined)
    const response = await ontologyDefinitionService.suggest(stats as unknown as Record<string, unknown>)
    suggestResponseRef.current = response
    return {
      matches: response.matchingOntologies,
      suggestedEntityCount: Object.keys(response.suggested.entityTypeDefinitions ?? {}).length,
      suggestedRelCount: Object.keys(response.suggested.relationshipTypeDefinitions ?? {}).length,
    }
  }

  /** User chose "Use This" on an existing match. */
  function handleSuggestUseExisting(ontologyId: string) {
    setShowSuggestDialog(false)
    navigate(schemaUrl(ontologyId))
    showToast('success', 'Navigated to the matching semantic layer')
  }

  /** User chose "Clone & Extend" on an existing match. */
  async function handleSuggestCloneExisting(ontologyId: string) {
    setShowSuggestDialog(false)
    try {
      const cloned = await mutations.clone.mutateAsync(ontologyId)
      navigate(schemaUrl(cloned.id, 'schema'))
      showToast('success', 'Cloned — now editing a new draft')
    } catch (err: unknown) {
      showToast('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  /** User chose "Create New Draft" (skip recommendations). */
  async function handleSuggestCreateDraft(name?: string) {
    const response = suggestResponseRef.current
    if (!response) return
    setIsSuggesting(true)
    try {
      const finalName = name || generateSuggestedName(
        activeDataSource?.label,
        activeWorkspace?.name,
        Object.keys(response.suggested.entityTypeDefinitions ?? {}),
      )
      const created = await mutations.create.mutateAsync({
        ...response.suggested,
        name: finalName,
      })
      setShowSuggestDialog(false)
      navigate(schemaUrl(created.id, 'schema'))
      showToast('info', 'Draft created from graph — review types and publish when ready')
    } catch (err: unknown) {
      showToast('error', `Failed to create draft: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSuggesting(false)
    }
  }

  async function handleClone() {
    if (!selectedOntology) return
    try {
      const cloned = await mutations.clone.mutateAsync(selectedOntology.id)
      navigate(schemaUrl(cloned.id))
      showToast('success', 'Cloned — now editing a new draft')
    } catch (err: unknown) {
      showToast('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleValidate() {
    if (!selectedOntology) return
    try {
      const result = await mutations.validate.mutateAsync(selectedOntology.id)
      setValidationResult(result)
      if (result.isValid) showToast('success', 'Semantic layer is valid')
    } catch (err: unknown) {
      showToast('error', `Validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handlePublish() {
    if (!selectedOntology) return
    try {
      const impact = await ontologyDefinitionService.impact(selectedOntology.id)
      setPublishImpact(impact)
    } catch (err: unknown) {
      showToast('error', `Failed to check impact: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleConfirmPublish() {
    if (!selectedOntology) return
    setIsPublishing(true)
    try {
      await mutations.publish.mutateAsync(selectedOntology.id)
      showToast('success', 'Published — active for all assigned data sources')
      setValidationResult(null)
      setPublishImpact(null)
    } catch (err: unknown) {
      showToast('error', `Publish failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsPublishing(false)
    }
  }

  async function handleExport() {
    if (!selectedOntology) return
    try {
      const res = await fetchWithTimeout(`/api/v1/admin/ontologies/${selectedOntology.id}/export`)
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${selectedOntology.name.replace(/\s+/g, '_')}_v${selectedOntology.version}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      showToast('error', `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
          showToast('error', 'Invalid file: expected a JSON object')
          return
        }
        setImportData(parsed)
      } catch {
        showToast('error', 'Invalid file: could not parse JSON')
      }
    }
    reader.onerror = () => showToast('error', 'Failed to read file')
    reader.readAsText(file)
  }

  async function handleImportSuccess(result: OntologyImportResponse) {
    setImportData(null)
    await mutations.invalidateAll()
    if (result.ontology?.id) {
      navigate(schemaUrl(result.ontology.id))
    }
    const messages: Record<string, string> = {
      created: `Imported as new semantic layer "${result.ontology.name}"`,
      updated: `Updated draft with imported changes`,
      new_version: `Created new draft v${result.ontology.version} from import`,
    }
    showToast('success', messages[result.status] || result.summary)
  }

  async function handleSaveOntologyDetails(updates: { name: string; description: string; evolutionPolicy: string }) {
    if (!selectedOntology) return
    try {
      await mutations.update.mutateAsync({
        id: selectedOntology.id,
        req: { name: updates.name, description: updates.description || undefined, evolutionPolicy: updates.evolutionPolicy },
      })
      setEditDetailsTarget(null)
      showToast('success', 'Details saved')
    } catch (err: unknown) {
      showToast('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleCreateDraft(name: string, prePopulate: boolean) {
    setShowCreateDialog(false)
    if (prePopulate) {
      setIsSuggesting(true)
      try {
        if (!activeWorkspaceId) throw new Error('No workspace selected')
        const stats = await fetchSchemaStats(activeWorkspaceId, activeDataSourceId ?? undefined)
        const response = await ontologyDefinitionService.suggest(stats as unknown as Record<string, unknown>)
        const created = await mutations.create.mutateAsync({ ...response.suggested, name })
        navigate(schemaUrl(created.id, 'schema'))
        showToast('success', `"${name}" created with ${Object.keys(created.entityTypeDefinitions ?? {}).length} entity types from your graph`)
      } catch (err: unknown) {
        showToast('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        setIsSuggesting(false)
      }
    } else {
      try {
        const created = await mutations.create.mutateAsync({ name })
        navigate(schemaUrl(created.id))
        showToast('success', 'New draft created')
      } catch (err: unknown) {
        showToast('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
      showToast('success', `"${deletedName}" deleted`, {
        label: 'Undo',
        onClick: async () => {
          try {
            await ontologyDefinitionService.restore(deletedId)
            await mutations.invalidateAll()
            navigate(schemaUrl(deletedId))
            showToast('success', `"${deletedName}" restored`)
          } catch {
            showToast('error', 'Failed to restore')
          }
        },
      })
    } catch (err: unknown) {
      showToast('error', `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleRestore() {
    if (!selectedOntology) return
    try {
      await ontologyDefinitionService.restore(selectedOntology.id)
      await mutations.invalidateAll()
      showToast('success', `"${selectedOntology.name}" restored`)
    } catch (err: unknown) {
      showToast('error', `Failed to restore: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
    hasStagedChangesRef.current = true
    const msg = parentId === childId
      ? `"${humanizeId(childId)}" can now contain itself — save to persist`
      : `"${humanizeId(childId)}" also contained under "${humanizeId(parentId)}" — save to persist`
    showToast('info', msg)
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
    hasStagedChangesRef.current = true
    showToast('info', `Removed "${humanizeId(childId)}" from "${humanizeId(parentId)}" — save to persist`)
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
    hasStagedChangesRef.current = true
    showToast('info', `"${humanizeId(childId)}" is now a root type — save to persist`)
  }

  function handleUpdateContainmentEdgeTypes(newList: string[]) {
    if (!selectedOntology || isLocked) return
    setWorkingContainment(newList)
    hasStagedChangesRef.current = true
    showToast('info', 'Containment edge types updated — save to persist')
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
      {/* Context breadcrumb — always visible; shows environment picker when no workspace active */}
      <div className="relative px-6 pt-3 border-b border-glass-border bg-canvas-elevated/20">
        <OntologyContextBanner
          workspace={activeWorkspace}
          dataSource={activeDataSource}
          workspaces={workspaces}
          selectedOntologyId={selectedOntology?.id ?? null}
          ontologies={ontologies}
          selectedOntology={selectedOntology ?? null}
          isAssigning={isAssigning}
          onAssign={handleAssignOntology}
          onSwitchEnvironment={handleSwitchEnvironment}
          onAssignToDataSource={handleAssignToDataSource}
          onUnassignFromDataSource={handleUnassignFromDataSource}
          onRollOutToWorkspace={handleRollOutToWorkspace}
        />
      </div>

      {/* Main layout: Sidebar + Detail */}
      <div className="flex-1 min-h-0 flex">
        {/* Sidebar — self-sizes via internal width state */}
        <OntologySidebar
            ontologies={ontologies}
            selectedOntologyId={ontologyId}
            activeDataSource={activeDataSource}
            assignmentCountMap={assignmentCountMap}
            workspaces={workspaces}
            isLoading={isLoadingOntologies}
            isSuggesting={isSuggesting}
            onCreateDraft={() => setShowCreateDialog(true)}
            onSuggest={handleSuggestOntology}
          />

        {/* Detail pane */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {selectedOntology ? (
            <>
              {/* Deleted banner */}
              {isDeleted && (
                <div className="flex-shrink-0 mx-8 mt-4 mb-0 flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20">
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
                hasPendingChanges={hasPendingChanges}
                isSaving={isSaving}
                onDiscard={discardChanges}
                onSave={handleSaveAllChanges}
                onReviewChanges={() => setShowChangesReview(true)}
                onValidate={handleValidate}
                onPublish={handlePublish}
                onClone={handleClone}
                onExport={handleExport}
                onImport={() => fileInputRef.current?.click()}
                onEditDetails={() => setEditDetailsTarget(selectedOntology)}
                onDelete={handleDeleteOntology}
              />

              {/* Tabs — underline style (AdminRegistry pattern) */}
              <div className="flex items-center gap-1 border-b border-glass-border px-8 shrink-0">
                {TAB_DEFS.map(t => {
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
                        'flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-all border-b-2 relative',
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
              </div>

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
                      className="p-8"
                    >
                      {activeTab === 'overview' && (
                        <OverviewPanel
                          ontology={selectedOntology}
                          workspaceId={activeWorkspaceId}
                          dataSourceId={activeDataSourceId}
                          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
                          onNavigateTab={(tab) => setTab(tab)}
                        />
                      )}

                      {activeTab === 'schema' && (
                        <SchemaPanel
                          entityTypes={entityTypes}
                          relTypes={relTypes}
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
                          workspaceId={activeWorkspaceId}
                          dataSourceId={activeDataSourceId}
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
                                visual: { strokeColor: '#6366f1', strokeWidth: 2, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier' },
                                bidirectional: false, showLabel: false, isContainment: false, isLineage: false,
                              },
                            })
                            setTab('schema')
                          }}
                        />
                      )}

                      {activeTab === 'adoption' && (
                        <AdoptionPanel ontology={selectedOntology} workspaces={workspaces} ontologies={ontologies} />
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
                <div
                  className={cn(
                    'fixed inset-0 bg-black/15 dark:bg-black/25 z-20 transition-opacity duration-200',
                    editorPanel ? 'opacity-100' : 'opacity-0 pointer-events-none',
                  )}
                  onClick={() => setEditorPanel(null)}
                />

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
                          readOnly={isLocked}
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
          hasGraphContext={!!activeDataSource}
          onClose={() => setShowCreateDialog(false)}
          onCreate={handleCreateDraft}
        />
      )}
      {editDetailsTarget && (
        <EditDetailsDialog
          ontology={editDetailsTarget}
          onClose={() => setEditDetailsTarget(null)}
          onSave={handleSaveOntologyDetails}
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
          isPublishing={isPublishing}
          onConfirm={handleConfirmPublish}
          onClose={() => setPublishImpact(null)}
        />
      )}

      {/* Navigation blocker dialog */}
      {blocker.state === 'blocked' && (
        <UnsavedChangesDialog
          isSaving={isSaving}
          onSave={async () => {
            await handleSaveAllChanges()
            blocker.proceed()
          }}
          onDiscard={() => {
            discardChanges()
            blocker.proceed()
          }}
          onCancel={() => blocker.reset()}
        />
      )}

      {/* Suggest from Graph */}
      {showSuggestDialog && (
        <SuggestConfirmDialog
          dataSourceLabel={activeDataSource?.label || activeDataSource?.id || null}
          suggestedName={generateSuggestedName(activeDataSource?.label, activeWorkspace?.name)}
          ontologies={ontologies}
          currentOntologyId={activeDataSource?.ontologyId ?? null}
          assignmentCountMap={assignmentCountMap}
          onAnalyze={handleAnalyzeGraph}
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

      {/* Discard Confirmation */}
      {showDiscardConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowDiscardConfirm(false)} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl animate-in fade-in zoom-in-95 p-6">
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
