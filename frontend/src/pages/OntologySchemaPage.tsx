/**
 * OntologySchemaPage — Schema Editor for entity and relationship type definitions.
 *
 * Features:
 * - List all ontologies with their status
 * - Edit entity types (wired to EntityTypeEditor → save via API)
 * - Edit relationship types with classification toggles (isContainment / isLineage)
 * - Uncategorized Types section: types discovered in the graph but not yet defined
 * - "Suggest Ontology" flow using the backend /suggest endpoint
 * - Clone system ontology → create workspace-scoped customisation
 * - Validate ontology (SHACL-lite check)
 */
import { useState, useEffect, useCallback } from 'react'
import * as LucideIcons from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSchemaStore } from '@/store/schema'
import { EntityTypeEditor } from '@/components/schema/EntityTypeEditor'
import { RelationshipTypeEditor } from '@/components/schema/RelationshipTypeEditor'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useInvalidateGraphSchema } from '@/hooks/useGraphSchema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { cn } from '@/lib/utils'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

type Tab = 'entity-types' | 'relationship-types' | 'ontologies' | 'uncategorized'
type Panel = 'entity-editor' | 'rel-editor' | null

export function OntologySchemaPage() {
  const { schema } = useSchemaStore()
  const invalidateSchema = useInvalidateGraphSchema()
  const provider = useGraphProvider()

  const [tab, setTab] = useState<Tab>('entity-types')
  const [panel, setPanel] = useState<Panel>(null)
  const [editingEntityType, setEditingEntityType] = useState<EntityTypeSchema | undefined>()
  const [editingRelType, setEditingRelType] = useState<RelationshipTypeSchema | undefined>()
  const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])
  const [isLoadingOntologies, setIsLoadingOntologies] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [validationResult, setValidationResult] = useState<{ isValid: boolean; issues: Array<{ severity: string; message: string }> } | null>(null)
  const [search, setSearch] = useState('')
  const [uncategorizedEntityTypes, setUncategorizedEntityTypes] = useState<string[]>([])
  const [uncategorizedRelTypes, setUncategorizedRelTypes] = useState<string[]>([])

  const loadOntologies = useCallback(() => {
    setIsLoadingOntologies(true)
    return ontologyDefinitionService.list()
      .then(setOntologies)
      .catch(console.error)
      .finally(() => setIsLoadingOntologies(false))
  }, [])

  // Load ontology list + graph coverage
  useEffect(() => {
    loadOntologies()
  }, [loadOntologies])

  // Check coverage when we have both an ontology and schema
  useEffect(() => {
    if (!ontologies.length || !schema) return

    const activeOntology = ontologies.find(o => o.isPublished || o.isSystem)
    if (!activeOntology) return

    provider.getSchemaStats().then(stats => {
      return ontologyDefinitionService.coverage(activeOntology.id, stats as unknown as Record<string, unknown>)
    }).then(coverage => {
      setUncategorizedEntityTypes(coverage.uncoveredEntityTypes)
      setUncategorizedRelTypes(coverage.uncoveredRelationshipTypes)
    }).catch(() => {
      // Coverage check is best-effort, ignore errors
    })
  }, [ontologies, schema, provider])

  const entityTypes = schema?.entityTypes ?? []
  const relTypes = schema?.relationshipTypes ?? []
  const containmentTypes = new Set((schema?.containmentEdgeTypes ?? []).map(t => t.toUpperCase()))

  // Filter by search
  const filteredEntityTypes = entityTypes.filter((et) =>
    et.name.toLowerCase().includes(search.toLowerCase()) ||
    et.id.toLowerCase().includes(search.toLowerCase())
  )
  const filteredRelTypes = relTypes.filter((rt) =>
    rt.name.toLowerCase().includes(search.toLowerCase()) ||
    rt.id.toLowerCase().includes(search.toLowerCase())
  )

  const systemOntology = ontologies.find((o) => o.isSystem)
  const editableOntology = ontologies.find((o) => !o.isSystem && !o.isPublished)

  async function handleSaveEntityType(entityType: EntityTypeSchema) {
    if (!editableOntology && !systemOntology) return

    setIsSaving(true)
    try {
      const targetId = editableOntology?.id ?? systemOntology!.id
      const current = await ontologyDefinitionService.get(targetId)
      const updatedDefs = {
        ...((current.entityTypeDefinitions as Record<string, unknown>) ?? {}),
        [entityType.id]: {
          name: entityType.name,
          plural_name: entityType.pluralName,
          description: entityType.description,
          visual: {
            icon: entityType.visual.icon,
            color: entityType.visual.color,
            shape: entityType.visual.shape,
            size: entityType.visual.size,
            border_style: entityType.visual.borderStyle,
            show_in_minimap: entityType.visual.showInMinimap,
          },
          hierarchy: {
            level: entityType.hierarchy.level,
            can_contain: entityType.hierarchy.canContain,
            can_be_contained_by: entityType.hierarchy.canBeContainedBy,
            default_expanded: entityType.hierarchy.defaultExpanded,
            roll_up_fields: entityType.hierarchy.rollUpFields ?? [],
          },
          behavior: {
            selectable: entityType.behavior.selectable,
            draggable: entityType.behavior.draggable,
            expandable: entityType.behavior.expandable,
            traceable: entityType.behavior.traceable,
            click_action: entityType.behavior.clickAction,
            double_click_action: entityType.behavior.doubleClickAction,
          },
          fields: entityType.fields,
        },
      }
      await ontologyDefinitionService.update(targetId, {
        entityTypeDefinitions: updatedDefs,
      })
      // Invalidate React Query cache → triggers schema re-fetch from backend
      invalidateSchema()
      setPanel(null)
      setEditingEntityType(undefined)
    } catch (err) {
      console.error('Failed to save entity type:', err)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveRelType(relType: RelationshipTypeSchema & { isContainment?: boolean; isLineage?: boolean }) {
    if (!editableOntology && !systemOntology) return

    setIsSaving(true)
    try {
      const targetId = editableOntology?.id ?? systemOntology!.id
      const current = await ontologyDefinitionService.get(targetId)
      const updatedDefs = {
        ...((current.relationshipTypeDefinitions as Record<string, unknown>) ?? {}),
        [relType.id.toUpperCase()]: {
          name: relType.name,
          description: relType.description,
          is_containment: relType.isContainment ?? false,
          is_lineage: relType.isLineage ?? false,
          visual: {
            stroke_color: relType.visual.strokeColor,
            stroke_width: relType.visual.strokeWidth,
            stroke_style: relType.visual.strokeStyle,
            animated: relType.visual.animated,
            animation_speed: relType.visual.animationSpeed,
            arrow_type: relType.visual.arrowType,
            curve_type: relType.visual.curveType,
          },
          source_types: relType.sourceTypes,
          target_types: relType.targetTypes,
          bidirectional: relType.bidirectional,
          show_label: relType.showLabel,
        },
      }
      await ontologyDefinitionService.update(targetId, {
        relationshipTypeDefinitions: updatedDefs,
      })
      invalidateSchema()
      setPanel(null)
      setEditingRelType(undefined)
    } catch (err) {
      console.error('Failed to save relationship type:', err)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSuggestOntology() {
    setIsSuggesting(true)
    try {
      const stats = await provider.getSchemaStats()
      const baseOntology = ontologies.find(o => o.isSystem)
      const suggestion = await ontologyDefinitionService.suggest(
        stats as unknown as Record<string, unknown>,
        baseOntology?.id
      )
      // Create a draft ontology from the suggestion
      const created = await ontologyDefinitionService.create({
        ...suggestion,
        name: `Suggested Ontology (${new Date().toLocaleDateString()})`,
      })
      setOntologies(prev => [created, ...prev])
      setTab('ontologies')
    } catch (err) {
      console.error('Failed to suggest ontology:', err)
    } finally {
      setIsSuggesting(false)
    }
  }

  async function handleCloneSystemOntology() {
    if (!systemOntology) return
    try {
      const cloned = await ontologyDefinitionService.clone(systemOntology.id)
      setOntologies((prev) => [cloned, ...prev])
    } catch (err) {
      console.error('Failed to clone ontology:', err)
    }
  }

  async function handleValidate(id: string) {
    try {
      const result = await ontologyDefinitionService.validate(id)
      setValidationResult(result)
    } catch (err) {
      console.error('Failed to validate ontology:', err)
    }
  }

  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      {/* Left panel — type list */}
      <div className={cn(
        "flex flex-col border-r border-glass-border transition-all duration-300",
        panel ? "w-[420px]" : "w-full"
      )}>
        {/* Header */}
        <div className="p-6 border-b border-glass-border">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-display font-bold text-ink">Schema Editor</h1>
              <p className="text-sm text-ink-muted">Manage entity and relationship type definitions</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSuggestOntology}
                disabled={isSuggesting}
                className="btn btn-ghost btn-sm flex items-center gap-1.5"
                title="Auto-suggest an ontology based on your graph's current entity and relationship types"
              >
                {isSuggesting
                  ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <LucideIcons.Sparkles className="w-3.5 h-3.5" />
                }
                Suggest
              </button>
              {systemOntology && !editableOntology && (
                <button
                  onClick={handleCloneSystemOntology}
                  className="btn btn-ghost btn-sm flex items-center gap-1.5"
                  title="Clone system ontology to create a custom workspace ontology"
                >
                  <LucideIcons.Copy className="w-3.5 h-3.5" />
                  Clone
                </button>
              )}
              {editableOntology && (
                <button
                  onClick={() => handleValidate(editableOntology.id)}
                  className="btn btn-ghost btn-sm flex items-center gap-1.5"
                >
                  <LucideIcons.CheckCircle className="w-3.5 h-3.5" />
                  Validate
                </button>
              )}
              <button
                onClick={() => {
                  setEditingEntityType(undefined)
                  setPanel('entity-editor')
                }}
                className="btn btn-primary btn-sm flex items-center gap-1.5"
              >
                <LucideIcons.Plus className="w-3.5 h-3.5" />
                New Type
              </button>
            </div>
          </div>

          {/* Validation result */}
          {validationResult && (
            <div className={cn(
              "p-3 rounded-lg text-sm mb-4",
              validationResult.isValid
                ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300"
                : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"
            )}>
              <div className="flex items-center gap-2 mb-1">
                {validationResult.isValid
                  ? <LucideIcons.CheckCircle2 className="w-4 h-4" />
                  : <LucideIcons.AlertCircle className="w-4 h-4" />
                }
                <span className="font-medium">
                  {validationResult.isValid ? 'Ontology is valid' : `${validationResult.issues.filter(i => i.severity === 'error').length} error(s) found`}
                </span>
                <button onClick={() => setValidationResult(null)} className="ml-auto opacity-50 hover:opacity-100">
                  <LucideIcons.X className="w-3 h-3" />
                </button>
              </div>
              {validationResult.issues.slice(0, 3).map((issue, i) => (
                <p key={i} className="text-xs opacity-80">• {issue.message}</p>
              ))}
            </div>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-1 mb-3">
            {([
              { id: 'entity-types', label: 'Entity Types', count: entityTypes.length },
              { id: 'relationship-types', label: 'Relationships', count: relTypes.length },
              { id: 'ontologies', label: 'Ontologies', count: ontologies.length },
              {
                id: 'uncategorized',
                label: 'Uncategorized',
                count: uncategorizedEntityTypes.length + uncategorizedRelTypes.length,
                alert: uncategorizedEntityTypes.length + uncategorizedRelTypes.length > 0,
              },
            ] as { id: Tab; label: string; count: number; alert?: boolean }[]).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  tab === t.id
                    ? "bg-accent-lineage/10 text-accent-lineage"
                    : t.alert
                    ? "text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                    : "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                )}
              >
                {t.label}
                {t.count > 0 && (
                  <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded-full",
                    tab === t.id
                      ? "bg-accent-lineage/20"
                      : t.alert
                      ? "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                      : "bg-black/10 dark:bg-white/10"
                  )}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Search */}
          {tab !== 'ontologies' && (
            <div className="relative">
              <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search types..."
                className="input w-full pl-9"
              />
            </div>
          )}
        </div>

        {/* Type list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {tab === 'entity-types' && (
            <>
              {filteredEntityTypes.length === 0 && !search && (
                <div className="text-center py-12 text-ink-muted">
                  <LucideIcons.Box className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No entity types defined yet.</p>
                  <p className="text-sm">Click "New Type" to create one.</p>
                </div>
              )}
              {filteredEntityTypes.map((et) => (
                <EntityTypeRow
                  key={et.id}
                  entityType={et}
                  onEdit={() => {
                    setEditingEntityType(et)
                    setPanel('entity-editor')
                  }}
                />
              ))}
            </>
          )}

          {tab === 'relationship-types' && (
            <>
              {filteredRelTypes.length === 0 && !search && (
                <div className="text-center py-12 text-ink-muted">
                  <LucideIcons.GitBranch className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No relationship types defined yet.</p>
                </div>
              )}
              {filteredRelTypes.map((rt) => (
                <RelTypeRow
                  key={rt.id}
                  relType={rt}
                  isContainment={containmentTypes.has(rt.id.toUpperCase())}
                  onEdit={() => {
                    setEditingRelType(rt)
                    setPanel('rel-editor')
                  }}
                />
              ))}
            </>
          )}

          {tab === 'ontologies' && (
            <OntologyList
              ontologies={ontologies}
              isLoading={isLoadingOntologies}
              onRefresh={loadOntologies}
            />
          )}

          {tab === 'uncategorized' && (
            <UncategorizedTypesList
              entityTypes={uncategorizedEntityTypes}
              relTypes={uncategorizedRelTypes}
              onDefineEntity={() => {
                setEditingEntityType(undefined)
                setPanel('entity-editor')
              }}
              onDefineRel={() => {
                setEditingRelType(undefined)
                setPanel('rel-editor')
              }}
            />
          )}
        </div>
      </div>

      {/* Right panel — editor */}
      <AnimatePresence>
        {panel && (
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="flex-1 border-l border-glass-border overflow-hidden flex flex-col relative"
          >
            {isSaving && (
              <div className="absolute inset-0 bg-canvas/80 flex items-center justify-center z-10">
                <LucideIcons.Loader2 className="w-6 h-6 animate-spin text-accent-lineage" />
              </div>
            )}
            {panel === 'entity-editor' && (
              <EntityTypeEditor
                entityType={editingEntityType}
                onSave={handleSaveEntityType}
                onCancel={() => {
                  setPanel(null)
                  setEditingEntityType(undefined)
                }}
              />
            )}
            {panel === 'rel-editor' && (
              <RelationshipTypeEditor
                relType={editingRelType as any}
                availableEntityTypes={entityTypes.map((et) => ({ id: et.id, name: et.name }))}
                onSave={handleSaveRelType as any}
                onCancel={() => {
                  setPanel(null)
                  setEditingRelType(undefined)
                }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function EntityTypeRow({
  entityType,
  onEdit,
}: {
  entityType: EntityTypeSchema
  onEdit: () => void
}) {
  return (
    <button
      onClick={onEdit}
      className="w-full text-left p-3 rounded-xl border border-glass-border hover:border-glass-border-hover hover:bg-black/5 dark:hover:bg-white/5 transition-all group"
    >
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${entityType.visual.color}20` }}
        >
          <span className="text-xs font-bold" style={{ color: entityType.visual.color }}>
            {entityType.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{entityType.name}</span>
            <code className="text-xs text-ink-muted font-mono truncate">{entityType.id}</code>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-ink-muted">{entityType.visual.size} · {entityType.visual.shape}</span>
            {entityType.hierarchy.canContain.length > 0 && (
              <span className="text-xs text-indigo-500">container</span>
            )}
          </div>
        </div>
        <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
      </div>
    </button>
  )
}

function RelTypeRow({
  relType,
  isContainment,
  onEdit,
}: {
  relType: RelationshipTypeSchema
  isContainment: boolean
  onEdit: () => void
}) {
  return (
    <button
      onClick={onEdit}
      className="w-full text-left p-3 rounded-xl border border-glass-border hover:border-glass-border-hover hover:bg-black/5 dark:hover:bg-white/5 transition-all group"
    >
      <div className="flex items-center gap-3">
        {/* Edge preview */}
        <div className="w-14 flex-shrink-0">
          <svg viewBox="0 0 56 16" className="w-full h-4">
            <line
              x1="4" y1="8" x2="48" y2="8"
              stroke={relType.visual.strokeColor}
              strokeWidth={Math.min(relType.visual.strokeWidth, 3)}
              strokeDasharray={
                relType.visual.strokeStyle === 'dashed' ? '6,3' :
                relType.visual.strokeStyle === 'dotted' ? '2,3' : undefined
              }
            />
            <polygon
              points="48,5 56,8 48,11"
              fill={relType.visual.strokeColor}
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{relType.name}</span>
            <code className="text-xs text-ink-muted font-mono">{relType.id.toUpperCase()}</code>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {isContainment && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
                containment
              </span>
            )}
            {relType.visual.animated && (
              <span className="text-xs text-ink-muted">animated</span>
            )}
          </div>
        </div>
        <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
      </div>
    </button>
  )
}

function UncategorizedTypesList({
  entityTypes,
  relTypes,
  onDefineEntity,
  onDefineRel,
}: {
  entityTypes: string[]
  relTypes: string[]
  onDefineEntity: () => void
  onDefineRel: () => void
}) {
  if (entityTypes.length === 0 && relTypes.length === 0) {
    return (
      <div className="text-center py-12 text-ink-muted">
        <LucideIcons.CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-500 opacity-70" />
        <p className="font-medium">All types are defined</p>
        <p className="text-sm">Every entity and relationship type in your graph is covered by the ontology.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-300">
        <p className="font-medium mb-1">Types discovered in your graph but not defined in the ontology</p>
        <p className="text-xs opacity-80">
          Define these types to unlock custom visuals, classifications, and hierarchy for them.
          You can also use "Suggest" to auto-generate definitions for your entire graph.
        </p>
      </div>

      {entityTypes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider px-1 mb-2">
            Entity Types ({entityTypes.length})
          </p>
          <div className="space-y-1.5">
            {entityTypes.map((typeId) => (
              <div key={typeId} className="flex items-center justify-between p-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20">
                <div className="flex items-center gap-2">
                  <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <code className="text-sm font-mono text-amber-700 dark:text-amber-300">{typeId}</code>
                </div>
                <button
                  onClick={() => onDefineEntity()}
                  className="btn btn-ghost btn-sm text-xs"
                >
                  Define
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {relTypes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider px-1 mb-2">
            Relationship Types ({relTypes.length})
          </p>
          <div className="space-y-1.5">
            {relTypes.map((typeId) => (
              <div key={typeId} className="flex items-center justify-between p-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20">
                <div className="flex items-center gap-2">
                  <LucideIcons.AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <code className="text-sm font-mono text-amber-700 dark:text-amber-300">{typeId}</code>
                </div>
                <button
                  onClick={() => onDefineRel()}
                  className="btn btn-ghost btn-sm text-xs"
                >
                  Define
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function OntologyList({
  ontologies,
  isLoading,
  onRefresh,
}: {
  ontologies: OntologyDefinitionResponse[]
  isLoading: boolean
  onRefresh: () => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LucideIcons.Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {ontologies.length === 0 && (
        <div className="text-center py-12 text-ink-muted">
          <LucideIcons.BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No ontologies found.</p>
          <button onClick={onRefresh} className="btn btn-ghost btn-sm mt-3">Refresh</button>
        </div>
      )}
      {ontologies.map((o) => (
        <div key={o.id} className="p-3 rounded-xl border border-glass-border">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{o.name}</span>
                <span className="text-xs text-ink-muted">v{o.version}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                {o.isSystem && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
                    system
                  </span>
                )}
                {o.isPublished && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-950/50 text-green-600 dark:text-green-400">
                    published
                  </span>
                )}
                {!o.isPublished && !o.isSystem && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400">
                    draft
                  </span>
                )}
                <span className="text-xs text-ink-muted">{o.scope}</span>
              </div>
              <div className="text-xs text-ink-muted mt-1">
                {Object.keys(o.entityTypeDefinitions ?? {}).length} entity types ·{' '}
                {Object.keys(o.relationshipTypeDefinitions ?? {}).length} relationship types
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
