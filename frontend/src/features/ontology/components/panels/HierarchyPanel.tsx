import { useState, useMemo } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { EntityTypeSchema } from '@/types/schema'
import { DynamicIcon } from '@/components/ui/DynamicIcon'

import { EmptyState } from '../EmptyState'
import type { RelTypeWithClassifications } from '../../lib/ontology-types'

// ---------------------------------------------------------------------------
// HierarchyNode interface
// ---------------------------------------------------------------------------

export interface HierarchyNode {
  id: string
  entityType: EntityTypeSchema
  children: HierarchyNode[]
}

// ---------------------------------------------------------------------------
// buildHierarchyTree — builds a containment tree from entity types
// ---------------------------------------------------------------------------

export function buildHierarchyTree(entityTypes: EntityTypeSchema[]): {
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

// ---------------------------------------------------------------------------
// computeNodeLevels — compute tree depth for each node
// ---------------------------------------------------------------------------

export function computeNodeLevels(roots: HierarchyNode[]): Map<string, number> {
  const map = new Map<string, number>()
  function traverse(node: HierarchyNode, level: number) {
    map.set(node.id, level)
    for (const child of node.children) traverse(child, level + 1)
  }
  for (const root of roots) traverse(root, 0)
  return map
}

// ---------------------------------------------------------------------------
// HierarchyTreeNode — recursive tree node component with visual tree lines
// ---------------------------------------------------------------------------

export function HierarchyTreeNode({
  node,
  allEntityTypes,
  computedLevelMap,
  isLocked,
  onReparent,
  onEditType,
  depth,
  isLastChild,
  ancestorIsLast,
}: {
  node: HierarchyNode
  allEntityTypes: EntityTypeSchema[]
  computedLevelMap: Map<string, number>
  isLocked: boolean
  onReparent: (childId: string, newParentId: string | null) => void
  onEditType: (et: EntityTypeSchema) => void
  depth: number
  isLastChild?: boolean
  ancestorIsLast?: boolean[]
}) {
  const [showNestPicker, setShowNestPicker] = useState(false)
  const computedLevel = computedLevelMap.get(node.id) ?? depth
  const storedLevel = node.entityType.hierarchy.level
  const levelMismatch = computedLevel !== storedLevel

  const potentialParents = allEntityTypes.filter(p => p.id !== node.id)
  const isRoot = depth === 0

  return (
    <div className="relative">
      {/* Vertical connector lines from ancestors */}
      {depth > 0 && ancestorIsLast && ancestorIsLast.map((isLast, i) => (
        !isLast && (
          <div
            key={i}
            className="absolute top-0 bottom-0 border-l-2 border-glass-border/40"
            style={{ left: `${(i + 1) * 24 + 8}px` }}
          />
        )
      ))}

      {/* Horizontal connector to this node */}
      {depth > 0 && (
        <>
          {/* Vertical line down to this node */}
          <div
            className="absolute border-l-2 border-glass-border/40"
            style={{
              left: `${depth * 24 + 8}px`,
              top: 0,
              height: isLastChild ? '24px' : '100%',
            }}
          />
          {/* Horizontal branch line */}
          <div
            className="absolute border-t-2 border-glass-border/40"
            style={{
              left: `${depth * 24 + 8}px`,
              top: '24px',
              width: '16px',
            }}
          />
        </>
      )}

      {/* Row */}
      <div
        className="flex items-center gap-2 group py-2 px-3 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] rounded-lg transition-colors relative"
        style={{ paddingLeft: `${depth * 24 + (depth > 0 ? 28 : 12)}px` }}
      >
        {/* Drag handle (visual affordance) */}
        {!isLocked && (
          <LucideIcons.GripVertical className="w-3 h-3 text-ink-muted/20 group-hover:text-ink-muted/50 flex-shrink-0 cursor-grab transition-colors" />
        )}

        {/* Root crown or child indicator */}
        {isRoot
          ? <span title="Root type"><LucideIcons.Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /></span>
          : null
        }

        {/* Color dot + icon */}
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ring-1 ring-black/5 dark:ring-white/5"
          style={{ backgroundColor: `${node.entityType.visual.color}18` }}
        >
          <DynamicIcon
            name={node.entityType.visual.icon}
            className="w-3.5 h-3.5"
            style={{ color: node.entityType.visual.color }}
          />
        </div>

        {/* Name */}
        <span className="text-sm font-medium text-ink">{node.entityType.name}</span>
        <code className="text-[10px] text-ink-muted/50 font-mono hidden sm:block">{node.entityType.id}</code>

        {/* Level badge */}
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium',
            levelMismatch
              ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 ring-1 ring-amber-300/30'
              : 'bg-black/5 dark:bg-white/5 text-ink-muted'
          )}
          title={levelMismatch ? `Stored as L${storedLevel} but computed depth is L${computedLevel}. Edit the type to fix.` : `Level ${computedLevel}`}
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
      {node.children.map((child, i) => (
        <HierarchyTreeNode
          key={child.id}
          node={child}
          allEntityTypes={allEntityTypes}
          computedLevelMap={computedLevelMap}
          isLocked={isLocked}
          onReparent={onReparent}
          onEditType={onEditType}
          depth={depth + 1}
          isLastChild={i === node.children.length - 1}
          ancestorIsLast={[...(ancestorIsLast ?? []), i === node.children.length - 1]}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OrphanTypeRow — unplaced entity type row
// ---------------------------------------------------------------------------

export function OrphanTypeRow({
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
        {/* Color dot + icon */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ring-1 ring-amber-300/20"
          style={{ backgroundColor: `${et.visual.color}18` }}
        >
          <DynamicIcon
            name={et.visual.icon}
            className="w-4 h-4"
            style={{ color: et.visual.color }}
          />
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
// HierarchyPanel — the main panel (renamed from HierarchyMapTab)
// ---------------------------------------------------------------------------

export function HierarchyPanel({
  selectedOntology,
  entityTypes,
  relTypes,
  isLocked,
  isSaving,
  onReparent,
  onEditType,
  onUpdateContainmentEdgeTypes,
}: {
  selectedOntology: OntologyDefinitionResponse
  entityTypes: EntityTypeSchema[]
  relTypes: RelTypeWithClassifications[]
  isLocked: boolean
  isSaving: boolean
  onReparent: (childId: string, newParentId: string | null) => void
  onEditType: (et: EntityTypeSchema) => void
  onUpdateContainmentEdgeTypes: (newList: string[]) => void
}) {
  const { roots, orphans } = useMemo(() => buildHierarchyTree(entityTypes), [entityTypes])
  const computedLevelMap = useMemo(() => computeNodeLevels(roots), [roots])
  const containmentRels = useMemo(() => relTypes.filter(r => r.isContainment), [relTypes])
  const containmentEdgeTypes: string[] = selectedOntology.containmentEdgeTypes ?? []
  const [edgeTypesExpanded, setEdgeTypesExpanded] = useState(false)

  return (
    <div>
      {/* Saving overlay indicator */}
      {isSaving && (
        <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 mb-4">
          <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
          Updating hierarchy...
        </div>
      )}

      {/* Containment Edge Types — compact collapsible section */}
      <div className="mb-6 rounded-xl border border-glass-border bg-canvas-elevated/30 overflow-hidden">
        <button
          onClick={() => setEdgeTypesExpanded(v => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        >
          <LucideIcons.ArrowRightLeft className="w-4 h-4 text-indigo-500 flex-shrink-0" />
          <h3 className="text-sm font-semibold text-ink flex-1">Containment Edge Types</h3>
          <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400">
            {containmentEdgeTypes.length}
          </span>
          <LucideIcons.ChevronDown className={cn(
            'w-4 h-4 text-ink-muted transition-transform duration-200',
            !edgeTypesExpanded && '-rotate-90'
          )} />
        </button>
        {edgeTypesExpanded && (
          <div className="px-4 pb-3 border-t border-glass-border/50">
            <p className="text-[11px] text-ink-muted mt-2 mb-3">
              Relationship types that define parent-child nesting in the canvas hierarchy.
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
                  No containment relationships defined yet.
                </p>
              )}
            </div>
          </div>
        )}
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
              <div className="rounded-xl border border-glass-border overflow-hidden bg-canvas-elevated/30 p-1">
                {roots.map((root, i) => (
                  <HierarchyTreeNode
                    key={root.id}
                    node={root}
                    allEntityTypes={entityTypes}
                    computedLevelMap={computedLevelMap}
                    isLocked={isLocked}
                    onReparent={onReparent}
                    onEditType={onEditType}
                    depth={0}
                    isLastChild={i === roots.length - 1}
                    ancestorIsLast={[]}
                  />
                ))}
              </div>

              {/* Level legend */}
              <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-muted">
                <LucideIcons.Crown className="w-3 h-3 text-amber-500" />
                <span>Root (L0)</span>
                <span className="opacity-40">|</span>
                <span className="bg-amber-50 dark:bg-amber-950/30 text-amber-600 px-1.5 py-0.5 rounded">L*</span>
                <span>= stored level differs from computed tree depth</span>
                {!isLocked && (
                  <>
                    <span className="opacity-40">|</span>
                    <LucideIcons.GripVertical className="w-3 h-3 text-ink-muted/50" />
                    <span>Drag to reorder (coming soon)</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Unplaced / Orphan Types */}
          {orphans.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider mb-1 flex items-center gap-2">
                <LucideIcons.AlertTriangle className="w-3.5 h-3.5" />
                Unorganized Types ({orphans.length})
              </h3>
              <p className="text-[11px] text-ink-muted mb-3">
                These types are not in any containment hierarchy. They'll appear as floating nodes in canvas views.
                {!isLocked && ' Make them roots or nest them under a parent type.'}
              </p>
              <div className="space-y-2 p-3 rounded-xl border-2 border-dashed border-amber-200 dark:border-amber-800/50 bg-amber-50/10 dark:bg-amber-950/5">
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
