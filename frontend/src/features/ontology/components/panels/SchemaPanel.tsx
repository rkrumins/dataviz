/**
 * SchemaPanel — unified view combining Entity Types and Relationships.
 *
 * Uses a pill-toggle sub-navigation to switch between the two views.
 * Hierarchy has been promoted to its own top-level tab.
 */
import { useState } from 'react'
import { Box, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'

import type { EntityTypeSchema } from '@/types/schema'
import type { EntityTypeSummary, EdgeTypeSummary } from '@/providers/GraphDataProvider'
import type { EditorPanel, RelTypeWithClassifications } from '../../lib/ontology-types'

import { EntityTypesPanel } from './EntityTypesPanel'
import { RelationshipsPanel } from './RelationshipsPanel'
import { EducationalCallout } from '../EducationalCallout'
import { DeclaredVsPhysical } from '../DeclaredVsPhysical'

type SchemaSubView = 'entities' | 'relationships'

const SUB_VIEWS: Array<{
  id: SchemaSubView
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: 'entities', label: 'Entities', icon: Box },
  { id: 'relationships', label: 'Relationships', icon: GitBranch },
]

interface SchemaPanelProps {
  // Shared
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

  // Change indicators
  hasEntityChanges: boolean
  hasRelChanges: boolean

  // Initial sub-view (for URL migration from old tab names)
  initialSubView?: SchemaSubView
}

export function SchemaPanel({
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
  hasEntityChanges,
  hasRelChanges,
  initialSubView,
}: SchemaPanelProps) {
  const [subView, setSubView] = useState<SchemaSubView>(initialSubView || 'entities')

  const changeIndicators: Record<SchemaSubView, boolean> = {
    entities: hasEntityChanges,
    relationships: hasRelChanges,
  }

  return (
    <div>
      <EducationalCallout
        id="edu-schema-declared-physical"
        title="Your schema is the declared model — this is what the graph is built from"
        variant="concept"
      >
        <div className="space-y-2.5">
          <p className="text-xs text-ink-muted leading-relaxed">
            <span className="font-medium text-ink-secondary">Entity types</span> are the categories of nodes;{' '}
            <span className="font-medium text-ink-secondary">relationship types</span> are the edges between them. Together they are
            the single source of truth — every graph built or read with this ontology uses <span className="italic">exactly</span> these
            types, in this spelling.
          </p>
          <DeclaredVsPhysical
            entityExample={entityTypes[0]?.id || 'Customer'}
            edgeExample={relTypes[0]?.id || 'FLOWS_TO'}
          />
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Name a relationship <span className="italic">"Flows To"</span> and it's stored as the edge type{' '}
            <code className="font-mono text-ink-secondary">FLOWS_TO</code> — the editor derives that automatically (entities become{' '}
            <span className="font-mono text-ink-secondary">PascalCase</span> node labels the same way), so the physical graph always
            matches the ontology and hits FalkorDB's indexes. The <span className="font-medium text-ink-secondary">Health</span> tab
            flags any source whose real graph has drifted.
          </p>
        </div>
      </EducationalCallout>

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
    </div>
  )
}
