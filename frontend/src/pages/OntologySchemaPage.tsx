/**
 * OntologySchemaPage — Ontology management console.
 *
 * Follows the AdminRegistry tab pattern with workspace-aware context:
 *   • Context banner — active workspace/data source + assigned ontology + graph stats
 *   • Library tab — browse, create, clone, filter, suggest ontologies
 *   • Entity Types tab — define node types with hierarchy and visuals
 *   • Relationships tab — classify edges as containment / lineage / other
 *   • Coverage tab — gap analysis against live graph data
 *
 * Types are sourced from the SELECTED ontology's raw definitions (not Zustand store).
 * isContainment / isLineage are properly wired to RelationshipTypeEditor.
 * All saves show toast feedback; errors surface visibly.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as LucideIcons from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { EntityTypeEditor } from '@/components/schema/EntityTypeEditor'
import { RelationshipTypeEditor } from '@/components/schema/RelationshipTypeEditor'
import {
  ontologyDefinitionService,
  type OntologyDefinitionResponse,
} from '@/services/ontologyDefinitionService'
import { workspaceService, type DataSourceResponse } from '@/services/workspaceService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useInvalidateGraphSchema } from '@/hooks/useGraphSchema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { cn } from '@/lib/utils'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type {
  GraphSchemaStats,
  EntityTypeSummary,
  EdgeTypeSummary,
} from '@/providers/GraphDataProvider'

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface RelTypeWithClassifications extends RelationshipTypeSchema {
  isContainment?: boolean
  isLineage?: boolean
  category?: 'structural' | 'flow' | 'metadata' | 'association'
  direction?: 'source-to-target' | 'target-to-source' | 'bidirectional'
}

type ToastType = 'success' | 'error' | 'warning' | 'info'
interface Toast { type: ToastType; message: string; id: number }

type Tab = 'library' | 'entities' | 'relationships' | 'coverage' | 'hierarchy'
type StatusFilter = 'all' | 'system' | 'published' | 'draft'

interface CoverageState {
  uncoveredEntityTypes: string[]
  uncoveredRelationshipTypes: string[]
  coveragePercent: number
}

type EditorPanel =
  | null
  | { kind: 'entity'; data?: EntityTypeSchema }
  | { kind: 'rel'; data?: RelTypeWithClassifications }

// ---------------------------------------------------------------------------
// Parse helpers — raw ontology JSON (snake_case) → frontend types (camelCase)
// ---------------------------------------------------------------------------

function entityDefToSchema(id: string, def: Record<string, unknown>): EntityTypeSchema {
  const visual = (def.visual as Record<string, unknown>) ?? {}
  const hierarchy = (def.hierarchy as Record<string, unknown>) ?? {}
  const behavior = (def.behavior as Record<string, unknown>) ?? {}
  const fields = (def.fields as Array<Record<string, unknown>>) ?? []

  return {
    id,
    name: (def.name as string) ?? humanizeId(id),
    pluralName: (def.plural_name as string) ?? `${(def.name as string) ?? humanizeId(id)}s`,
    description: def.description as string | undefined,
    visual: {
      icon: (visual.icon as string) ?? 'Box',
      color: (visual.color as string) ?? '#6366f1',
      shape: ((visual.shape as string) ?? 'rounded') as EntityTypeSchema['visual']['shape'],
      size: ((visual.size as string) ?? 'md') as EntityTypeSchema['visual']['size'],
      borderStyle: ((visual.border_style as string) ?? 'solid') as EntityTypeSchema['visual']['borderStyle'],
      showInMinimap: (visual.show_in_minimap as boolean) ?? true,
    },
    fields: fields.map(f => ({
      id: f.id as string,
      name: f.name as string,
      type: ((f.type as string) ?? 'string') as EntityTypeSchema['fields'][number]['type'],
      required: (f.required as boolean) ?? false,
      showInNode: (f.show_in_node as boolean) ?? false,
      showInPanel: (f.show_in_panel as boolean) ?? true,
      showInTooltip: (f.show_in_tooltip as boolean) ?? false,
      displayOrder: (f.display_order as number) ?? 0,
    })),
    hierarchy: {
      level: (hierarchy.level as number) ?? 0,
      canContain: (hierarchy.can_contain as string[]) ?? [],
      canBeContainedBy: (hierarchy.can_be_contained_by as string[]) ?? [],
      defaultExpanded: (hierarchy.default_expanded as boolean) ?? false,
      rollUpFields: [],
    },
    behavior: {
      selectable: (behavior.selectable as boolean) ?? true,
      draggable: (behavior.draggable as boolean) ?? true,
      expandable: (behavior.expandable as boolean) ?? true,
      traceable: (behavior.traceable as boolean) ?? true,
      clickAction: ((behavior.click_action as string) ?? 'select') as EntityTypeSchema['behavior']['clickAction'],
      doubleClickAction: ((behavior.double_click_action as string) ?? 'expand') as EntityTypeSchema['behavior']['doubleClickAction'],
    },
  }
}

function relDefToSchema(id: string, def: Record<string, unknown>): RelTypeWithClassifications {
  const visual = (def.visual as Record<string, unknown>) ?? {}
  return {
    id,
    name: (def.name as string) ?? humanizeId(id),
    description: def.description as string | undefined,
    sourceTypes: (def.source_types as string[]) ?? [],
    targetTypes: (def.target_types as string[]) ?? [],
    visual: {
      strokeColor: (visual.stroke_color as string) ?? '#6366f1',
      strokeWidth: (visual.stroke_width as number) ?? 2,
      strokeStyle: ((visual.stroke_style as string) ?? 'solid') as RelationshipTypeSchema['visual']['strokeStyle'],
      animated: (visual.animated as boolean) ?? false,
      animationSpeed: ((visual.animation_speed as string) ?? 'normal') as RelationshipTypeSchema['visual']['animationSpeed'],
      arrowType: ((visual.arrow_type as string) ?? 'arrow') as RelationshipTypeSchema['visual']['arrowType'],
      curveType: ((visual.curve_type as string) ?? 'bezier') as RelationshipTypeSchema['visual']['curveType'],
    },
    bidirectional: (def.bidirectional as boolean) ?? false,
    showLabel: (def.show_label as boolean) ?? false,
    isContainment: (def.is_containment as boolean) ?? false,
    isLineage: (def.is_lineage as boolean) ?? false,
    category: ((def.category as string) ?? 'association') as RelTypeWithClassifications['category'],
    direction: ((def.direction as string) ?? 'source-to-target') as RelTypeWithClassifications['direction'],
  }
}

function entitySchemaToBackend(et: EntityTypeSchema): Record<string, unknown> {
  return {
    name: et.name,
    plural_name: et.pluralName,
    description: et.description,
    visual: {
      icon: et.visual.icon,
      color: et.visual.color,
      shape: et.visual.shape,
      size: et.visual.size,
      border_style: et.visual.borderStyle,
      show_in_minimap: et.visual.showInMinimap,
    },
    hierarchy: {
      level: et.hierarchy.level,
      can_contain: et.hierarchy.canContain,
      can_be_contained_by: et.hierarchy.canBeContainedBy,
      default_expanded: et.hierarchy.defaultExpanded,
      roll_up_fields: et.hierarchy.rollUpFields ?? [],
    },
    behavior: {
      selectable: et.behavior.selectable,
      draggable: et.behavior.draggable,
      expandable: et.behavior.expandable,
      traceable: et.behavior.traceable,
      click_action: et.behavior.clickAction,
      double_click_action: et.behavior.doubleClickAction,
    },
    fields: et.fields,
  }
}

function relSchemaToBackend(rt: RelTypeWithClassifications): Record<string, unknown> {
  return {
    name: rt.name,
    description: rt.description,
    is_containment: rt.isContainment ?? false,
    is_lineage: rt.isLineage ?? false,
    category: rt.category ?? 'association',
    direction: rt.direction ?? 'source-to-target',
    visual: {
      stroke_color: rt.visual.strokeColor,
      stroke_width: rt.visual.strokeWidth,
      stroke_style: rt.visual.strokeStyle,
      animated: rt.visual.animated,
      animation_speed: rt.visual.animationSpeed,
      arrow_type: rt.visual.arrowType,
      curve_type: rt.visual.curveType,
    },
    source_types: rt.sourceTypes,
    target_types: rt.targetTypes,
    bidirectional: rt.bidirectional,
    show_label: rt.showLabel,
  }
}

function humanizeId(id: string): string {
  return id
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export function OntologySchemaPage() {
  const invalidateSchema = useInvalidateGraphSchema()
  const provider = useGraphProvider()

  // Workspace context (from Zustand store — already loaded by AppLayout)
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
  const loadWorkspaces = useWorkspacesStore(s => s.loadWorkspaces)

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId]
  )
  const activeDataSource = useMemo(
    () => activeWorkspace?.dataSources?.find(ds => ds.id === activeDataSourceId) ?? null,
    [activeWorkspace, activeDataSourceId]
  )

  // Tab state (URL-driven, same pattern as AdminRegistry)
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = (searchParams.get('tab') || 'library') as Tab

  // Core state
  const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])
  const [selectedOntologyId, setSelectedOntologyId] = useState<string | null>(null)
  const [graphStats, setGraphStats] = useState<GraphSchemaStats | null>(null)
  const [coverage, setCoverage] = useState<CoverageState | null>(null)
  const [editorPanel, setEditorPanel] = useState<EditorPanel>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isLoadingOntologies, setIsLoadingOntologies] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [isAssigning, setIsAssigning] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    isValid: boolean
    issues: Array<{ severity: string; message: string }>
  } | null>(null)
  const toastIdRef = useRef(0)

  // Derived
  const selectedOntology = useMemo(
    () => ontologies.find(o => o.id === selectedOntologyId) ?? null,
    [ontologies, selectedOntologyId]
  )
  const isLocked = !selectedOntology || selectedOntology.isSystem || selectedOntology.isPublished

  const entityTypes = useMemo((): EntityTypeSchema[] => {
    if (!selectedOntology?.entityTypeDefinitions) return []
    return Object.entries(selectedOntology.entityTypeDefinitions as Record<string, Record<string, unknown>>)
      .map(([id, def]) => entityDefToSchema(id, def))
      .sort((a, b) => a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name))
  }, [selectedOntology])

  const relTypes = useMemo((): RelTypeWithClassifications[] => {
    if (!selectedOntology?.relationshipTypeDefinitions) return []
    return Object.entries(selectedOntology.relationshipTypeDefinitions as Record<string, Record<string, unknown>>)
      .map(([id, def]) => relDefToSchema(id, def))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [selectedOntology])

  const entityStatMap = useMemo((): Map<string, EntityTypeSummary> => {
    const m = new Map<string, EntityTypeSummary>()
    for (const s of graphStats?.entityTypeStats ?? []) m.set(s.id.toLowerCase(), s)
    return m
  }, [graphStats])

  const edgeStatMap = useMemo((): Map<string, EdgeTypeSummary> => {
    const m = new Map<string, EdgeTypeSummary>()
    for (const s of graphStats?.edgeTypeStats ?? []) m.set(s.id.toUpperCase(), s)
    return m
  }, [graphStats])

  // Ontology assignment count derived from workspace store (no extra API calls)
  const assignmentCountMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const ws of workspaces) {
      for (const ds of ws.dataSources ?? []) {
        if (ds.ontologyId) m.set(ds.ontologyId, (m.get(ds.ontologyId) ?? 0) + 1)
      }
    }
    return m
  }, [workspaces])

  // Tab config
  const tabDefs: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number; needsSelection?: boolean }> = [
    { id: 'library', label: 'Ontology Library', icon: LucideIcons.BookOpen },
    { id: 'entities', label: 'Entity Types', icon: LucideIcons.Box, count: entityTypes.length, needsSelection: true },
    { id: 'relationships', label: 'Relationships', icon: LucideIcons.GitBranch, count: relTypes.length, needsSelection: true },
    { id: 'hierarchy', label: 'Hierarchy Map', icon: LucideIcons.FolderTree, needsSelection: true },
    { id: 'coverage', label: 'Coverage', icon: LucideIcons.BarChart3, needsSelection: true },
  ]

  const showToast = useCallback((type: ToastType, message: string) => {
    setToast({ type, message, id: ++toastIdRef.current })
  }, [])

  // ── Data loading ─────────────────────────────────────────────────────

  const loadOntologies = useCallback(async () => {
    setIsLoadingOntologies(true)
    try {
      const list = await ontologyDefinitionService.list()
      setOntologies(list)
      setSelectedOntologyId(prev => {
        if (prev && list.find(o => o.id === prev)) return prev
        if (activeDataSource?.ontologyId) {
          const match = list.find(o => o.id === activeDataSource.ontologyId)
          if (match) return match.id
        }
        return list[0]?.id ?? null
      })
    } catch {
      showToast('error', 'Failed to load ontologies')
    } finally {
      setIsLoadingOntologies(false)
    }
  }, [showToast, activeDataSource?.ontologyId])

  useEffect(() => { loadOntologies() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadWorkspaces() }, [loadWorkspaces])
  useEffect(() => {
    provider.getSchemaStats().then(setGraphStats).catch(() => {})
  }, [provider])

  useEffect(() => {
    if (!selectedOntologyId || !graphStats) return
    ontologyDefinitionService
      .coverage(selectedOntologyId, graphStats as unknown as Record<string, unknown>)
      .then(c => setCoverage({
        uncoveredEntityTypes: c.uncoveredEntityTypes,
        uncoveredRelationshipTypes: c.uncoveredRelationshipTypes,
        coveragePercent: c.coveragePercent,
      }))
      .catch(() => setCoverage(null))
  }, [selectedOntologyId, graphStats])

  // ── Handlers ─────────────────────────────────────────────────────────

  async function handleAssignOntology(ontologyId: string | undefined) {
    if (!activeWorkspace || !activeDataSource) return
    setIsAssigning(true)
    try {
      await workspaceService.updateDataSource(activeWorkspace.id, activeDataSource.id, {
        ontologyId: ontologyId,
      })
      await loadWorkspaces()
      invalidateSchema()
      if (ontologyId) setSelectedOntologyId(ontologyId)
      showToast('success', ontologyId ? 'Ontology assigned to data source' : 'Ontology assignment cleared')
    } catch (err: unknown) {
      showToast('error', `Assignment failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsAssigning(false)
    }
  }

  async function handleSaveEntityType(entityType: EntityTypeSchema) {
    if (!selectedOntology) return
    if (isLocked) { showToast('warning', 'Clone this ontology to make edits'); return }
    setIsSaving(true)
    try {
      const current = await ontologyDefinitionService.get(selectedOntology.id)
      const currentDefs = (current.entityTypeDefinitions as Record<string, Record<string, unknown>>) ?? {}

      // Get old hierarchy values to detect changes for bidirectional sync
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

      // Bidirectional sync — canContain side:
      // Types removed from canContain → remove entityType.id from their canBeContainedBy
      for (const childId of oldCanContain.filter(c => !newCanContain.includes(c))) {
        if (updatedDefs[childId]) {
          const d = updatedDefs[childId] as Record<string, unknown>
          const h = (d.hierarchy as Record<string, unknown>) ?? {}
          updatedDefs[childId] = { ...d, hierarchy: { ...h, can_be_contained_by: ((h.can_be_contained_by as string[]) ?? []).filter(p => p !== entityType.id) } }
        }
      }
      // Types added to canContain → add entityType.id to their canBeContainedBy
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

      // Bidirectional sync — canBeContainedBy side:
      // Types removed from canBeContainedBy → remove entityType.id from their canContain
      for (const parentId of oldCanBeContainedBy.filter(p => !newCanBeContainedBy.includes(p))) {
        if (updatedDefs[parentId]) {
          const d = updatedDefs[parentId] as Record<string, unknown>
          const h = (d.hierarchy as Record<string, unknown>) ?? {}
          updatedDefs[parentId] = { ...d, hierarchy: { ...h, can_contain: ((h.can_contain as string[]) ?? []).filter(c => c !== entityType.id) } }
        }
      }
      // Types added to canBeContainedBy → add entityType.id to their canContain
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

      const updated = await ontologyDefinitionService.update(selectedOntology.id, { entityTypeDefinitions: updatedDefs })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      invalidateSchema()
      showToast('success', `Entity type "${entityType.name}" saved`)
      setEditorPanel(null)
    } catch (err: unknown) {
      showToast('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveRelType(relType: RelTypeWithClassifications) {
    if (!selectedOntology) return
    if (isLocked) { showToast('warning', 'Clone this ontology to make edits'); return }
    setIsSaving(true)
    try {
      const current = await ontologyDefinitionService.get(selectedOntology.id)
      const relId = relType.id.toUpperCase()
      const updatedRelDefs = {
        ...((current.relationshipTypeDefinitions as Record<string, unknown>) ?? {}),
        [relId]: relSchemaToBackend(relType),
      }

      // Sync containmentEdgeTypes array — keep in lockstep with isContainment flag
      let containmentEdgeTypes = [...(current.containmentEdgeTypes ?? [])]
      if (relType.isContainment) {
        if (!containmentEdgeTypes.includes(relId)) containmentEdgeTypes.push(relId)
      } else {
        containmentEdgeTypes = containmentEdgeTypes.filter(t => t !== relId)
      }

      // Sync lineageEdgeTypes array — keep in lockstep with isLineage flag
      let lineageEdgeTypes = [...(current.lineageEdgeTypes ?? [])]
      if (relType.isLineage) {
        if (!lineageEdgeTypes.includes(relId)) lineageEdgeTypes.push(relId)
      } else {
        lineageEdgeTypes = lineageEdgeTypes.filter(t => t !== relId)
      }

      const updated = await ontologyDefinitionService.update(selectedOntology.id, {
        relationshipTypeDefinitions: updatedRelDefs,
        containmentEdgeTypes,
        lineageEdgeTypes,
      })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      invalidateSchema()
      showToast('success', `Relationship type "${relType.name}" saved`)
      setEditorPanel(null)
    } catch (err: unknown) {
      showToast('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteEntityType(id: string, name: string) {
    if (!selectedOntology || isLocked) return
    if (!window.confirm(`Delete entity type "${name}"? This cannot be undone.`)) return
    setIsSaving(true)
    try {
      const current = await ontologyDefinitionService.get(selectedOntology.id)
      const defs = { ...((current.entityTypeDefinitions as Record<string, unknown>) ?? {}) }
      delete defs[id]
      const updated = await ontologyDefinitionService.update(selectedOntology.id, { entityTypeDefinitions: defs })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      invalidateSchema()
      showToast('success', `"${name}" deleted`)
    } catch (err: unknown) {
      showToast('error', `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteRelType(id: string, name: string) {
    if (!selectedOntology || isLocked) return
    if (!window.confirm(`Delete relationship type "${name}"? This cannot be undone.`)) return
    setIsSaving(true)
    try {
      const current = await ontologyDefinitionService.get(selectedOntology.id)
      const defs = { ...((current.relationshipTypeDefinitions as Record<string, unknown>) ?? {}) }
      delete defs[id.toUpperCase()]
      const updated = await ontologyDefinitionService.update(selectedOntology.id, { relationshipTypeDefinitions: defs })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      invalidateSchema()
      showToast('success', `"${name}" deleted`)
    } catch (err: unknown) {
      showToast('error', `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSuggestOntology() {
    if (!window.confirm(
      'Generate ontology definitions from your graph\'s current types?\n\n' +
      'This creates a new draft containing ONLY the entity and relationship ' +
      'types that exist in your active data source. You can review and edit before publishing.'
    )) return
    setIsSuggesting(true)
    try {
      const stats = await provider.getSchemaStats()
      // Do NOT pass base_ontology_id — that includes ALL types from the base
      // ontology regardless of whether they exist in the graph. The backend
      // resolver already uses system_ontology defaults as visual templates.
      const suggestion = await ontologyDefinitionService.suggest(
        stats as unknown as Record<string, unknown>,
      )
      const created = await ontologyDefinitionService.create({
        ...suggestion,
        name: `Suggested Ontology (${new Date().toLocaleDateString()})`,
      })
      setOntologies(prev => [created, ...prev])
      setSelectedOntologyId(created.id)
      setSearchParams({ tab: 'entities' })
      showToast('info', 'Draft created from graph — review types and publish when ready')
    } catch (err: unknown) {
      showToast('error', `Suggest failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSuggesting(false)
    }
  }

  async function handleClone(ontologyId: string) {
    try {
      const cloned = await ontologyDefinitionService.clone(ontologyId)
      setOntologies(prev => [cloned, ...prev])
      setSelectedOntologyId(cloned.id)
      showToast('success', 'Cloned — now editing a new draft')
    } catch (err: unknown) {
      showToast('error', `Clone failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleValidate(id: string) {
    try {
      const result = await ontologyDefinitionService.validate(id)
      setValidationResult(result)
      if (result.isValid) showToast('success', 'Ontology is valid')
    } catch (err: unknown) {
      showToast('error', `Validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handlePublish(id: string) {
    const o = ontologies.find(x => x.id === id)
    if (!o) return
    try {
      const impact = await ontologyDefinitionService.impact(id)
      const diffLines = [
        impact.addedEntityTypes.length > 0 ? `+ Adding: ${impact.addedEntityTypes.join(', ')}` : '',
        impact.removedEntityTypes.length > 0 ? `- Removing: ${impact.removedEntityTypes.join(', ')}` : '',
      ].filter(Boolean).join('\n')
      const msg = impact.allowed
        ? `Publish "${o.name}" v${o.version}? This is irreversible.\n\n${diffLines}`.trim()
        : `Blocked: ${impact.reason}\n\nPublish anyway?`
      if (!window.confirm(msg)) return
      await ontologyDefinitionService.publish(id)
      showToast('success', 'Published — active for all assigned data sources')
      invalidateSchema()
      setValidationResult(null)
      await loadOntologies()
    } catch (err: unknown) {
      showToast('error', `Publish failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editDetailsTarget, setEditDetailsTarget] = useState<OntologyDefinitionResponse | null>(null)

  async function handleSaveOntologyDetails(id: string, updates: { name: string; description: string; evolutionPolicy: string }) {
    try {
      const updated = await ontologyDefinitionService.update(id, {
        name: updates.name,
        description: updates.description || undefined,
        evolutionPolicy: updates.evolutionPolicy,
      })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      setEditDetailsTarget(null)
      showToast('success', 'Ontology details saved')
    } catch (err: unknown) {
      showToast('error', `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleCreateDraft(name: string, prePopulate: boolean) {
    setShowCreateDialog(false)
    if (prePopulate) {
      // Pre-populate from graph stats (same as suggest but with custom name)
      setIsSuggesting(true)
      try {
        const stats = await provider.getSchemaStats()
        const suggestion = await ontologyDefinitionService.suggest(
          stats as unknown as Record<string, unknown>,
        )
        const created = await ontologyDefinitionService.create({ ...suggestion, name })
        setOntologies(prev => [created, ...prev])
        setSelectedOntologyId(created.id)
        setSearchParams({ tab: 'entities' })
        showToast('success', `"${name}" created with ${Object.keys(created.entityTypeDefinitions ?? {}).length} entity types from your graph`)
      } catch (err: unknown) {
        showToast('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
      } finally {
        setIsSuggesting(false)
      }
    } else {
      // Empty draft
      try {
        const created = await ontologyDefinitionService.create({ name })
        setOntologies(prev => [created, ...prev])
        setSelectedOntologyId(created.id)
        showToast('success', 'New draft created')
      } catch (err: unknown) {
        showToast('error', `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    }
  }

  async function handleDeleteOntology(id: string) {
    const o = ontologies.find(x => x.id === id)
    if (!o) return
    if (o.isSystem || o.isPublished) {
      showToast('warning', 'Cannot delete system or published ontologies')
      return
    }
    const count = assignmentCountMap.get(id) ?? 0
    if (count > 0) {
      showToast('warning', `Cannot delete — assigned to ${count} data source(s)`)
      return
    }
    if (!window.confirm(`Delete "${o.name}"? This cannot be undone.`)) return
    try {
      await ontologyDefinitionService.delete(id)
      const remaining = ontologies.filter(x => x.id !== id)
      setOntologies(remaining)
      if (selectedOntologyId === id) {
        setSelectedOntologyId(remaining[0]?.id ?? null)
      }
      showToast('success', 'Ontology deleted')
    } catch (err: unknown) {
      showToast('error', `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  async function handleReparentEntityType(childId: string, newParentId: string | null) {
    // newParentId = null → make root (no parent)
    if (!selectedOntology || isLocked) return
    setIsSaving(true)
    try {
      const current = await ontologyDefinitionService.get(selectedOntology.id)
      const defs = { ...((current.entityTypeDefinitions as Record<string, Record<string, unknown>>) ?? {}) } as Record<string, Record<string, unknown>>

      const childDef = defs[childId]
      if (!childDef) return
      const childHierarchy = (childDef.hierarchy as Record<string, unknown>) ?? {}
      const oldParents: string[] = (childHierarchy.can_be_contained_by as string[]) ?? []

      // Remove child from all old parents' canContain
      for (const oldParentId of oldParents) {
        if (defs[oldParentId]) {
          const pDef = defs[oldParentId]
          const pH = (pDef.hierarchy as Record<string, unknown>) ?? {}
          const pCC: string[] = (pH.can_contain as string[]) ?? []
          defs[oldParentId] = { ...pDef, hierarchy: { ...pH, can_contain: pCC.filter(c => c !== childId) } }
        }
      }

      // Set new canBeContainedBy on the child
      defs[childId] = { ...childDef, hierarchy: { ...childHierarchy, can_be_contained_by: newParentId ? [newParentId] : [] } }

      // Add child to new parent's canContain
      if (newParentId && defs[newParentId]) {
        const pDef = defs[newParentId]
        const pH = (pDef.hierarchy as Record<string, unknown>) ?? {}
        const pCC: string[] = (pH.can_contain as string[]) ?? []
        if (!pCC.includes(childId)) {
          defs[newParentId] = { ...pDef, hierarchy: { ...pH, can_contain: [...pCC, childId] } }
        }
      }

      const updated = await ontologyDefinitionService.update(selectedOntology.id, {
        entityTypeDefinitions: defs as Record<string, unknown>,
      })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      invalidateSchema()
      showToast('success', newParentId ? `Moved under ${humanizeId(newParentId)}` : `"${humanizeId(childId)}" is now a root type`)
    } catch (err: unknown) {
      showToast('error', `Failed to update hierarchy: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleUpdateContainmentEdgeTypes(newList: string[]) {
    if (!selectedOntology || isLocked) return
    setIsSaving(true)
    try {
      const updated = await ontologyDefinitionService.update(selectedOntology.id, {
        containmentEdgeTypes: newList,
      })
      setOntologies(prev => prev.map(o => o.id === updated.id ? updated : o))
      showToast('success', 'Containment edge types updated')
    } catch (err: unknown) {
      showToast('error', `Failed to update: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }

  function handleSelectOntology(id: string) {
    setSelectedOntologyId(id)
    setEditorPanel(null)
    setValidationResult(null)
    setSearch('')
  }

  function handleViewTypes(id: string) {
    handleSelectOntology(id)
    setSearchParams({ tab: 'entities' })
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="p-8 max-w-7xl mx-auto flex flex-col h-full animate-in fade-in duration-500">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Ontology Management</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Define semantic ontologies for your graph data — entity types, relationship
          classifications, and containment hierarchies that drive the entire visualization pipeline.
        </p>
      </div>

      {/* Context Banner */}
      <ContextBanner
        workspace={activeWorkspace}
        dataSource={activeDataSource}
        ontologies={ontologies}
        selectedOntology={selectedOntology}
        graphStats={graphStats}
        isAssigning={isAssigning}
        onAssign={handleAssignOntology}
      />

      {/* Tabs (AdminRegistry-style border-b with underline) */}
      <div className="flex items-center gap-1 border-b border-glass-border mb-6 shrink-0">
        {tabDefs.map(t => {
          const Icon = t.icon
          const isActive = activeTab === t.id
          const disabled = t.needsSelection && !selectedOntology
          return (
            <button
              key={t.id}
              onClick={() => !disabled && setSearchParams({ tab: t.id })}
              disabled={disabled}
              className={cn(
                'flex items-center gap-2 px-6 py-3 text-sm font-semibold transition-all border-b-2',
                isActive
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : disabled
                  ? 'border-transparent text-ink-muted/50 cursor-not-allowed'
                  : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl'
              )}
              title={disabled ? 'Select an ontology from the Library tab first' : undefined}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className={cn(
                  'px-1.5 py-0.5 rounded-full text-[10px] font-medium',
                  isActive ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/10 dark:bg-white/10'
                )}>
                  {t.count}
                </span>
              )}
            </button>
          )
        })}

        {/* Selected ontology chip (right side — prominent) */}
        {selectedOntology && activeTab !== 'library' && (
          <div className="ml-auto flex items-center gap-2 pb-1">
            <div className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium',
              selectedOntology.isSystem
                ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300'
                : selectedOntology.isPublished
                ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
            )}>
              {isLocked
                ? <LucideIcons.Lock className="w-3 h-3" />
                : <LucideIcons.PenLine className="w-3 h-3" />}
              <span className="font-semibold">{selectedOntology.name}</span>
              <span className="opacity-60">v{selectedOntology.version}</span>
              <OntologyStatusBadge ontology={selectedOntology} size="xs" />
            </div>
            <button
              onClick={() => setSearchParams({ tab: 'library' })}
              className="text-[10px] text-ink-muted hover:text-ink underline"
            >
              Change
            </button>
          </div>
        )}
      </div>

      {/* Content pane */}
      <div className="flex-1 min-h-0 flex gap-0">
        <div className={cn('min-w-0 overflow-y-auto', editorPanel ? 'flex-[2]' : 'flex-1')}>
          {activeTab === 'library' && (
            <LibraryTab
              ontologies={ontologies}
              selectedOntologyId={selectedOntologyId}
              search={search}
              statusFilter={statusFilter}
              assignmentCountMap={assignmentCountMap}
              activeDataSource={activeDataSource}
              isLoading={isLoadingOntologies}
              isSuggesting={isSuggesting}
              onSearch={setSearch}
              onFilterChange={setStatusFilter}
              onSelect={handleSelectOntology}
              onViewTypes={handleViewTypes}
              onClone={handleClone}
              onValidate={handleValidate}
              onPublish={handlePublish}
              onDelete={handleDeleteOntology}
              onAssign={handleAssignOntology}
              onCreateDraft={() => setShowCreateDialog(true)}
              onSuggest={handleSuggestOntology}
              onEditDetails={o => setEditDetailsTarget(o)}
            />
          )}

          {activeTab === 'entities' && selectedOntology && (
            <EntitiesTab
              selectedOntology={selectedOntology}
              entityTypes={entityTypes}
              entityStatMap={entityStatMap}
              isLocked={isLocked}
              search={search}
              validationResult={validationResult}
              editorPanel={editorPanel}
              onSearch={setSearch}
              onEdit={et => setEditorPanel({ kind: 'entity', data: et })}
              onNew={() => setEditorPanel({ kind: 'entity' })}
              onDelete={handleDeleteEntityType}
              onClone={() => handleClone(selectedOntology.id)}
              onValidate={() => handleValidate(selectedOntology.id)}
              onPublish={() => handlePublish(selectedOntology.id)}
              onDismissValidation={() => setValidationResult(null)}
              onEditDetails={() => setEditDetailsTarget(selectedOntology)}
            />
          )}

          {activeTab === 'relationships' && selectedOntology && (
            <RelationshipsTab
              selectedOntology={selectedOntology}
              relTypes={relTypes}
              edgeStatMap={edgeStatMap}
              isLocked={isLocked}
              search={search}
              editorPanel={editorPanel}
              onSearch={setSearch}
              onEdit={rt => setEditorPanel({ kind: 'rel', data: rt })}
              onNew={() => setEditorPanel({ kind: 'rel' })}
              onDelete={handleDeleteRelType}
              onClone={() => handleClone(selectedOntology.id)}
              onValidate={() => handleValidate(selectedOntology.id)}
              onPublish={() => handlePublish(selectedOntology.id)}
              onEditDetails={() => setEditDetailsTarget(selectedOntology)}
            />
          )}

          {activeTab === 'hierarchy' && selectedOntology && (
            <HierarchyMapTab
              selectedOntology={selectedOntology}
              entityTypes={entityTypes}
              relTypes={relTypes}
              isLocked={isLocked}
              isSaving={isSaving}
              onReparent={handleReparentEntityType}
              onEditType={et => { setEditorPanel({ kind: 'entity', data: et }); setSearchParams({ tab: 'entities' }) }}
              onUpdateContainmentEdgeTypes={handleUpdateContainmentEdgeTypes}
              onClone={() => handleClone(selectedOntology.id)}
              onValidate={() => handleValidate(selectedOntology.id)}
              onPublish={() => handlePublish(selectedOntology.id)}
              onEditDetails={() => setEditDetailsTarget(selectedOntology)}
            />
          )}

          {activeTab === 'coverage' && selectedOntology && (
            <CoverageTab
              coverage={coverage}
              graphStats={graphStats}
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
              }}
            />
          )}

          {activeTab !== 'library' && !selectedOntology && (
            <div className="flex items-center justify-center py-20 text-ink-muted">
              <div className="text-center">
                <LucideIcons.BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No ontology selected</p>
                <p className="text-xs mt-1">
                  Go to the <button onClick={() => setSearchParams({ tab: 'library' })} className="text-indigo-500 hover:underline">Library tab</button> to select one
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Editor slide-in */}
        <AnimatePresence>
          {editorPanel && (
            <motion.div
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-[420px] flex-shrink-0 border-l border-glass-border overflow-hidden flex flex-col relative ml-2"
            >
              {isSaving && (
                <div className="absolute inset-0 bg-canvas/80 flex items-center justify-center z-10">
                  <LucideIcons.Loader2 className="w-5 h-5 animate-spin text-accent-lineage" />
                </div>
              )}
              {editorPanel.kind === 'entity' && (
                <EntityTypeEditor
                  entityType={editorPanel.data}
                  availableEntityTypes={entityTypes.map(et => ({ id: et.id, name: et.name }))}
                  onSave={handleSaveEntityType}
                  onCancel={() => setEditorPanel(null)}
                />
              )}
              {editorPanel.kind === 'rel' && (
                <RelationshipTypeEditor
                  relType={editorPanel.data}
                  availableEntityTypes={entityTypes.map(et => ({ id: et.id, name: et.name }))}
                  onSave={handleSaveRelType as (rt: RelationshipTypeSchema & { isContainment?: boolean; isLineage?: boolean; category?: string; direction?: string }) => void}
                  onCancel={() => setEditorPanel(null)}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Create Ontology Dialog */}
      {showCreateDialog && (
        <CreateOntologyDialog
          hasGraphContext={!!activeDataSource}
          onClose={() => setShowCreateDialog(false)}
          onCreate={handleCreateDraft}
        />
      )}

      {/* Edit Ontology Details Dialog */}
      {editDetailsTarget && (
        <EditOntologyDetailsDialog
          ontology={editDetailsTarget}
          onClose={() => setEditDetailsTarget(null)}
          onSave={(updates) => handleSaveOntologyDetails(editDetailsTarget.id, updates)}
        />
      )}

      {/* Toast */}
      <AnimatePresence>
        {toast && <ToastNotification key={toast.id} toast={toast} onDismiss={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Context Banner — workspace/data source + assigned ontology + graph stats
// ---------------------------------------------------------------------------

function ContextBanner({
  workspace,
  dataSource,
  ontologies,
  selectedOntology,
  graphStats,
  isAssigning,
  onAssign,
}: {
  workspace: WorkspaceResponse | null
  dataSource: DataSourceResponse | null
  ontologies: OntologyDefinitionResponse[]
  selectedOntology: OntologyDefinitionResponse | null
  graphStats: GraphSchemaStats | null
  isAssigning: boolean
  onAssign: (ontologyId: string | undefined) => void
}) {
  const [showPicker, setShowPicker] = useState(false)
  const assignedOntology = dataSource?.ontologyId
    ? ontologies.find(o => o.id === dataSource.ontologyId) ?? null
    : null

  const isViewingDifferent = selectedOntology && selectedOntology.id !== (assignedOntology?.id ?? null)

  if (!workspace) {
    return (
      <div className="mb-6 p-4 rounded-xl border border-glass-border bg-canvas-elevated/50">
        <div className="flex items-center gap-3 text-ink-muted">
          <LucideIcons.Info className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">
            No workspace active. Set up a workspace in the{' '}
            <a href="/admin/registry?tab=workspaces" className="text-indigo-500 hover:underline font-medium">Registry</a>
            {' '}to see data source context and assign ontologies.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn(
      'mb-6 rounded-xl border bg-canvas-elevated/50',
      isViewingDifferent
        ? 'border-amber-200 dark:border-amber-800/60'
        : 'border-glass-border'
    )}>
      {/* Main row */}
      <div className="flex items-center justify-between flex-wrap gap-3 p-4">
        <div className="flex items-center gap-5 flex-wrap">
          {/* Workspace → Data Source breadcrumb */}
          <div className="flex items-center gap-2 text-sm">
            <LucideIcons.Layers className="w-4 h-4 text-indigo-500 flex-shrink-0" />
            <span className="font-semibold text-ink">{workspace.name}</span>
            {dataSource && (
              <>
                <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted" />
                <LucideIcons.Database className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                <span className="text-ink-secondary">{dataSource.label || dataSource.id.slice(0, 8)}</span>
              </>
            )}
          </div>

          {/* Assigned ontology (what's live for this data source) */}
          <div className="flex items-center gap-2 text-sm border-l border-glass-border pl-5">
            <span className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold whitespace-nowrap">
              {dataSource ? 'Assigned' : 'Ontology'}
            </span>
            {assignedOntology ? (
              <span className="flex items-center gap-1.5">
                <LucideIcons.CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                <span className="font-semibold text-ink">{assignedOntology.name}</span>
                <span className="text-ink-muted text-xs">v{assignedOntology.version}</span>
                <OntologyStatusBadge ontology={assignedOntology} size="xs" />
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-ink-muted italic text-xs">
                <LucideIcons.Info className="w-3 h-3" />
                System defaults
              </span>
            )}
          </div>

          {/* Graph stats */}
          {graphStats && (
            <div className="flex items-center gap-3 text-[11px] text-ink-muted border-l border-glass-border pl-5">
              <span>{graphStats.entityTypeStats.length} types</span>
              <span className="opacity-30">|</span>
              <span>{formatCount(graphStats.totalNodes)} nodes</span>
              <span className="opacity-30">|</span>
              <span>{formatCount(graphStats.totalEdges)} edges</span>
            </div>
          )}
        </div>

        {/* Change ontology button */}
        {dataSource && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowPicker(!showPicker)}
              disabled={isAssigning}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-glass-border hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-ink-secondary hover:text-indigo-600 transition-colors"
            >
              {isAssigning
                ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                : <LucideIcons.ArrowRightLeft className="w-3 h-3" />}
              Change Assigned
            </button>

            {showPicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPicker(false)} />
                <div className="absolute right-0 top-full mt-2 w-80 bg-canvas-elevated border border-glass-border rounded-xl shadow-xl z-50 p-2 max-h-72 overflow-y-auto">
                  <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                    Assign to {dataSource.label || 'data source'}
                  </p>
                  <button
                    onClick={() => { onAssign(undefined); setShowPicker(false) }}
                    className={cn(
                      'w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                      !dataSource.ontologyId ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600' : 'text-ink-muted'
                    )}
                  >
                    None (system defaults)
                  </button>
                  {ontologies.map(o => (
                    <button
                      key={o.id}
                      onClick={() => { onAssign(o.id); setShowPicker(false) }}
                      className={cn(
                        'w-full text-left px-3 py-2.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                        o.id === dataSource.ontologyId ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm text-ink">{o.name}</span>
                        <OntologyStatusBadge ontology={o} size="xs" />
                      </div>
                      <div className="text-[11px] text-ink-muted mt-0.5">
                        v{o.version} · {Object.keys(o.entityTypeDefinitions ?? {}).length} entities · {Object.keys(o.relationshipTypeDefinitions ?? {}).length} rels
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* "Viewing different ontology" alert row */}
      {isViewingDifferent && selectedOntology && dataSource && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-amber-200 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 rounded-b-xl">
          <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
            <LucideIcons.Eye className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              You're browsing <span className="font-semibold">{selectedOntology.name}</span>
              {' '}(v{selectedOntology.version}
              {' '}<OntologyStatusBadge ontology={selectedOntology} size="xs" />)
              — this is <span className="font-semibold">not what's live</span> for this data source.
            </span>
          </div>
          <button
            onClick={() => onAssign(selectedOntology.id)}
            disabled={isAssigning}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {isAssigning
              ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
              : <LucideIcons.ArrowRightLeft className="w-3 h-3" />}
            Assign This
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Library Tab — browse, filter, create, manage ontologies
// ---------------------------------------------------------------------------

function LibraryTab({
  ontologies,
  selectedOntologyId,
  search,
  statusFilter,
  assignmentCountMap,
  activeDataSource,
  isLoading,
  isSuggesting,
  onSearch,
  onFilterChange,
  onSelect,
  onViewTypes,
  onClone,
  onValidate,
  onPublish,
  onDelete,
  onAssign,
  onCreateDraft,
  onSuggest,
  onEditDetails,
}: {
  ontologies: OntologyDefinitionResponse[]
  selectedOntologyId: string | null
  search: string
  statusFilter: StatusFilter
  assignmentCountMap: Map<string, number>
  activeDataSource: DataSourceResponse | null
  isLoading: boolean
  isSuggesting: boolean
  onSearch: (s: string) => void
  onFilterChange: (f: StatusFilter) => void
  onSelect: (id: string) => void
  onViewTypes: (id: string) => void
  onClone: (id: string) => void
  onValidate: (id: string) => void
  onPublish: (id: string) => void
  onDelete: (id: string) => void
  onAssign: (ontologyId: string | undefined) => void
  onCreateDraft: () => void
  onSuggest: () => void
  onEditDetails: (o: OntologyDefinitionResponse) => void
}) {
  const filters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'system', label: 'System' },
    { id: 'published', label: 'Published' },
    { id: 'draft', label: 'Drafts' },
  ]

  const filtered = useMemo(() => {
    let list = ontologies
    if (statusFilter === 'system') list = list.filter(o => o.isSystem)
    else if (statusFilter === 'published') list = list.filter(o => o.isPublished && !o.isSystem)
    else if (statusFilter === 'draft') list = list.filter(o => !o.isPublished && !o.isSystem)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(o => o.name.toLowerCase().includes(q))
    }
    return list
  }, [ontologies, statusFilter, search])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LucideIcons.Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
      </div>
    )
  }

  return (
    <div>
      {/* Action bar */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* Search */}
          <div className="relative w-64">
            <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
            <input
              type="text"
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search ontologies..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            />
          </div>

          {/* Status filter pills */}
          <div className="flex items-center gap-1">
            {filters.map(f => (
              <button
                key={f.id}
                onClick={() => onFilterChange(f.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  statusFilter === f.id
                    ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400'
                    : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onCreateDraft}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-glass-border hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-ink-secondary hover:text-indigo-600 transition-colors"
          >
            <LucideIcons.Plus className="w-3.5 h-3.5" />
            New Draft
          </button>
          <button
            onClick={onSuggest}
            disabled={isSuggesting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
          >
            {isSuggesting
              ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <LucideIcons.Sparkles className="w-3.5 h-3.5" />}
            Suggest from Graph
          </button>
        </div>
      </div>

      {/* Ontology grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-ink-muted">
          <LucideIcons.BookOpen className="w-10 h-10 mx-auto mb-3 opacity-25" />
          <p className="text-sm font-medium">{search || statusFilter !== 'all' ? 'No ontologies match your filters' : 'No ontologies yet'}</p>
          <p className="text-xs mt-1">Create a new draft or generate one from your graph data.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(o => {
            const entityCount = Object.keys(o.entityTypeDefinitions ?? {}).length
            const relCount = Object.keys(o.relationshipTypeDefinitions ?? {}).length
            const assignCount = assignmentCountMap.get(o.id) ?? 0
            const isSelected = o.id === selectedOntologyId
            const locked = o.isSystem || o.isPublished
            const isAssigned = activeDataSource?.ontologyId === o.id

            return (
              <div
                key={o.id}
                onClick={() => onSelect(o.id)}
                className={cn(
                  'rounded-xl border p-5 cursor-pointer transition-all group hover:shadow-md',
                  isSelected
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm'
                    : 'border-glass-border hover:border-glass-border-hover bg-canvas-elevated/50'
                )}
              >
                {/* Header row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {locked
                      ? <LucideIcons.Lock className="w-4 h-4 text-ink-muted flex-shrink-0" />
                      : <LucideIcons.PenLine className="w-4 h-4 text-amber-500 flex-shrink-0" />}
                    <h3 className="font-semibold text-ink truncate">{o.name}</h3>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-xs text-ink-muted">v{o.version}</span>
                    <OntologyStatusBadge ontology={o} />
                  </div>
                </div>

                {/* Description */}
                {o.description && (
                  <p className="text-xs text-ink-muted mb-3 line-clamp-2">{o.description}</p>
                )}

                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs text-ink-muted mb-3">
                  <span className="flex items-center gap-1">
                    <LucideIcons.Box className="w-3 h-3" />
                    {entityCount} {entityCount === 1 ? 'entity type' : 'entity types'}
                  </span>
                  <span className="flex items-center gap-1">
                    <LucideIcons.GitBranch className="w-3 h-3" />
                    {relCount} {relCount === 1 ? 'relationship' : 'relationships'}
                  </span>
                </div>

                {/* Metadata row */}
                <div className="flex items-center gap-4 text-[11px] text-ink-muted mb-4">
                  <span className="flex items-center gap-1">
                    <LucideIcons.Calendar className="w-3 h-3" />
                    {formatDate(o.createdAt)}
                  </span>
                  {assignCount > 0 && (
                    <span className="flex items-center gap-1 text-indigo-500">
                      <LucideIcons.Link className="w-3 h-3" />
                      {assignCount} data {assignCount === 1 ? 'source' : 'sources'}
                    </span>
                  )}
                  {isAssigned && (
                    <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-medium">
                      <LucideIcons.Check className="w-3 h-3" />
                      Active
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => onViewTypes(o.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20 transition-colors"
                  >
                    <LucideIcons.Eye className="w-3 h-3" />
                    View Types
                  </button>
                  {!o.isSystem && (
                    <button
                      onClick={() => onEditDetails(o)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      <LucideIcons.Settings className="w-3 h-3" />
                      Details
                    </button>
                  )}
                  <button
                    onClick={() => onClone(o.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <LucideIcons.Copy className="w-3 h-3" />
                    Clone
                  </button>
                  {!locked && (
                    <>
                      <button
                        onClick={() => onValidate(o.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <LucideIcons.CheckCircle className="w-3 h-3" />
                        Validate
                      </button>
                      <button
                        onClick={() => onPublish(o.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
                      >
                        <LucideIcons.Globe className="w-3 h-3" />
                        Publish
                      </button>
                    </>
                  )}
                  {activeDataSource && !isAssigned && (
                    <button
                      onClick={() => onAssign(o.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
                    >
                      <LucideIcons.ArrowRightLeft className="w-3 h-3" />
                      Assign
                    </button>
                  )}
                  {!locked && assignCount === 0 && (
                    <button
                      onClick={() => onDelete(o.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors ml-auto"
                    >
                      <LucideIcons.Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selected Ontology Action Bar (shared by Entities + Relationships tabs)
// ---------------------------------------------------------------------------

function OntologyActionBar({
  ontology,
  isLocked,
  validationResult,
  onClone,
  onValidate,
  onPublish,
  onDismissValidation,
  onEditDetails,
}: {
  ontology: OntologyDefinitionResponse
  isLocked: boolean
  validationResult?: { isValid: boolean; issues: Array<{ severity: string; message: string }> } | null
  onClone: () => void
  onValidate: () => void
  onPublish: () => void
  onDismissValidation?: () => void
  onEditDetails?: () => void
}) {
  // Assignment awareness — read from store directly, no prop drilling
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) ?? null
  const activeDataSource = activeWorkspace?.dataSources?.find(ds => ds.id === activeDataSourceId) ?? null
  const isAssignedToActive = activeDataSource?.ontologyId === ontology.id

  // Global usage — lazy loaded on expand
  const [showUsage, setShowUsage] = useState(false)
  const [assignments, setAssignments] = useState<Array<{ workspaceId: string; workspaceName: string; dataSourceId: string; dataSourceLabel: string }> | null>(null)
  const [loadingAssignments, setLoadingAssignments] = useState(false)

  async function loadAssignments() {
    if (assignments !== null) { setShowUsage(v => !v); return }
    setShowUsage(true)
    setLoadingAssignments(true)
    try {
      const data = await ontologyDefinitionService.getAssignments(ontology.id)
      setAssignments(data)
    } catch {
      setAssignments([])
    } finally {
      setLoadingAssignments(false)
    }
  }

  const accentClass = ontology.isSystem
    ? 'border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/10'
    : ontology.isPublished
    ? 'border-l-green-500 bg-green-50/30 dark:bg-green-950/10'
    : 'border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/10'

  return (
    <div className="mb-5">
      <div className={cn('rounded-xl border border-glass-border border-l-4 overflow-hidden', accentClass)}>
        {/* Main row */}
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="flex items-center gap-3 min-w-0">
            {isLocked
              ? <LucideIcons.Lock className="w-5 h-5 text-ink-muted flex-shrink-0" />
              : <LucideIcons.PenLine className="w-5 h-5 text-amber-500 flex-shrink-0" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-ink">{ontology.name}</h2>
                <span className="text-sm text-ink-muted">v{ontology.version}</span>
                <OntologyStatusBadge ontology={ontology} />

                {/* Assignment status badge */}
                {isAssignedToActive && activeDataSource ? (
                  <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">
                    <LucideIcons.CheckCircle2 className="w-3 h-3" />
                    Live · {activeDataSource.label || 'active data source'}
                  </span>
                ) : activeDataSource ? (
                  <span className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-ink-muted border border-glass-border">
                    <LucideIcons.CircleDashed className="w-3 h-3" />
                    Not assigned to current data source
                  </span>
                ) : null}
              </div>
              {ontology.description && (
                <p className="text-[11px] text-ink-muted mt-0.5 max-w-lg">{ontology.description}</p>
              )}
              {isLocked && !ontology.description && (
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {ontology.isSystem ? 'System ontology — read only. Clone to customize.' : 'Published — read only. Clone to create a new version.'}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!ontology.isSystem && onEditDetails && (
              <button onClick={onEditDetails} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <LucideIcons.Settings className="w-3 h-3" /> Details
              </button>
            )}
            {isLocked ? (
              <button onClick={onClone} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-glass-border hover:border-indigo-300 text-ink-secondary hover:text-indigo-600 transition-colors">
                <LucideIcons.Copy className="w-3 h-3" /> Clone to Edit
              </button>
            ) : (
              <>
                <button onClick={onValidate} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                  <LucideIcons.CheckCircle className="w-3 h-3" /> Validate
                </button>
                <button onClick={onPublish} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-500 text-white hover:bg-green-600 transition-colors">
                  <LucideIcons.Globe className="w-3 h-3" /> Publish
                </button>
              </>
            )}
          </div>
        </div>

        {/* Usage footer — shows how many data sources use this ontology */}
        <button
          onClick={loadAssignments}
          className="w-full flex items-center gap-2 px-4 py-2 border-t border-glass-border/50 text-[11px] text-ink-muted hover:bg-black/3 dark:hover:bg-white/3 transition-colors text-left"
        >
          <LucideIcons.Link className="w-3 h-3 flex-shrink-0" />
          <span>
            {assignments === null
              ? 'Show global usage...'
              : assignments.length === 0
              ? 'Not used by any data sources'
              : `Used by ${assignments.length} data source${assignments.length > 1 ? 's' : ''} across ${new Set(assignments.map(a => a.workspaceId)).size} workspace${new Set(assignments.map(a => a.workspaceId)).size > 1 ? 's' : ''}`
            }
          </span>
          {loadingAssignments
            ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin ml-auto" />
            : <LucideIcons.ChevronDown className={cn('w-3 h-3 ml-auto transition-transform', showUsage && 'rotate-180')} />
          }
        </button>

        {/* Expanded usage list */}
        {showUsage && assignments && assignments.length > 0 && (
          <div className="border-t border-glass-border/50 px-4 py-2 space-y-1 bg-black/2 dark:bg-white/2">
            {assignments.map(a => (
              <div key={a.dataSourceId} className="flex items-center gap-2 text-[11px] py-1">
                <LucideIcons.Layers className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                <span className="font-medium text-ink">{a.workspaceName}</span>
                <LucideIcons.ChevronRight className="w-2.5 h-2.5 text-ink-muted/40" />
                <LucideIcons.Database className="w-3 h-3 text-ink-muted flex-shrink-0" />
                <span className="text-ink-secondary">{a.dataSourceLabel}</span>
                {a.workspaceId === activeWorkspaceId && a.dataSourceId === activeDataSourceId && (
                  <span className="ml-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-300">
                    current
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inline validation */}
      {validationResult && (
        <div className={cn(
          'mt-3 p-3 rounded-xl text-xs',
          validationResult.isValid
            ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
            : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
        )}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5">
              {validationResult.isValid
                ? <LucideIcons.CheckCircle2 className="w-3.5 h-3.5" />
                : <LucideIcons.AlertCircle className="w-3.5 h-3.5" />}
              <span className="font-medium">
                {validationResult.isValid
                  ? 'Ontology is valid'
                  : `${validationResult.issues.filter(i => i.severity === 'error').length} error(s) found`}
              </span>
            </div>
            {onDismissValidation && (
              <button onClick={onDismissValidation} className="opacity-50 hover:opacity-100">
                <LucideIcons.X className="w-3 h-3" />
              </button>
            )}
          </div>
          {validationResult.issues.slice(0, 4).map((issue, i) => (
            <p key={i} className="opacity-80 leading-snug">
              {issue.severity === 'error' ? '  ' : '  '} {issue.message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Entities Tab
// ---------------------------------------------------------------------------

function EntitiesTab({
  selectedOntology,
  entityTypes,
  entityStatMap,
  isLocked,
  search,
  validationResult,
  editorPanel,
  onSearch,
  onEdit,
  onNew,
  onDelete,
  onClone,
  onValidate,
  onPublish,
  onDismissValidation,
  onEditDetails,
}: {
  selectedOntology: OntologyDefinitionResponse
  entityTypes: EntityTypeSchema[]
  entityStatMap: Map<string, EntityTypeSummary>
  isLocked: boolean
  search: string
  validationResult: { isValid: boolean; issues: Array<{ severity: string; message: string }> } | null
  editorPanel: EditorPanel
  onSearch: (s: string) => void
  onEdit: (et: EntityTypeSchema) => void
  onNew: () => void
  onDelete: (id: string, name: string) => void
  onClone: () => void
  onValidate: () => void
  onPublish: () => void
  onDismissValidation: () => void
  onEditDetails?: () => void
}) {
  const filtered = useMemo(() => {
    if (!search) return entityTypes
    const q = search.toLowerCase()
    return entityTypes.filter(et =>
      et.name.toLowerCase().includes(q) || et.id.toLowerCase().includes(q)
    )
  }, [entityTypes, search])

  return (
    <div>
      <OntologyActionBar
        ontology={selectedOntology}
        isLocked={isLocked}
        validationResult={validationResult}
        onClone={onClone}
        onValidate={onValidate}
        onPublish={onPublish}
        onDismissValidation={onDismissValidation}
        onEditDetails={onEditDetails}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="relative w-64">
          <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input
            type="text"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Filter entity types..."
            className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          />
        </div>
        {!isLocked && (
          <button
            onClick={onNew}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-dashed border-glass-border hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-ink-muted hover:text-indigo-600 transition-colors"
          >
            <LucideIcons.Plus className="w-3.5 h-3.5" />
            New Entity Type
          </button>
        )}
      </div>

      {/* Entity type list */}
      {filtered.length === 0 ? (
        <EmptyState
          icon="Box"
          message={search ? 'No entity types match your search' : 'No entity types defined yet.'}
          hint={!search && !isLocked ? 'Use "Suggest from Graph" in the Library tab to auto-generate, or add manually.' : undefined}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map(et => (
            <EntityTypeRow
              key={et.id}
              entityType={et}
              graphCount={entityStatMap.get(et.id.toLowerCase())?.count}
              isLocked={isLocked}
              isEditing={editorPanel?.kind === 'entity' && editorPanel.data?.id === et.id}
              onEdit={() => onEdit(et)}
              onDelete={() => onDelete(et.id, et.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Relationships Tab — grouped by classification
// ---------------------------------------------------------------------------

function RelationshipsTab({
  selectedOntology,
  relTypes,
  edgeStatMap,
  isLocked,
  search,
  editorPanel,
  onSearch,
  onEdit,
  onNew,
  onDelete,
  onClone,
  onValidate,
  onPublish,
  onEditDetails,
}: {
  selectedOntology: OntologyDefinitionResponse
  relTypes: RelTypeWithClassifications[]
  edgeStatMap: Map<string, EdgeTypeSummary>
  isLocked: boolean
  search: string
  editorPanel: EditorPanel
  onSearch: (s: string) => void
  onEdit: (rt: RelTypeWithClassifications) => void
  onNew: () => void
  onDelete: (id: string, name: string) => void
  onClone: () => void
  onValidate: () => void
  onPublish: () => void
  onEditDetails?: () => void
}) {
  const filtered = useMemo(() => {
    if (!search) return relTypes
    const q = search.toLowerCase()
    return relTypes.filter(rt =>
      rt.name.toLowerCase().includes(q) || rt.id.toLowerCase().includes(q)
    )
  }, [relTypes, search])

  // Group by classification
  const containment = filtered.filter(r => r.isContainment)
  const lineage = filtered.filter(r => r.isLineage)
  const other = filtered.filter(r => !r.isContainment && !r.isLineage)

  const groups: Array<{
    id: string
    label: string
    description: string
    items: RelTypeWithClassifications[]
    accent: string
    icon: React.ComponentType<{ className?: string }>
  }> = [
    {
      id: 'containment',
      label: 'Containment Hierarchy',
      description: 'Structural edges defining parent-child nesting (e.g., Domain contains Systems)',
      items: containment,
      accent: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800',
      icon: LucideIcons.FolderTree,
    },
    {
      id: 'lineage',
      label: 'Lineage & Data Flow',
      description: 'Edges tracing data movement and dependencies across the graph',
      items: lineage,
      accent: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800',
      icon: LucideIcons.Workflow,
    },
    {
      id: 'other',
      label: 'Other Relationships',
      description: 'Association, metadata, and reference edges',
      items: other,
      accent: 'text-ink-secondary bg-black/5 dark:bg-white/5 border-glass-border',
      icon: LucideIcons.GitBranch,
    },
  ]

  return (
    <div>
      <OntologyActionBar
        ontology={selectedOntology}
        isLocked={isLocked}
        onClone={onClone}
        onValidate={onValidate}
        onPublish={onPublish}
        onEditDetails={onEditDetails}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="relative w-64">
          <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input
            type="text"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Filter relationships..."
            className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          />
        </div>
        {!isLocked && (
          <button
            onClick={onNew}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-dashed border-glass-border hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-ink-muted hover:text-indigo-600 transition-colors"
          >
            <LucideIcons.Plus className="w-3.5 h-3.5" />
            New Relationship Type
          </button>
        )}
      </div>

      {/* Grouped relationship sections */}
      {filtered.length === 0 ? (
        <EmptyState
          icon="GitBranch"
          message={search ? 'No relationships match your search' : 'No relationship types defined yet.'}
        />
      ) : (
        <div className="space-y-6">
          {groups.map(group => {
            if (group.items.length === 0) return null
            const Icon = group.icon
            return (
              <div key={group.id}>
                {/* Section header */}
                <div className={cn('flex items-center gap-3 px-4 py-2.5 rounded-xl border mb-3', group.accent)}>
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <div>
                    <h3 className="text-sm font-semibold">{group.label}</h3>
                    <p className="text-[11px] opacity-75">{group.description}</p>
                  </div>
                  <span className="ml-auto text-xs font-medium opacity-60">{group.items.length}</span>
                </div>

                {/* Relationship rows */}
                <div className="space-y-2 pl-2">
                  {group.items.map(rt => (
                    <RelTypeRow
                      key={rt.id}
                      relType={rt}
                      graphCount={edgeStatMap.get(rt.id.toUpperCase())?.count}
                      graphSourceTargets={edgeStatMap.get(rt.id.toUpperCase())}
                      isLocked={isLocked}
                      isEditing={editorPanel?.kind === 'rel' && editorPanel.data?.id === rt.id}
                      onEdit={() => onEdit(rt)}
                      onDelete={() => onDelete(rt.id, rt.name)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Coverage Tab — gap analysis
// ---------------------------------------------------------------------------

function CoverageTab({
  coverage,
  graphStats,
  isLocked,
  onDefineEntity,
  onDefineRel,
}: {
  coverage: CoverageState | null
  graphStats: GraphSchemaStats | null
  isLocked: boolean
  onDefineEntity: (typeId: string) => void
  onDefineRel: (typeId: string) => void
}) {
  if (!graphStats) {
    return (
      <div className="text-center py-16 text-ink-muted">
        <LucideIcons.Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin opacity-50" />
        <p className="text-sm">Loading graph data...</p>
      </div>
    )
  }

  const uncoveredEntities = coverage?.uncoveredEntityTypes ?? []
  const uncoveredRels = coverage?.uncoveredRelationshipTypes ?? []
  const percent = coverage?.coveragePercent ?? null
  const totalGaps = uncoveredEntities.length + uncoveredRels.length

  return (
    <div>
      {/* Coverage summary */}
      {percent !== null && (
        <div className={cn(
          'p-5 rounded-xl border mb-6',
          totalGaps === 0
            ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
        )}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {totalGaps === 0
                ? <LucideIcons.CheckCircle2 className="w-5 h-5 text-green-500" />
                : <LucideIcons.AlertTriangle className="w-5 h-5 text-amber-500" />}
              <div>
                <h3 className={cn('font-semibold', totalGaps === 0 ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300')}>
                  {totalGaps === 0 ? 'Full Coverage' : `${totalGaps} Undefined Type${totalGaps > 1 ? 's' : ''}`}
                </h3>
                <p className={cn('text-xs', totalGaps === 0 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')}>
                  {totalGaps === 0
                    ? 'Every entity and relationship type in your graph is covered by this ontology.'
                    : `Types below exist in your graph but are not defined in this ontology.${!isLocked ? ' Click "Define" to add them.' : ''}`}
                </p>
              </div>
            </div>
            <span className={cn(
              'text-2xl font-bold',
              totalGaps === 0 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
            )}>
              {Math.round(percent)}%
            </span>
          </div>
          <div className="w-full bg-black/10 dark:bg-white/10 rounded-full h-2">
            <div
              className={cn(
                'h-2 rounded-full transition-all',
                totalGaps === 0 ? 'bg-green-500' : 'bg-amber-500'
              )}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Uncovered entity types */}
      {uncoveredEntities.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <LucideIcons.Box className="w-3.5 h-3.5" />
            Undefined Entity Types ({uncoveredEntities.length})
          </h3>
          <div className="space-y-2">
            {uncoveredEntities.map(typeId => {
              const stat = graphStats.entityTypeStats.find(s => s.id === typeId)
              return (
                <div
                  key={typeId}
                  className="flex items-center justify-between p-3.5 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <div>
                      <code className="text-sm font-mono font-medium text-amber-700 dark:text-amber-300">{typeId}</code>
                      {stat && (
                        <p className="text-[11px] text-amber-600/70 dark:text-amber-400/70 mt-0.5">
                          {formatCount(stat.count)} nodes in graph
                          {stat.sampleNames?.length > 0 && ` (e.g., ${stat.sampleNames.slice(0, 2).join(', ')})`}
                        </p>
                      )}
                    </div>
                  </div>
                  {!isLocked && (
                    <button
                      onClick={() => onDefineEntity(typeId)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/30 transition-colors flex-shrink-0 ml-3"
                    >
                      <LucideIcons.Plus className="w-3 h-3" />
                      Define
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Uncovered relationship types */}
      {uncoveredRels.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
            <LucideIcons.GitBranch className="w-3.5 h-3.5" />
            Undefined Relationship Types ({uncoveredRels.length})
          </h3>
          <div className="space-y-2">
            {uncoveredRels.map(typeId => {
              const stat = graphStats.edgeTypeStats.find(s => s.id === typeId)
              return (
                <div
                  key={typeId}
                  className="flex items-center justify-between p-3.5 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <div>
                      <code className="text-sm font-mono font-medium text-amber-700 dark:text-amber-300">{typeId}</code>
                      {stat && (
                        <p className="text-[11px] text-amber-600/70 dark:text-amber-400/70 mt-0.5">
                          {formatCount(stat.count)} edges
                          {stat.sourceTypes?.length > 0 && ` · ${stat.sourceTypes.join(', ')} → ${stat.targetTypes?.join(', ')}`}
                        </p>
                      )}
                    </div>
                  </div>
                  {!isLocked && (
                    <button
                      onClick={() => onDefineRel(typeId)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/30 transition-colors flex-shrink-0 ml-3"
                    >
                      <LucideIcons.Plus className="w-3 h-3" />
                      Define
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Entity Type Row
// ---------------------------------------------------------------------------

function EntityTypeRow({
  entityType: et,
  graphCount,
  isLocked,
  isEditing,
  onEdit,
  onDelete,
}: {
  entityType: EntityTypeSchema
  graphCount?: number
  isLocked: boolean
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <button
      onClick={onEdit}
      className={cn(
        'w-full text-left p-4 rounded-xl border transition-all group',
        isEditing
          ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20'
          : 'border-glass-border hover:border-glass-border-hover hover:bg-black/3 dark:hover:bg-white/3'
      )}
    >
      <div className="flex items-center gap-3">
        {/* Color swatch + icon initial */}
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${et.visual.color}20` }}
        >
          <span className="text-sm font-bold" style={{ color: et.visual.color }}>
            {et.name.charAt(0).toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-sm text-ink truncate">{et.name}</span>
            <code className="text-[10px] text-ink-muted font-mono">{et.id}</code>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-medium">
              L{et.hierarchy.level}
            </span>
            {et.hierarchy.canContain.length > 0 && (
              <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded font-medium">
                container
              </span>
            )}
            {et.behavior.traceable && (
              <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded font-medium">
                traceable
              </span>
            )}
            {graphCount !== undefined && (
              <span className="text-[10px] text-ink-muted ml-1">
                {graphCount === 0 ? 'not in graph' : `${formatCount(graphCount)} nodes`}
              </span>
            )}
          </div>
        </div>

        {/* Hover actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {!isLocked && (
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-950/30 text-ink-muted hover:text-red-500 transition-colors"
              title="Delete"
            >
              <LucideIcons.Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted" />
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Relationship Type Row
// ---------------------------------------------------------------------------

function RelTypeRow({
  relType: rt,
  graphCount,
  graphSourceTargets,
  isLocked,
  isEditing,
  onEdit,
  onDelete,
}: {
  relType: RelTypeWithClassifications
  graphCount?: number
  graphSourceTargets?: EdgeTypeSummary
  isLocked: boolean
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <button
      onClick={onEdit}
      className={cn(
        'w-full text-left p-4 rounded-xl border transition-all group',
        isEditing
          ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20'
          : 'border-glass-border hover:border-glass-border-hover hover:bg-black/3 dark:hover:bg-white/3'
      )}
    >
      <div className="flex items-center gap-3">
        {/* SVG edge preview */}
        <div className="w-12 flex-shrink-0">
          <svg viewBox="0 0 48 16" className="w-full h-4">
            <line
              x1="4" y1="8" x2="40" y2="8"
              stroke={rt.visual.strokeColor}
              strokeWidth={Math.min(rt.visual.strokeWidth, 2.5)}
              strokeDasharray={
                rt.visual.strokeStyle === 'dashed' ? '5,3' :
                rt.visual.strokeStyle === 'dotted' ? '2,3' : undefined
              }
            />
            <polygon points="40,5 48,8 40,11" fill={rt.visual.strokeColor} />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-sm text-ink truncate">{rt.name}</span>
            <code className="text-[10px] text-ink-muted font-mono">{rt.id.toUpperCase()}</code>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {rt.isContainment && (
              <span className="text-[10px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 px-1.5 py-0.5 rounded font-medium">
                containment
              </span>
            )}
            {rt.isLineage && (
              <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded font-medium">
                lineage
              </span>
            )}
            {rt.visual.animated && (
              <span className="text-[10px] text-blue-500 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 rounded font-medium">
                animated
              </span>
            )}
            {graphCount !== undefined && (
              <span className="text-[10px] text-ink-muted ml-1">
                {graphCount === 0 ? 'not in graph' : `${formatCount(graphCount)} edges`}
              </span>
            )}
            {graphSourceTargets && graphSourceTargets.sourceTypes.length > 0 && (
              <span className="text-[10px] text-ink-muted ml-1">
                {graphSourceTargets.sourceTypes.slice(0, 2).join(', ')} → {graphSourceTargets.targetTypes.slice(0, 2).join(', ')}
              </span>
            )}
          </div>
        </div>

        {/* Hover actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {!isLocked && (
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-950/30 text-ink-muted hover:text-red-500 transition-colors"
              title="Delete"
            >
              <LucideIcons.Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted" />
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Shared UI components
// ---------------------------------------------------------------------------

function OntologyStatusBadge({
  ontology,
  size = 'sm',
}: {
  ontology: OntologyDefinitionResponse
  size?: 'xs' | 'sm'
}) {
  const base = size === 'xs' ? 'text-[9px] px-1.5 py-0' : 'text-[10px] px-2 py-0.5'
  if (ontology.isSystem) {
    return (
      <span className={cn('rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 font-semibold', base)}>
        system
      </span>
    )
  }
  if (ontology.isPublished) {
    return (
      <span className={cn('rounded-full bg-green-100 dark:bg-green-950/50 text-green-600 dark:text-green-400 font-semibold', base)}>
        published
      </span>
    )
  }
  return (
    <span className={cn('rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 font-semibold', base)}>
      draft
    </span>
  )
}

function EmptyState({ icon, message, hint }: { icon: string; message: string; hint?: string }) {
  const Icon = (LucideIcons as Record<string, unknown>)[icon] as React.ComponentType<{ className?: string }> | undefined
  return (
    <div className="text-center py-16 text-ink-muted">
      {Icon && <Icon className="w-10 h-10 mx-auto mb-3 opacity-20" />}
      <p className="text-sm font-medium">{message}</p>
      {hint && <p className="text-xs mt-1.5 max-w-xs mx-auto opacity-70">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create Ontology Dialog — name + starting point (empty vs pre-populated)
// ---------------------------------------------------------------------------

function CreateOntologyDialog({
  hasGraphContext,
  onClose,
  onCreate,
}: {
  hasGraphContext: boolean
  onClose: () => void
  onCreate: (name: string, prePopulate: boolean) => void
}) {
  const [name, setName] = useState('New Ontology')
  const [mode, setMode] = useState<'empty' | 'graph'>(hasGraphContext ? 'graph' : 'empty')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-ink">Create New Ontology</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted">
            <LucideIcons.X className="w-4 h-4" />
          </button>
        </div>

        {/* Name input */}
        <div className="mb-5">
          <label className="block text-sm font-medium text-ink mb-1.5">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Ontology"
            autoFocus
            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          />
        </div>

        {/* Starting point selection */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-ink mb-2">Starting Point</label>
          <div className="space-y-2">
            <button
              onClick={() => setMode('empty')}
              className={cn(
                'w-full text-left p-3.5 rounded-xl border-2 transition-all',
                mode === 'empty'
                  ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20'
                  : 'border-glass-border hover:border-glass-border-hover'
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center',
                  mode === 'empty' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                )}>
                  <LucideIcons.FileEdit className={cn('w-4 h-4', mode === 'empty' ? 'text-indigo-500' : 'text-ink-muted')} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">Empty Draft</p>
                  <p className="text-xs text-ink-muted">Start from scratch — manually add entity and relationship types</p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setMode('graph')}
              disabled={!hasGraphContext}
              className={cn(
                'w-full text-left p-3.5 rounded-xl border-2 transition-all',
                !hasGraphContext && 'opacity-50 cursor-not-allowed',
                mode === 'graph'
                  ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20'
                  : 'border-glass-border hover:border-glass-border-hover'
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center',
                  mode === 'graph' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                )}>
                  <LucideIcons.Sparkles className={cn('w-4 h-4', mode === 'graph' ? 'text-indigo-500' : 'text-ink-muted')} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">From Graph Data</p>
                  <p className="text-xs text-ink-muted">
                    {hasGraphContext
                      ? 'Pre-populate with entity and relationship types discovered in your active data source'
                      : 'No active data source — select a workspace first'}
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={() => onCreate(name.trim() || 'New Ontology', mode === 'graph')}
            disabled={!name.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50"
          >
            {mode === 'graph' && <LucideIcons.Sparkles className="w-3.5 h-3.5" />}
            {mode === 'graph' ? 'Create & Populate' : 'Create Draft'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Ontology Details Dialog — rename, describe, set evolution policy
// ---------------------------------------------------------------------------

function EditOntologyDetailsDialog({
  ontology,
  onClose,
  onSave,
}: {
  ontology: OntologyDefinitionResponse
  onClose: () => void
  onSave: (updates: { name: string; description: string; evolutionPolicy: string }) => void
}) {
  const [name, setName] = useState(ontology.name)
  const [description, setDescription] = useState(ontology.description ?? '')
  const [evolutionPolicy, setEvolutionPolicy] = useState(ontology.evolutionPolicy ?? 'reject')
  const [isSaving, setIsSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) return
    setIsSaving(true)
    await onSave({ name: name.trim(), description, evolutionPolicy })
    setIsSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-bold text-ink">Edit Ontology Details</h3>
            <p className="text-xs text-ink-muted mt-0.5">v{ontology.version} · <OntologyStatusBadge ontology={ontology} size="xs" /></p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted">
            <LucideIcons.X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
              placeholder="Ontology name..."
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none"
              placeholder="Describe the purpose and scope of this ontology..."
            />
          </div>

          {/* Evolution Policy — only show for drafts; published ontologies can't change policy without clone */}
          {!ontology.isPublished && (
          <div>
            <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Evolution Policy</label>
            <p className="text-[11px] text-ink-muted mb-2">Controls what happens when this ontology is published with breaking changes.</p>
            <div className="space-y-1.5">
              {[
                { value: 'reject', label: 'Reject', hint: 'Block publishing if existing data would break (safest)' },
                { value: 'deprecate', label: 'Deprecate', hint: 'Mark removed types as deprecated; continue serving them' },
                { value: 'migrate', label: 'Migrate', hint: 'Auto-remap types according to a migration manifest' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setEvolutionPolicy(opt.value)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-xl border-2 transition-all',
                    evolutionPolicy === opt.value
                      ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20'
                      : 'border-glass-border hover:border-glass-border-hover'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                      evolutionPolicy === opt.value ? 'border-indigo-500 bg-indigo-500' : 'border-ink-muted'
                    )}>
                      {evolutionPolicy === opt.value && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <span className="text-sm font-semibold text-ink">{opt.label}</span>
                  </div>
                  <p className="text-[11px] text-ink-muted ml-6 mt-0.5">{opt.hint}</p>
                </button>
              ))}
            </div>
          </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || isSaving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50"
          >
            {isSaving ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LucideIcons.Check className="w-3.5 h-3.5" />}
            Save Details
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hierarchy Map Tab — visual containment tree, root detection, orphan alerts
// ---------------------------------------------------------------------------

interface HierarchyNode {
  id: string
  entityType: EntityTypeSchema
  children: HierarchyNode[]
}

function buildHierarchyTree(entityTypes: EntityTypeSchema[]): {
  roots: HierarchyNode[]
  orphans: EntityTypeSchema[]
} {
  const byId = new Map(entityTypes.map(et => [et.id, et]))
  const visited = new Set<string>()

  function buildNode(id: string): HierarchyNode | null {
    if (visited.has(id) || !byId.has(id)) return null
    visited.add(id)
    const et = byId.get(id)!
    const children: HierarchyNode[] = []
    for (const childId of et.hierarchy.canContain) {
      const child = buildNode(childId)
      if (child) children.push(child)
    }
    return { id, entityType: et, children }
  }

  const roots: HierarchyNode[] = []
  for (const et of entityTypes) {
    if (et.hierarchy.canBeContainedBy.length === 0) {
      const node = buildNode(et.id)
      if (node) roots.push(node)
    }
  }
  // Second pass: pick up any canContain-referenced types not yet visited (they have parents set but parent wasn't yet processed)
  for (const et of entityTypes) {
    if (!visited.has(et.id)) {
      // Has parents set but parents not in this ontology or circular — treat as orphan
    }
  }

  const orphans = entityTypes.filter(et => !visited.has(et.id))
  return { roots, orphans }
}

function computeNodeLevels(roots: HierarchyNode[]): Map<string, number> {
  const map = new Map<string, number>()
  function traverse(node: HierarchyNode, level: number) {
    map.set(node.id, level)
    for (const child of node.children) traverse(child, level + 1)
  }
  for (const root of roots) traverse(root, 0)
  return map
}

function HierarchyMapTab({
  selectedOntology,
  entityTypes,
  relTypes,
  isLocked,
  isSaving,
  onReparent,
  onEditType,
  onUpdateContainmentEdgeTypes,
  onClone,
  onValidate,
  onPublish,
  onEditDetails,
}: {
  selectedOntology: OntologyDefinitionResponse
  entityTypes: EntityTypeSchema[]
  relTypes: RelTypeWithClassifications[]
  isLocked: boolean
  isSaving: boolean
  onReparent: (childId: string, newParentId: string | null) => void
  onEditType: (et: EntityTypeSchema) => void
  onUpdateContainmentEdgeTypes: (newList: string[]) => void
  onClone: () => void
  onValidate: () => void
  onPublish: () => void
  onEditDetails?: () => void
}) {
  const { roots, orphans } = useMemo(() => buildHierarchyTree(entityTypes), [entityTypes])
  const computedLevelMap = useMemo(() => computeNodeLevels(roots), [roots])
  const containmentRels = useMemo(() => relTypes.filter(r => r.isContainment), [relTypes])
  const containmentEdgeTypes: string[] = selectedOntology.containmentEdgeTypes ?? []

  return (
    <div>
      <OntologyActionBar
        ontology={selectedOntology}
        isLocked={isLocked}
        onClone={onClone}
        onValidate={onValidate}
        onPublish={onPublish}
        onEditDetails={onEditDetails}
      />

      {/* Saving overlay indicator */}
      {isSaving && (
        <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 mb-4">
          <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
          Updating hierarchy...
        </div>
      )}

      {/* Containment Edge Types chip section */}
      <div className="mb-6 p-4 rounded-xl border border-glass-border bg-canvas-elevated/30">
        <div className="flex items-center gap-2 mb-2">
          <LucideIcons.ArrowRightLeft className="w-4 h-4 text-indigo-500" />
          <h3 className="text-sm font-semibold text-ink">Containment Edge Types</h3>
        </div>
        <p className="text-[11px] text-ink-muted mb-3">
          Relationship types that define parent→child nesting in the canvas hierarchy. Changes apply immediately to all views using this ontology.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          {containmentEdgeTypes.map(relId => (
            <span
              key={relId}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 text-xs font-mono font-medium text-indigo-700 dark:text-indigo-300"
            >
              {relId}
              {!isLocked && (
                <button
                  onClick={() => onUpdateContainmentEdgeTypes(containmentEdgeTypes.filter(t => t !== relId))}
                  className="opacity-50 hover:opacity-100 transition-opacity"
                  title={`Remove ${relId}`}
                >
                  <LucideIcons.X className="w-2.5 h-2.5" />
                </button>
              )}
            </span>
          ))}
          {/* Add chips for containment rels not already in the list */}
          {containmentRels
            .filter(r => !containmentEdgeTypes.includes(r.id.toUpperCase()))
            .map(r => (
              <button
                key={r.id}
                disabled={isLocked}
                onClick={() => onUpdateContainmentEdgeTypes([...containmentEdgeTypes, r.id.toUpperCase()])}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-glass-border text-xs font-mono text-ink-muted hover:border-indigo-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <LucideIcons.Plus className="w-3 h-3" />
                {r.id.toUpperCase()}
              </button>
            ))}
          {containmentEdgeTypes.length === 0 && containmentRels.length === 0 && (
            <p className="text-xs text-ink-muted italic">
              No containment relationships defined yet — go to the Relationships tab and mark a type as "Containment".
            </p>
          )}
        </div>
      </div>

      {entityTypes.length === 0 ? (
        <EmptyState
          icon="FolderTree"
          message="No entity types defined yet"
          hint="Add entity types in the Entity Types tab, then arrange their containment hierarchy here."
        />
      ) : (
        <div className="space-y-8">
          {/* Containment Tree */}
          {roots.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3 flex items-center gap-2">
                <LucideIcons.FolderTree className="w-3.5 h-3.5" />
                Containment Tree
                <span className="text-[10px] font-normal text-ink-muted/60">
                  ({roots.length} root{roots.length > 1 ? 's' : ''}, {entityTypes.length - orphans.length} placed)
                </span>
              </h3>
              <div className="rounded-xl border border-glass-border overflow-hidden">
                {roots.map(root => (
                  <HierarchyTreeNode
                    key={root.id}
                    node={root}
                    allEntityTypes={entityTypes}
                    computedLevelMap={computedLevelMap}
                    isLocked={isLocked}
                    onReparent={onReparent}
                    onEditType={onEditType}
                    depth={0}
                  />
                ))}
              </div>

              {/* Level legend */}
              <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-muted">
                <LucideIcons.Crown className="w-3 h-3 text-amber-500" />
                <span>Root (L0)</span>
                <span className="opacity-40">·</span>
                <span className="bg-amber-50 dark:bg-amber-950/30 text-amber-600 px-1.5 py-0.5 rounded">L*</span>
                <span>= stored level differs from computed tree depth</span>
              </div>
            </div>
          )}

          {/* Unplaced / Orphan Types */}
          {orphans.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                <LucideIcons.AlertTriangle className="w-3.5 h-3.5" />
                Unplaced Types ({orphans.length})
              </h3>
              <p className="text-[11px] text-ink-muted mb-3">
                These types are not in any containment hierarchy. They'll appear as floating nodes in canvas views.
                {!isLocked && ' Make them roots or nest them under a parent type.'}
              </p>
              <div className="space-y-2">
                {orphans.map(et => (
                  <OrphanTypeRow
                    key={et.id}
                    entityType={et}
                    allEntityTypes={entityTypes}
                    isLocked={isLocked}
                    onMakeRoot={() => onReparent(et.id, null)}
                    onNestUnder={(parentId) => onReparent(et.id, parentId)}
                    onEdit={() => onEditType(et)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HierarchyTreeNode({
  node,
  allEntityTypes,
  computedLevelMap,
  isLocked,
  onReparent,
  onEditType,
  depth,
}: {
  node: HierarchyNode
  allEntityTypes: EntityTypeSchema[]
  computedLevelMap: Map<string, number>
  isLocked: boolean
  onReparent: (childId: string, newParentId: string | null) => void
  onEditType: (et: EntityTypeSchema) => void
  depth: number
}) {
  const [showNestPicker, setShowNestPicker] = useState(false)
  const computedLevel = computedLevelMap.get(node.id) ?? depth
  const storedLevel = node.entityType.hierarchy.level
  const levelMismatch = computedLevel !== storedLevel

  const potentialParents = allEntityTypes.filter(p => p.id !== node.id)
  const isRoot = depth === 0

  return (
    <div className={cn('border-b border-glass-border/50 last:border-b-0')}>
      {/* Row */}
      <div
        className="flex items-center gap-2 group py-2.5 px-3 hover:bg-black/3 dark:hover:bg-white/3 transition-colors"
        style={{ paddingLeft: `${depth * 22 + 12}px` }}
      >
        {/* Tree connector */}
        {depth > 0 && <LucideIcons.CornerDownRight className="w-3 h-3 text-ink-muted/30 flex-shrink-0" />}

        {/* Root crown */}
        {isRoot
          ? <span title="Root type"><LucideIcons.Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /></span>
          : <LucideIcons.Minus className="w-3 h-3 text-ink-muted/20 flex-shrink-0" />
        }

        {/* Color dot */}
        <div
          className="w-3 h-3 rounded-sm flex-shrink-0"
          style={{ backgroundColor: node.entityType.visual.color }}
        />

        {/* Name + ID */}
        <span className="text-sm font-medium text-ink">{node.entityType.name}</span>
        <code className="text-[10px] text-ink-muted/70 font-mono hidden sm:block">{node.entityType.id}</code>

        {/* Level badge — amber if stored level disagrees with computed level */}
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium ml-1',
            levelMismatch
              ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400'
              : 'bg-black/5 dark:bg-white/5 text-ink-muted'
          )}
          title={levelMismatch ? `Stored as L${storedLevel} but computed depth is L${computedLevel}. Edit the type to fix.` : undefined}
        >
          L{computedLevel}{levelMismatch && '*'}
        </span>

        {/* Children count pill */}
        {node.children.length > 0 && (
          <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
            {node.children.length} child{node.children.length > 1 ? 'ren' : ''}
          </span>
        )}

        {/* Hover actions */}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEditType(node.entityType)}
            className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
            title="Edit this type"
          >
            <LucideIcons.Pencil className="w-3 h-3" />
          </button>

          {!isLocked && !isRoot && (
            <button
              onClick={() => onReparent(node.id, null)}
              className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-950/30 text-ink-muted hover:text-amber-600 transition-colors"
              title="Make root type"
            >
              <LucideIcons.Crown className="w-3 h-3" />
            </button>
          )}

          {!isLocked && (
            <div className="relative">
              <button
                onClick={() => setShowNestPicker(v => !v)}
                className="p-1 rounded hover:bg-indigo-100 dark:hover:bg-indigo-950/30 text-ink-muted hover:text-indigo-600 transition-colors"
                title="Move under a different parent"
              >
                <LucideIcons.CornerDownRight className="w-3 h-3" />
              </button>
              {showNestPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowNestPicker(false)} />
                  <div className="absolute right-0 top-full mt-1 w-52 bg-canvas-elevated border border-glass-border rounded-xl shadow-xl z-50 p-1 max-h-52 overflow-y-auto">
                    <p className="px-3 py-1 text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Move under...</p>
                    {!isRoot && (
                      <button
                        onClick={() => { onReparent(node.id, null); setShowNestPicker(false) }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-black/5 dark:hover:bg-white/5 text-amber-600 dark:text-amber-400"
                      >
                        <div className="flex items-center gap-2">
                          <LucideIcons.Crown className="w-3 h-3" />
                          Make root type
                        </div>
                      </button>
                    )}
                    {potentialParents.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { onReparent(node.id, p.id); setShowNestPicker(false) }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: p.visual.color }} />
                          <span className="font-medium text-ink">{p.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Children */}
      {node.children.map(child => (
        <HierarchyTreeNode
          key={child.id}
          node={child}
          allEntityTypes={allEntityTypes}
          computedLevelMap={computedLevelMap}
          isLocked={isLocked}
          onReparent={onReparent}
          onEditType={onEditType}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}

function OrphanTypeRow({
  entityType: et,
  allEntityTypes,
  isLocked,
  onMakeRoot,
  onNestUnder,
  onEdit,
}: {
  entityType: EntityTypeSchema
  allEntityTypes: EntityTypeSchema[]
  isLocked: boolean
  onMakeRoot: () => void
  onNestUnder: (parentId: string) => void
  onEdit: () => void
}) {
  const [showPicker, setShowPicker] = useState(false)
  const potentialParents = allEntityTypes.filter(p => p.id !== et.id)

  return (
    <div className="flex items-center justify-between p-3.5 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/30 dark:bg-amber-950/10">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${et.visual.color}20` }}
        >
          <span className="text-xs font-bold" style={{ color: et.visual.color }}>
            {et.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{et.name}</span>
            <code className="text-[10px] text-ink-muted font-mono">{et.id}</code>
          </div>
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
            Not placed in containment hierarchy
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
        <button
          onClick={onEdit}
          className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted transition-colors"
          title="Edit type"
        >
          <LucideIcons.Pencil className="w-3.5 h-3.5" />
        </button>

        {!isLocked && (
          <>
            <button
              onClick={onMakeRoot}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/30 transition-colors"
            >
              <LucideIcons.Crown className="w-3 h-3" />
              Make root
            </button>

            <div className="relative">
              <button
                onClick={() => setShowPicker(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors"
              >
                <LucideIcons.CornerDownRight className="w-3 h-3" />
                Nest under...
              </button>
              {showPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowPicker(false)} />
                  <div className="absolute right-0 top-full mt-1 w-52 bg-canvas-elevated border border-glass-border rounded-xl shadow-xl z-50 p-1 max-h-52 overflow-y-auto">
                    <p className="px-3 py-1 text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Choose parent</p>
                    {potentialParents.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { onNestUnder(p.id); setShowPicker(false) }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: p.visual.color }} />
                          <span className="font-medium text-ink">{p.name}</span>
                          {p.hierarchy.canBeContainedBy.length === 0 && (
                            <LucideIcons.Crown className="w-2.5 h-2.5 text-amber-400" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast Notification
// ---------------------------------------------------------------------------

function ToastNotification({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4500)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const styles: Record<ToastType, string> = {
    success: 'bg-green-50 dark:bg-green-950/90 text-green-800 dark:text-green-200 border-green-200 dark:border-green-800',
    error: 'bg-red-50 dark:bg-red-950/90 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800',
    warning: 'bg-amber-50 dark:bg-amber-950/90 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800',
    info: 'bg-blue-50 dark:bg-blue-950/90 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-800',
  }

  const icons: Record<ToastType, keyof typeof LucideIcons> = {
    success: 'CheckCircle2',
    error: 'AlertCircle',
    warning: 'AlertTriangle',
    info: 'Info',
  }

  const Icon = LucideIcons[icons[toast.type]] as React.ComponentType<{ className?: string }>

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.95 }}
      transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      className={cn(
        'fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm max-w-sm',
        styles[toast.type]
      )}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">{toast.message}</span>
      <button onClick={onDismiss} className="opacity-50 hover:opacity-100 transition-opacity flex-shrink-0">
        <LucideIcons.X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  )
}
