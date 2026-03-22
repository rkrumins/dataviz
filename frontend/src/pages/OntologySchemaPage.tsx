/**
 * OntologySchemaPage — Ontology management console (layout shell).
 *
 * Sidebar + detail pane layout. Ontology selection is URL-driven via
 * :ontologyId param so it survives refresh. All sub-panels are extracted
 * into features/ontology/components/.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useBlocker } from 'react-router'
import { Lock, PenLine, Loader2, BookOpen, Box, GitBranch, FolderTree, BarChart3, Users, Settings, Copy, ShieldCheck, Upload, X, Clock, Save, CircleDot, LayoutDashboard, Download, Trash2, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { EntityTypeEditor } from '@/components/schema/EntityTypeEditor'
import { RelationshipTypeEditor } from '@/components/schema/RelationshipTypeEditor'
import {
  ontologyDefinitionService,
  type OntologyDefinitionResponse,
} from '@/services/ontologyDefinitionService'
import { workspaceService } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { fetchSchemaStats } from '@/features/ontology/lib/ontology-utils'
import { cn } from '@/lib/utils'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { EntityTypeSummary, EdgeTypeSummary } from '@/providers/GraphDataProvider'

import { useOntologies, useOntology } from '@/features/ontology/hooks/useOntologies'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import {
  entityDefToSchema,
  entitySchemaToBackend,
  relDefToSchema,
  relSchemaToBackend,
  humanizeId,
} from '@/features/ontology/lib/ontology-parsers'
import type { OntologyTab, EditorPanel, RelTypeWithClassifications, Toast, ToastType } from '@/features/ontology/lib/ontology-types'

import { OntologyContextBanner } from '@/features/ontology/components/OntologyContextBanner'
import { OntologySidebar } from '@/features/ontology/components/OntologySidebar'
import { OntologyStatusBadge } from '@/features/ontology/components/OntologyStatusBadge'
import { ToastNotification } from '@/features/ontology/components/ToastNotification'
import { CreateOntologyDialog } from '@/features/ontology/components/dialogs/CreateOntologyDialog'
import { EditDetailsDialog } from '@/features/ontology/components/dialogs/EditDetailsDialog'
import { EntityTypesPanel } from '@/features/ontology/components/panels/EntityTypesPanel'
import { RelationshipsPanel } from '@/features/ontology/components/panels/RelationshipsPanel'
import { HierarchyPanel } from '@/features/ontology/components/panels/HierarchyPanel'
import { CoveragePanel } from '@/features/ontology/components/panels/CoveragePanel'
import { UsagePanel } from '@/features/ontology/components/panels/UsagePanel'
import { VersionHistoryPanel } from '@/features/ontology/components/panels/VersionHistoryPanel'
import { SettingsPanel } from '@/features/ontology/components/panels/SettingsPanel'
import { DeleteConfirmDialog } from '@/features/ontology/components/dialogs/DeleteConfirmDialog'
import { UnsavedChangesDialog } from '@/features/ontology/components/dialogs/UnsavedChangesDialog'
import { PublishConfirmDialog } from '@/features/ontology/components/dialogs/PublishConfirmDialog'
import { ImportDialog } from '@/features/ontology/components/dialogs/ImportDialog'
import { SuggestConfirmDialog } from '@/features/ontology/components/dialogs/SuggestConfirmDialog'
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
  { id: 'entities', label: 'Entity Types', icon: Box },
  { id: 'relationships', label: 'Relationships', icon: GitBranch },
  { id: 'hierarchy', label: 'Hierarchy', icon: FolderTree },
  { id: 'coverage', label: 'Coverage', icon: BarChart3 },
  { id: 'usage', label: 'Usage', icon: Users },
  { id: 'history', label: 'History', icon: Clock },
  { id: 'settings', label: 'Settings', icon: Settings },
]

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export function OntologySchemaPage() {
  const navigate = useNavigate()
  const { ontologyId } = useParams<{ ontologyId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = (searchParams.get('tab') || 'overview') as OntologyTab

  // ── Workspace context ──────────────────────────────────────────────
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
  const setActiveWorkspace = useWorkspacesStore(s => s.setActiveWorkspace)
  const setActiveDataSource = useWorkspacesStore(s => s.setActiveDataSource)
  const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)

  // ── URL params → data source context (navigation state) ──────────
  const urlWorkspaceId = searchParams.get('workspaceId')
  const urlDataSourceId = searchParams.get('dataSourceId')

  // Sync URL params into Zustand on mount (e.g. from AdminWorkspaceDetail links)
  useEffect(() => {
    if (urlWorkspaceId && urlWorkspaceId !== activeWorkspaceId) {
      setActiveWorkspace(urlWorkspaceId)
    }
    if (urlDataSourceId && urlDataSourceId !== activeDataSourceId) {
      setActiveDataSource(urlDataSourceId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWorkspaceId, urlDataSourceId])

  // Sync Zustand changes back to URL (e.g. from EnvironmentSwitcher)
  useEffect(() => {
    if (activeWorkspaceId) {
      const currentWs = searchParams.get('workspaceId')
      const currentDs = searchParams.get('dataSourceId')
      if (currentWs !== activeWorkspaceId || (activeDataSourceId && currentDs !== activeDataSourceId)) {
        setSearchParams(prev => {
          prev.set('workspaceId', activeWorkspaceId)
          if (activeDataSourceId) prev.set('dataSourceId', activeDataSourceId)
          else prev.delete('dataSourceId')
          return prev
        }, { replace: true })
      }
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

  // ── Local state ────────────────────────────────────────────────────
  const [editorPanel, setEditorPanel] = useState<EditorPanel>(null)
  const [toast, setToast] = useState<Toast | null>(null)
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
  const toastIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null)
  const [showSuggestDialog, setShowSuggestDialog] = useState(false)
  const suggestResponseRef = useRef<import('@/services/ontologyDefinitionService').OntologySuggestResponse | null>(null)

  // ── Edit mode + working copies ──────────────────────────────────
  const [isEditing, setIsEditing] = useState(false)
  const [workingEntityDefs, setWorkingEntityDefs] = useState<Record<string, unknown> | null>(null)
  const [workingRelDefs, setWorkingRelDefs] = useState<Record<string, unknown> | null>(null)
  const [workingContainment, setWorkingContainment] = useState<string[] | null>(null)
  const [workingLineage, setWorkingLineage] = useState<string[] | null>(null)

  // ── Derived ────────────────────────────────────────────────────────
  const isDeleted = !!selectedOntology?.deletedAt
  const isImmutable = !selectedOntology || selectedOntology.isSystem || selectedOntology.isPublished || isDeleted
  const isLocked = isImmutable || !isEditing

  // Use working copies when editing, otherwise server data
  const effectiveEntityDefs = useMemo(() => {
    if (isEditing && workingEntityDefs) return workingEntityDefs
    return (selectedOntology?.entityTypeDefinitions as Record<string, unknown>) ?? {}
  }, [isEditing, workingEntityDefs, selectedOntology])

  const effectiveRelDefs = useMemo(() => {
    if (isEditing && workingRelDefs) return workingRelDefs
    return (selectedOntology?.relationshipTypeDefinitions as Record<string, unknown>) ?? {}
  }, [isEditing, workingRelDefs, selectedOntology])

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

  // Detect pending changes
  const hasPendingChanges = useMemo(() => {
    if (!isEditing || !selectedOntology) return false
    if (workingEntityDefs && JSON.stringify(workingEntityDefs) !== JSON.stringify(selectedOntology.entityTypeDefinitions ?? {})) return true
    if (workingRelDefs && JSON.stringify(workingRelDefs) !== JSON.stringify(selectedOntology.relationshipTypeDefinitions ?? {})) return true
    if (workingContainment && JSON.stringify(workingContainment) !== JSON.stringify(selectedOntology.containmentEdgeTypes ?? [])) return true
    if (workingLineage && JSON.stringify(workingLineage) !== JSON.stringify(selectedOntology.lineageEdgeTypes ?? [])) return true
    return false
  }, [isEditing, selectedOntology, workingEntityDefs, workingRelDefs, workingContainment, workingLineage])

  // Track which individual entity/rel IDs have been modified
  const changedEntityIds = useMemo((): Set<string> => {
    if (!isEditing || !selectedOntology || !workingEntityDefs) return new Set()
    const serverDefs = (selectedOntology.entityTypeDefinitions as Record<string, unknown>) ?? {}
    const changed = new Set<string>()
    const allIds = new Set([...Object.keys(serverDefs), ...Object.keys(workingEntityDefs)])
    for (const id of allIds) {
      if (JSON.stringify(serverDefs[id]) !== JSON.stringify(workingEntityDefs[id])) {
        changed.add(id)
      }
    }
    return changed
  }, [isEditing, selectedOntology, workingEntityDefs])

  const changedRelIds = useMemo((): Set<string> => {
    if (!isEditing || !selectedOntology || !workingRelDefs) return new Set()
    const serverDefs = (selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}
    const changed = new Set<string>()
    const allIds = new Set([...Object.keys(serverDefs), ...Object.keys(workingRelDefs)])
    for (const id of allIds) {
      if (JSON.stringify(serverDefs[id]) !== JSON.stringify(workingRelDefs[id])) {
        changed.add(id)
      }
    }
    return changed
  }, [isEditing, selectedOntology, workingRelDefs])

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

  const showToast = useCallback((type: ToastType, message: string, action?: { label: string; onClick: () => void }) => {
    setToast({ type, message, id: ++toastIdRef.current, action })
  }, [])

  // ── Edit mode helpers ─────────────────────────────────────────────
  function enterEditMode() {
    if (isImmutable || !selectedOntology) return
    setWorkingEntityDefs({ ...((selectedOntology.entityTypeDefinitions as Record<string, unknown>) ?? {}) })
    setWorkingRelDefs({ ...((selectedOntology.relationshipTypeDefinitions as Record<string, unknown>) ?? {}) })
    setWorkingContainment([...(selectedOntology.containmentEdgeTypes ?? [])])
    setWorkingLineage([...(selectedOntology.lineageEdgeTypes ?? [])])
    setIsEditing(true)
  }

  function discardChanges() {
    setWorkingEntityDefs(null)
    setWorkingRelDefs(null)
    setWorkingContainment(null)
    setWorkingLineage(null)
    setIsEditing(false)
    setEditorPanel(null)
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

      await mutations.update.mutateAsync({ id: selectedOntology.id, req })
      showToast('success', 'All changes saved')
      discardChanges()
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

  // React Router navigation
  const blocker = useBlocker(hasPendingChanges)

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
    // URL will auto-sync via the Zustand → URL useEffect
  }

  async function handleAssignOntology(assignId: string | undefined) {
    if (!activeWorkspace || !activeDataSource) return
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(activeWorkspace.id, activeDataSource.id, {
        ontologyId: assignId,
      })
      await loadWorkspaces()
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
    showToast('info', `"${relType.name}" updated — save to persist`)
    setEditorPanel(null)
  }

  function handleDeleteEntityType(id: string, name: string) {
    if (!selectedOntology || isLocked || !workingEntityDefs) return
    if (!window.confirm(`Delete entity type "${name}"?`)) return
    const defs = { ...workingEntityDefs }
    delete defs[id]
    setWorkingEntityDefs(defs)
    showToast('info', `"${name}" removed — save to persist`)
  }

  function handleDeleteRelType(id: string, name: string) {
    if (!selectedOntology || isLocked || !workingRelDefs) return
    if (!window.confirm(`Delete relationship type "${name}"?`)) return
    const defs = { ...workingRelDefs }
    delete defs[id.toUpperCase()]
    setWorkingRelDefs(defs)
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
      navigate(schemaUrl(cloned.id, 'entities'))
      showToast('success', 'Cloned — now editing a new draft')
    } catch (err: unknown) {
      showToast('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  /** User chose "Create New Draft" (skip recommendations). */
  async function handleSuggestCreateDraft() {
    const response = suggestResponseRef.current
    if (!response) return
    setIsSuggesting(true)
    try {
      const created = await ontologyDefinitionService.create({
        ...response.suggested,
        name: `Suggested Semantic Layer (${new Date().toLocaleDateString()})`,
      })
      setShowSuggestDialog(false)
      navigate(schemaUrl(created.id, 'entities'))
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
      const res = await fetch(`/api/v1/admin/ontologies/${selectedOntology.id}/export`)
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
        const created = await ontologyDefinitionService.create({ ...response.suggested, name })
        navigate(schemaUrl(created.id, 'entities'))
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
            mutations.invalidateAll()
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
      mutations.invalidateAll()
      showToast('success', `"${selectedOntology.name}" restored`)
    } catch (err: unknown) {
      showToast('error', `Failed to restore: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  function handleReparentEntityType(childId: string, newParentId: string | null) {
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

    defs[childId] = { ...childDef, hierarchy: { ...childHierarchy, can_be_contained_by: newParentId ? [newParentId] : [] } }

    if (newParentId && defs[newParentId]) {
      const pDef = defs[newParentId]
      const pH = (pDef.hierarchy as Record<string, unknown>) ?? {}
      const pCC: string[] = (pH.can_contain as string[]) ?? []
      if (!pCC.includes(childId)) {
        defs[newParentId] = { ...pDef, hierarchy: { ...pH, can_contain: [...pCC, childId] } }
      }
    }

    setWorkingEntityDefs(defs)
    showToast('info', newParentId ? `Moved under ${humanizeId(newParentId)} — save to persist` : `"${humanizeId(childId)}" is now a root type — save to persist`)
  }

  function handleUpdateContainmentEdgeTypes(newList: string[]) {
    if (!selectedOntology || isLocked) return
    setWorkingContainment(newList)
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
          graphStats={null}
          isAssigning={isAssigning}
          onAssign={handleAssignOntology}
          onSwitchEnvironment={handleSwitchEnvironment}
        />
      </div>

      {/* Main layout: Sidebar + Detail */}
      <div className="flex-1 min-h-0 flex">
        {/* Sidebar */}
        <div className="flex-shrink-0 overflow-hidden">
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
        </div>

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

              {/* Detail header — clean AdminRegistry style */}
              <div className="flex-shrink-0 px-8 pt-6 pb-0">
                {/* Top row: name + status + toolbar */}
                <div className="flex items-start justify-between mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h1 className="text-2xl font-bold tracking-tight text-ink truncate">{selectedOntology.name}</h1>
                      <span className="text-xs text-ink-muted font-mono flex-shrink-0">v{selectedOntology.version}</span>
                      <OntologyStatusBadge ontology={selectedOntology} />
                      {isImmutable
                        ? <Lock className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                        : isEditing
                          ? <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                          : <Lock className="w-3.5 h-3.5 text-ink-muted/40 flex-shrink-0" />}
                      {hasPendingChanges && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-[10px] font-bold text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20 animate-pulse">
                          <CircleDot className="w-2.5 h-2.5" />
                          Unsaved
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-ink-muted mt-1 max-w-2xl">
                      {selectedOntology.description || `${Object.keys(selectedOntology.entityTypeDefinitions ?? {}).length} entity types · ${Object.keys(selectedOntology.relationshipTypeDefinitions ?? {}).length} relationships`}
                    </p>
                  </div>

                  {/* Action toolbar */}
                  <div className="flex items-center gap-1.5 flex-shrink-0 ml-4">
                    {!selectedOntology.isSystem && !isEditing && (
                      <button
                        onClick={() => setEditDetailsTarget(selectedOntology)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        Details
                      </button>
                    )}
                    <button
                      onClick={handleExport}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-glass-border hover:border-glass-border-hover hover:bg-black/[0.03] dark:hover:bg-white/[0.03] text-ink-secondary transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-glass-border hover:border-glass-border-hover hover:bg-black/[0.03] dark:hover:bg-white/[0.03] text-ink-secondary transition-all"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import
                    </button>
                    <button
                      onClick={handleClone}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-glass-border hover:border-indigo-300 hover:bg-indigo-500/[0.06] text-ink-secondary hover:text-indigo-600 transition-all"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Clone
                    </button>

                    {isEditing ? (
                      <>
                        {/* Discard */}
                        <button
                          onClick={discardChanges}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 hover:bg-red-100 dark:hover:bg-red-950/40 border border-red-200/60 dark:border-red-800/40 transition-all"
                        >
                          <X className="w-4 h-4" />
                          Discard
                        </button>
                        <button
                          onClick={handleValidate}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border border-glass-border hover:border-emerald-300 hover:bg-emerald-500/[0.06] text-ink-secondary hover:text-emerald-600 transition-all"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          Validate
                        </button>
                        {/* Save Changes — primary action when editing */}
                        <button
                          onClick={handleSaveAllChanges}
                          disabled={!hasPendingChanges || isSaving}
                          className={cn(
                            'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold transition-all',
                            hasPendingChanges
                              ? 'bg-emerald-500 text-white hover:bg-emerald-600 shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30'
                              : 'bg-emerald-500/40 text-white/60 cursor-not-allowed shadow-none',
                          )}
                        >
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          {isSaving ? 'Saving...' : 'Save Changes'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={handleValidate}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border border-glass-border hover:border-emerald-300 hover:bg-emerald-500/[0.06] text-ink-secondary hover:text-emerald-600 transition-all"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          Validate
                        </button>
                        {!isImmutable && (
                          <>
                            <button
                              onClick={enterEditMode}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
                            >
                              <PenLine className="w-4 h-4" />
                              Edit
                            </button>
                            <button
                              onClick={handlePublish}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 transition-all shadow-md shadow-indigo-500/25"
                            >
                              <Upload className="w-4 h-4" />
                              Publish
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Tabs — underline style (AdminRegistry pattern) */}
              <div className="flex items-center gap-1 border-b border-glass-border px-8 shrink-0">
                {TAB_DEFS.map(t => {
                  const Icon = t.icon
                  const isActive = activeTab === t.id
                  const count = t.id === 'entities' ? entityTypes.length
                    : t.id === 'relationships' ? relTypes.length
                    : undefined
                  const tabHasChanges = isEditing && (
                    (t.id === 'entities' && hasEntityChanges) ||
                    (t.id === 'relationships' && hasRelChanges) ||
                    (t.id === 'hierarchy' && hasHierarchyChanges)
                  )
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
                <div className={cn('min-w-0 overflow-y-auto', editorPanel ? 'flex-[2]' : 'flex-1')}>
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
                          graphStats={null}
                          coverage={null}
                          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
                          onNavigateTab={(tab) => setTab(tab)}
                          onExport={handleExport}
                          onImport={() => fileInputRef.current?.click()}
                        />
                      )}

                      {activeTab === 'entities' && (
                        <EntityTypesPanel
                          entityTypes={entityTypes}
                          entityStatMap={entityStatMap}
                          isLocked={isLocked}
                          search={search}
                          validationResult={validationResult}
                          editorPanel={editorPanel}
                          changedIds={changedEntityIds}
                          onSearch={setSearch}
                          onEdit={et => setEditorPanel({ kind: 'entity', data: et })}
                          onNew={() => setEditorPanel({ kind: 'entity' })}
                          onDelete={handleDeleteEntityType}
                          onDismissValidation={() => setValidationResult(null)}
                        />
                      )}

                      {activeTab === 'relationships' && (
                        <RelationshipsPanel
                          relTypes={relTypes}
                          edgeStatMap={edgeStatMap}
                          isLocked={isLocked}
                          search={search}
                          editorPanel={editorPanel}
                          changedIds={changedRelIds}
                          onSearch={setSearch}
                          onEdit={rt => setEditorPanel({ kind: 'rel', data: rt })}
                          onNew={() => setEditorPanel({ kind: 'rel' })}
                          onDelete={handleDeleteRelType}
                        />
                      )}

                      {activeTab === 'hierarchy' && (
                        <HierarchyPanel
                          selectedOntology={selectedOntology}
                          entityTypes={entityTypes}
                          relTypes={relTypes}
                          isLocked={isLocked}
                          isSaving={isSaving}
                          onReparent={handleReparentEntityType}
                          onEditType={et => { setEditorPanel({ kind: 'entity', data: et }); setTab('entities') }}
                          onUpdateContainmentEdgeTypes={handleUpdateContainmentEdgeTypes}
                        />
                      )}

                      {activeTab === 'coverage' && (
                        <CoveragePanel
                          ontologyId={selectedOntology.id}
                          workspaceId={activeWorkspaceId}
                          dataSourceId={activeDataSourceId}
                          isLocked={isLocked}
                          onDefineEntity={typeId => {
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
                            setTab('entities')
                          }}
                          onDefineRel={typeId => {
                            const name = humanizeId(typeId)
                            setEditorPanel({
                              kind: 'rel',
                              data: {
                                id: typeId, name, description: '', sourceTypes: [], targetTypes: [],
                                visual: { strokeColor: '#6366f1', strokeWidth: 2, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier' },
                                bidirectional: false, showLabel: false, isContainment: false, isLineage: false,
                              },
                            })
                            setTab('relationships')
                          }}
                        />
                      )}

                      {activeTab === 'usage' && (
                        <UsagePanel ontology={selectedOntology} />
                      )}

                      {activeTab === 'history' && (
                        <VersionHistoryPanel ontology={selectedOntology} />
                      )}

                      {activeTab === 'settings' && (
                        <SettingsPanel
                          ontology={selectedOntology}
                          onSaveDetails={handleSaveOntologyDetails}
                          onDelete={handleDeleteOntology}
                          isSaving={mutations.update.isPending}
                          assignmentCount={assignmentCountMap.get(selectedOntology.id) ?? 0}
                        />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {/* Editor slide-in with backdrop */}
                <AnimatePresence>
                  {editorPanel && (
                    <>
                      {/* Backdrop overlay */}
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="fixed inset-0 bg-black/15 dark:bg-black/25 z-20"
                        onClick={() => setEditorPanel(null)}
                      />

                      {/* Panel */}
                      <motion.div
                        initial={{ x: 40, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: 40, opacity: 0 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                        className="w-[440px] flex-shrink-0 border-l border-glass-border overflow-hidden flex flex-col relative z-30 bg-canvas-elevated"
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
                    </>
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

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* Toast */}
      <AnimatePresence>
        {toast && <ToastNotification key={toast.id} toast={toast} onDismiss={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  )
}
