/**
 * DraftNodeCard — the inline "ghost card" quick-create surface, pinned at the
 * top of a layer column while inline-create targets that layer. Type choices are
 * constrained to the ontology's allowed children for the target parent (or layer
 * roots), shown with reasons when empty. Enter stages and stays open for rapid
 * sibling entry; "Details…" escalates to the full panel carrying the typed
 * name/type; Escape cancels.
 *
 * Pinned (not injected into the virtualized tree) so it never perturbs the
 * row-measurement cache — the staged node appears in the tree normally once
 * assigned to the layer.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useEntityTypes, useRootEntityTypes, useEntityTypeHierarchyMap } from '@/store/schema'
import { allowedChildTypeIds } from '../model/ontologyGuard'
import type { StageEntityCreateInput } from '../model/stageNode'

export interface DraftNodeCardProps {
  layerId: string
  /** Parent node id for child-create; null for layer-level (root) create. */
  parentId: string | null
  /** Entity type ids visible in this layer — the allowed set is intersected with this. */
  visibleEntityTypeIds?: string[]
  onCommit: (input: StageEntityCreateInput, opts: { keepOpen: boolean; layerId: string }) => void
  onEscalate: (seed: { parentId: string | null; layerId: string; entityType?: string; displayName?: string }) => void
  onCancel: () => void
}

export function DraftNodeCard({ layerId, parentId, visibleEntityTypeIds, onCommit, onEscalate, onCancel }: DraftNodeCardProps) {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const nodes = useCanvasStore((s) => s.nodes)
  const nameRef = useRef<HTMLInputElement>(null)

  const parentNode = parentId ? nodes.find((n) => n.id === parentId || (n.data?.urn as string) === parentId) : null
  const parentType = (parentNode?.data?.type as string) || null

  const options = useMemo(() => {
    const allowed = allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)
    const visible = visibleEntityTypeIds && visibleEntityTypeIds.length > 0 ? new Set(visibleEntityTypeIds) : null
    return entityTypes.filter((et) => allowed.has(et.id) && (!visible || visible.has(et.id)))
  }, [entityTypes, parentType, rootEntityTypes, hierarchyMap, visibleEntityTypeIds])

  const [typeId, setTypeId] = useState('')
  const [name, setName] = useState('')

  // Default to the sole option / first option, and focus the name field.
  useEffect(() => {
    if (!typeId && options.length > 0) setTypeId(options[0].id)
  }, [options, typeId])
  useEffect(() => { nameRef.current?.focus() }, [])

  const canStage = Boolean(typeId && name.trim())
  const commit = () => {
    if (!canStage) return
    onCommit(
      { entityType: typeId, displayName: name.trim(), parentUrn: parentId, properties: { layerAssignment: layerId } },
      { keepOpen: true, layerId },
    )
    setName('')
    nameRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }

  return (
    <div
      data-canvas-interactive
      className="mx-1 mb-2 rounded-xl border border-accent-primary/40 bg-accent-primary/[0.04] shadow-sm overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-accent-primary/15">
        <LucideIcons.Plus className="w-3.5 h-3.5 text-accent-primary" />
        <span className="text-[11px] font-semibold text-ink">New entity</span>
        {parentNode && (
          <span className="text-[10px] text-ink-muted truncate">in {parentNode.data?.label as string}</span>
        )}
        <button onClick={onCancel} className="ml-auto p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10" title="Cancel (Esc)">
          <LucideIcons.X className="w-3.5 h-3.5 text-ink-muted" />
        </button>
      </div>

      {options.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-amber-500 flex items-start gap-1.5">
          <LucideIcons.AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          <span>
            No entity type may be created {parentNode ? `inside ${parentType}` : 'at this level'} per the ontology.
          </span>
        </div>
      ) : (
        <div className="p-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              className="input h-8 text-xs flex-shrink-0 max-w-[42%]"
            >
              {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Name…"
              className="input h-8 text-xs flex-1 min-w-0"
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => onEscalate({ parentId, layerId, entityType: typeId, displayName: name })}
              className="text-[10px] text-ink-muted hover:text-ink underline-offset-2 hover:underline"
            >
              Details…
            </button>
            <button
              onClick={commit}
              disabled={!canStage}
              className={cn(
                'px-2.5 h-7 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 transition-colors',
                canStage ? 'bg-accent-primary text-white hover:bg-accent-primary/90' : 'bg-black/5 dark:bg-white/10 text-ink-muted cursor-not-allowed',
              )}
            >
              <LucideIcons.Plus className="w-3 h-3" />Add
            </button>
          </div>
          <p className="text-[9px] text-ink-muted">↵ adds and keeps this open for another</p>
        </div>
      )}
    </div>
  )
}

export default DraftNodeCard
