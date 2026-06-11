/**
 * HierarchyComposer — right-rail subtree builder. Compose a whole
 * grandparent → parent → child hierarchy in memory (each level's type choices
 * constrained to the ontology's allowed children), then stage it as one batch:
 * a pre-order walk stages each node with its parent's just-minted temp urn, so
 * the containment chain is created in dependency order. Per-node validation and
 * a live "will stage N entities" summary keep the batch honest before save.
 */
import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useEntityTypes, useRootEntityTypes, useEntityTypeHierarchyMap } from '@/store/schema'
import { allowedChildTypeIds } from '../model/ontologyGuard'
import {
  type ComposerNode,
  makeComposerNode,
  addChildAt,
  updateNodeAt,
  removeNodeAt,
  summarizeByType,
  flattenPreOrder,
  validateComposer,
} from '../model/composerModel'
import type { StageEntityCreateInput } from '../model/stageNode'

export interface HierarchyComposerProps {
  seedParentId: string | null
  seedLayerId: string | null
  /** Stage one entity and return its minted temp urn (controller commitCreate). */
  onStageNode: (input: StageEntityCreateInput) => string
  onClose: () => void
}

export function HierarchyComposer({ seedParentId, seedLayerId, onStageNode, onClose }: HierarchyComposerProps) {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const nodes = useCanvasStore((s) => s.nodes)

  const seedParentNode = seedParentId ? nodes.find((n) => n.id === seedParentId || (n.data?.urn as string) === seedParentId) : null
  const seedParentType = (seedParentNode?.data?.type as string) || null

  const [roots, setRoots] = useState<ComposerNode[]>([])

  const allowedChildren = (parentType: string | null): string[] => {
    const set = allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)
    return entityTypes.filter((et) => set.has(et.id)).map((et) => et.id)
  }
  const typeName = (id: string) => entityTypes.find((et) => et.id === id)?.name ?? id

  const summary = useMemo(() => summarizeByType(roots), [roots])
  const validation = useMemo(() => validateComposer(roots, entityTypes), [roots, entityTypes])
  const canStage = roots.length > 0 && validation.ok

  const addRoot = () => {
    const allowed = allowedChildren(seedParentType)
    if (allowed.length === 0) return
    setRoots((r) => addChildAt(r, null, makeComposerNode(allowed[0])))
  }
  const addChild = (node: ComposerNode) => {
    const allowed = allowedChildren(node.entityType)
    if (allowed.length === 0) return
    setRoots((r) => addChildAt(r, node.tempKey, makeComposerNode(allowed[0])))
  }

  const stageAll = () => {
    if (!canStage) return
    // Pre-order: parents before children. Chain each child to its parent's
    // freshly-minted temp urn (roots chain to the seed parent, if any).
    const mintedByKey = new Map<string, string>()
    for (const { node, parentKey } of flattenPreOrder(roots)) {
      const parentUrn = parentKey ? mintedByKey.get(parentKey) : (seedParentId ?? undefined)
      const tempUrn = onStageNode({
        entityType: node.entityType,
        displayName: node.name.trim(),
        parentUrn,
        properties: { ...node.properties, ...(seedLayerId ? { layerAssignment: seedLayerId } : {}) },
      })
      mintedByKey.set(node.tempKey, tempUrn)
    }
    onClose()
  }

  const renderNode = (node: ComposerNode, depth: number) => {
    const childTypes = allowedChildren(node.entityType)
    const err = validation.errorsByKey[node.tempKey]
    const typeOptions = allowedChildren(depth === 0 ? seedParentType : null) // for retyping at this level
    return (
      <div key={node.tempKey} style={{ marginLeft: depth * 14 }} className="space-y-1">
        <div className="flex items-center gap-1.5">
          <LucideIcons.CornerDownRight className={cn('w-3 h-3 text-ink-muted flex-shrink-0', depth === 0 && 'opacity-0')} />
          <select
            value={node.entityType}
            onChange={(e) => setRoots((r) => updateNodeAt(r, node.tempKey, { entityType: e.target.value }))}
            className="input h-7 text-[11px] flex-shrink-0 max-w-[38%]"
          >
            {/* Always include the current type even if it falls outside the level set. */}
            {Array.from(new Set([node.entityType, ...typeOptions])).map((t) => (
              <option key={t} value={t}>{typeName(t)}</option>
            ))}
          </select>
          <input
            type="text"
            value={node.name}
            onChange={(e) => setRoots((r) => updateNodeAt(r, node.tempKey, { name: e.target.value }))}
            placeholder="Name…"
            className={cn('input h-7 text-[11px] flex-1 min-w-0', err && !err.ok && 'ring-1 ring-red-400/60')}
          />
          {childTypes.length > 0 && (
            <button onClick={() => addChild(node)} title={`Add ${typeName(childTypes[0])}`}
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-accent-primary flex-shrink-0">
              <LucideIcons.Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => setRoots((r) => removeNodeAt(r, node.tempKey))} title="Remove"
            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted flex-shrink-0">
            <LucideIcons.Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {err && !err.ok && (
          <p className="text-[10px] text-red-400" style={{ marginLeft: 14 + depth * 14 }}>
            {Object.values(err.errors)[0]}
          </p>
        )}
        {node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const rootAllowed = allowedChildren(seedParentType)

  return (
    <AnimatePresence>
      <motion.div
        key="hierarchy-composer"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 420 }}
        exit={{ opacity: 0, width: 0 }}
        className="relative h-full flex-shrink-0 overflow-hidden glass-panel border-l border-glass-border shadow-lg"
      >
        <div className="w-[420px] h-full flex flex-col">
          <div className="flex-shrink-0 px-5 py-4 border-b border-glass-border bg-canvas-elevated/95 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-accent-primary/10 flex items-center justify-center">
                <LucideIcons.ListTree className="w-5 h-5 text-accent-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-ink">Compose Hierarchy</h3>
                <p className="text-xs text-ink-muted">
                  {seedParentNode ? `Inside ${seedParentNode.data?.label as string}` : 'At the root level'}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
              <LucideIcons.X className="w-5 h-5 text-ink-muted" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {roots.length === 0 ? (
              <div className="text-center py-10 text-ink-muted">
                <LucideIcons.ListTree className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">Build a subtree — add a top-level entity to start.</p>
              </div>
            ) : (
              roots.map((n) => renderNode(n, 0))
            )}

            {rootAllowed.length > 0 ? (
              <button onClick={addRoot}
                className="mt-2 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-dashed border-accent-primary/40 text-accent-primary text-xs font-medium hover:bg-accent-primary/5">
                <LucideIcons.Plus className="w-3.5 h-3.5" />Add {typeName(rootAllowed[0])}
              </button>
            ) : (
              <p className="text-[11px] text-amber-500 flex items-center gap-1.5 mt-2">
                <LucideIcons.AlertTriangle className="w-3.5 h-3.5" />
                No entity type may be created {seedParentNode ? `inside ${seedParentType}` : 'at this level'}.
              </p>
            )}
          </div>

          <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95">
            <p className="text-[11px] text-ink-muted mb-2">
              {summary.total === 0
                ? 'Nothing to stage yet.'
                : `Will stage ${summary.total} ${summary.total === 1 ? 'entity' : 'entities'} (${
                    Object.entries(summary.byType).map(([t, c]) => `${c} ${typeName(t)}`).join(', ')
                  }).`}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors">Cancel</button>
              <button onClick={stageAll} disabled={!canStage}
                className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
                  canStage ? 'bg-accent-primary text-white hover:bg-accent-primary/90 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed')}>
                <LucideIcons.GitBranchPlus className="w-4 h-4" />Stage subtree
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

export default HierarchyComposer
