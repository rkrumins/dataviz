/**
 * SchemaPanel — unified view combining Entity Types, Relationships, and Hierarchy.
 *
 * Uses a pill-toggle sub-navigation to switch between the three views,
 * consolidating what were previously separate top-level tabs.
 */
import { useState } from 'react'
import { Box, GitBranch, FolderTree } from 'lucide-react'
import { cn } from '@/lib/utils'

import type { EntityTypeSchema } from '@/types/schema'
import type { EntityTypeSummary, EdgeTypeSummary } from '@/providers/GraphDataProvider'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { EditorPanel, RelTypeWithClassifications } from '../../lib/ontology-types'

import { EntityTypesPanel } from './EntityTypesPanel'
import { RelationshipsPanel } from './RelationshipsPanel'
import { HierarchyPanel } from './HierarchyPanel'

type SchemaSubView = 'entities' | 'relationships' | 'hierarchy'

const SUB_VIEWS: Array<{
  id: SchemaSubView
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: 'entities', label: 'Entities', icon: Box },
  { id: 'relationships', label: 'Relationships', icon: GitBranch },
  { id: 'hierarchy', label: 'Hierarchy', icon: FolderTree },
]

interface SchemaPanelProps {
  // Shared
  selectedOntology: OntologyDefinitionResponse
  entityTypes: EntityTypeSchema[]
  relTypes: RelTypeWithClassifications[]
  isLocked: boolean
  search: string
  editorPanel: EditorPanel
  onSearch: (q: string) => void

  // Entity Types
  entityStatMap: Map<string, EntityTypeSummary>
  changedEntityIds: Set<string>
  validationResult: { isValid: boolean; issues: Array<{ severity: string; message: string }> } | null
  onEditEntity: (et: EntityTypeSchema) => void
  onNewEntity: () => void
  onDeleteEntity: (id: string, name: string) => void
  onDismissValidation: () => void

  // Relationships
  edgeStatMap: Map<string, EdgeTypeSummary>
  changedRelIds: Set<string>
  onEditRel: (rt: RelTypeWithClassifications) => void
  onNewRel: () => void
  onDeleteRel: (id: string, name: string) => void

  // Hierarchy
  isSaving: boolean
  onReparent: (childId: string, newParentId: string | null) => void
  onEditTypeFromHierarchy: (et: EntityTypeSchema) => void
  onUpdateContainmentEdgeTypes: (newList: string[]) => void

  // Change indicators
  hasEntityChanges: boolean
  hasRelChanges: boolean
  hasHierarchyChanges: boolean

  // Initial sub-view (for URL migration from old tab names)
  initialSubView?: SchemaSubView
}

export function SchemaPanel({
  selectedOntology,
  entityTypes,
  relTypes,
  isLocked,
  search,
  editorPanel,
  onSearch,
  entityStatMap,
  changedEntityIds,
  validationResult,
  onEditEntity,
  onNewEntity,
  onDeleteEntity,
  onDismissValidation,
  edgeStatMap,
  changedRelIds,
  onEditRel,
  onNewRel,
  onDeleteRel,
  isSaving,
  onReparent,
  onEditTypeFromHierarchy,
  onUpdateContainmentEdgeTypes,
  hasEntityChanges,
  hasRelChanges,
  hasHierarchyChanges,
  initialSubView,
}: SchemaPanelProps) {
  const [subView, setSubView] = useState<SchemaSubView>(initialSubView || 'entities')

  const changeIndicators: Record<SchemaSubView, boolean> = {
    entities: hasEntityChanges,
    relationships: hasRelChanges,
    hierarchy: hasHierarchyChanges,
  }

  return (
    <div>
      {/* Sub-view pill toggle */}
      <div className="flex items-center gap-1 mb-6 p-1 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] w-fit">
        {SUB_VIEWS.map(sv => {
          const Icon = sv.icon
          const isActive = subView === sv.id
          const hasChanges = changeIndicators[sv.id]
          return (
            <button
              key={sv.id}
              onClick={() => setSubView(sv.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all relative',
                isActive
                  ? 'bg-canvas-elevated shadow-sm text-ink border border-glass-border'
                  : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {sv.label}
              {hasChanges && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              )}
            </button>
          )
        })}
      </div>

      {/* Sub-view content */}
      {subView === 'entities' && (
        <EntityTypesPanel
          entityTypes={entityTypes}
          entityStatMap={entityStatMap}
          isLocked={isLocked}
          search={search}
          validationResult={validationResult}
          editorPanel={editorPanel}
          changedIds={changedEntityIds}
          onSearch={onSearch}
          onEdit={onEditEntity}
          onNew={onNewEntity}
          onDelete={onDeleteEntity}
          onDismissValidation={onDismissValidation}
        />
      )}

      {subView === 'relationships' && (
        <RelationshipsPanel
          relTypes={relTypes}
          edgeStatMap={edgeStatMap}
          isLocked={isLocked}
          search={search}
          editorPanel={editorPanel}
          changedIds={changedRelIds}
          onSearch={onSearch}
          onEdit={onEditRel}
          onNew={onNewRel}
          onDelete={onDeleteRel}
        />
      )}

      {subView === 'hierarchy' && (
        <HierarchyPanel
          selectedOntology={selectedOntology}
          entityTypes={entityTypes}
          relTypes={relTypes}
          isLocked={isLocked}
          isSaving={isSaving}
          onReparent={onReparent}
          onEditType={onEditTypeFromHierarchy}
          onUpdateContainmentEdgeTypes={onUpdateContainmentEdgeTypes}
        />
      )}
    </div>
  )
}
