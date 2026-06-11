/**
 * AuthoringContextMenu — the ontology-aware right-click menu for the Context
 * View canvas (the React-Flow canvases keep the legacy CanvasContextMenu). Only
 * valid actions are offered: "Add child" appears when the node's type can
 * contain something, "Connect to…" when it has at least one legal lineage
 * target (and a draft is open); aggregated/containment edges hide their
 * authoring actions behind a single disabled "read-only" row. Disabled actions
 * explain why via their title.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import { useEntityTypes, useRelationshipTypes, useContainmentEdgeTypes, useRootEntityTypes, useEntityTypeHierarchyMap } from '@/store/schema'
import { allowedChildTypeIds, connectableTargetTypes, isEdgeAuthorable } from '../model/ontologyGuard'

export type AuthoringMenuTarget =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | { type: 'canvas'; position: { x: number; y: number }; layerId?: string }

interface MenuAction {
  id: string
  label: string
  icon: keyof typeof LucideIcons
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  danger?: boolean
  dividerAfter?: boolean
  onClick?: () => void
}

export interface AuthoringContextMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  target: AuthoringMenuTarget | null
  isDraftMode: boolean
  onClose: () => void
  // node
  onEditNode?: (id: string) => void
  onDeleteNode?: (id: string) => void
  onCreateChild?: (id: string) => void
  onConnect?: (id: string) => void
  onTraceNode?: (id: string) => void
  onCopyUrn?: (id: string) => void
  onMoveToLayer?: (id: string, layerId: string) => void
  layers?: Array<{ id: string; name: string; color?: string }>
  // edge
  onEditEdge?: (id: string) => void
  onDeleteEdge?: (id: string) => void
  onReverseEdge?: (id: string) => void
  // canvas
  onCreateNode?: (position: { x: number; y: number }, layerId?: string) => void
  onComposeHierarchy?: (layerId?: string) => void
  onSelectAll?: () => void
}

export function AuthoringContextMenu(props: AuthoringContextMenuProps) {
  const { isOpen, position, target, isDraftMode, onClose, layers = [] } = props
  const menuRef = useRef<HTMLDivElement>(null)
  const [showLayerSubmenu, setShowLayerSubmenu] = useState(false)

  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const entityTypes = useEntityTypes()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()

  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [isOpen, onClose])

  useEffect(() => { if (!isOpen) setShowLayerSubmenu(false) }, [isOpen])

  const run = useCallback((fn?: () => void) => { fn?.(); onClose() }, [onClose])

  const buildActions = (): MenuAction[] => {
    if (!target) return []
    const out: MenuAction[] = []

    if (target.type === 'node') {
      const node = nodes.find((n) => n.id === target.id)
      const nodeType = (node?.data?.type as string) ?? null
      const canHaveChild = allowedChildTypeIds(nodeType, entityTypes, rootEntityTypes, hierarchyMap).size > 0
      const canConnect = connectableTargetTypes(nodeType, entityTypes.map((e) => e.id), relationshipTypes, containmentEdgeTypes).size > 0

      if (props.onEditNode) out.push({ id: 'edit', label: 'View & Edit', icon: 'PanelRight', shortcut: 'Enter', onClick: () => run(() => props.onEditNode!(target.id)) })
      if (props.onTraceNode) out.push({ id: 'trace', label: 'Trace Lineage', icon: 'GitBranch', shortcut: 'T', onClick: () => run(() => props.onTraceNode!(target.id)) })
      if (props.onCopyUrn) out.push({ id: 'copy-urn', label: 'Copy URN', icon: 'Copy', shortcut: '⌘C', dividerAfter: true, onClick: () => run(() => props.onCopyUrn!(target.id)) })

      if (props.onCreateChild) out.push({
        id: 'create-child', label: 'Add Child Entity', icon: 'Plus',
        disabled: !canHaveChild,
        disabledReason: canHaveChild ? undefined : `${nodeType ?? 'This entity'} cannot contain other entities (ontology).`,
        onClick: () => run(() => props.onCreateChild!(target.id)),
      })
      if (props.onConnect) out.push({
        id: 'connect', label: 'Connect To…', icon: 'Spline', shortcut: 'C',
        disabled: !isDraftMode || !canConnect,
        disabledReason: !isDraftMode ? 'Open a draft to author edges.' : (!canConnect ? `${nodeType ?? 'This entity'} has no valid lineage target (ontology).` : undefined),
        onClick: () => run(() => props.onConnect!(target.id)),
      })
      if (layers.length > 0 && props.onMoveToLayer) out.push({ id: 'move-to-layer', label: 'Move to Layer', icon: 'Layers', dividerAfter: true, onClick: () => setShowLayerSubmenu(true) })
      if (props.onDeleteNode) out.push({ id: 'delete', label: 'Delete', icon: 'Trash2', shortcut: '⌫', danger: true, onClick: () => run(() => props.onDeleteNode!(target.id)) })
    } else if (target.type === 'edge') {
      const edge = edges.find((e) => e.id === target.id)
      const authorable = edge ? isEdgeAuthorable(edge, containmentEdgeTypes) : { ok: true as const }
      if (!authorable.ok) {
        out.push({ id: 'readonly', label: 'Read-only edge', icon: 'Lock', disabled: true, disabledReason: authorable.reason })
      } else {
        if (props.onEditEdge) out.push({ id: 'edit-edge', label: 'Edit / Retype Edge', icon: 'Pencil', onClick: () => run(() => props.onEditEdge!(target.id)) })
        if (props.onReverseEdge) out.push({ id: 'reverse-edge', label: 'Reverse Direction', icon: 'ArrowLeftRight', onClick: () => run(() => props.onReverseEdge!(target.id)) })
        if (props.onDeleteEdge) out.push({ id: 'delete-edge', label: 'Delete Edge', icon: 'Trash2', shortcut: '⌫', danger: true, onClick: () => run(() => props.onDeleteEdge!(target.id)) })
      }
    } else {
      if (props.onCreateNode) out.push({ id: 'create-node', label: 'Create Entity Here', icon: 'Plus', shortcut: 'N', onClick: () => run(() => props.onCreateNode!(target.position, target.layerId)) })
      if (props.onComposeHierarchy) out.push({ id: 'compose', label: 'Compose Hierarchy…', icon: 'ListTree', dividerAfter: true, onClick: () => run(() => props.onComposeHierarchy!(target.layerId)) })
      if (props.onSelectAll) out.push({ id: 'select-all', label: 'Select All', icon: 'CheckSquare', shortcut: '⌘A', onClick: () => run(() => props.onSelectAll!()) })
    }
    return out
  }

  const getIcon = (iconName: keyof typeof LucideIcons) => {
    const Icon = LucideIcons[iconName] as React.ComponentType<{ className?: string }>
    return Icon ? <Icon className="w-4 h-4" /> : null
  }

  const adjusted = { x: Math.min(position.x, window.innerWidth - 230), y: Math.min(position.y, window.innerHeight - 320) }
  const actions = buildActions()

  return (
    <AnimatePresence>
      {isOpen && target && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95, y: -5 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -5 }}
          transition={{ duration: 0.1 }}
          className="fixed z-[100] min-w-[210px] py-1.5 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
          style={{ left: adjusted.x, top: adjusted.y }}
        >
          <div className="px-3 py-1.5 border-b border-glass-border bg-black/5 dark:bg-white/5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              {target.type === 'node' ? 'Node Actions' : target.type === 'edge' ? 'Edge Actions' : 'Canvas Actions'}
            </span>
          </div>

          {showLayerSubmenu && target.type === 'node' ? (
            <div className="py-1">
              <button onClick={() => setShowLayerSubmenu(false)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">
                <LucideIcons.ChevronLeft className="w-3 h-3" />Back
              </button>
              <div className="border-t border-glass-border my-1" />
              {layers.map((layer) => (
                <button key={layer.id} onClick={() => run(() => props.onMoveToLayer!(target.id, layer.id))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent-lineage/10 hover:text-accent-lineage transition-colors">
                  <div className="w-3 h-3 rounded-full border border-white/20" style={{ backgroundColor: layer.color ?? '#888' }} />
                  {layer.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="py-1">
              {actions.map((action, index) => (
                <React.Fragment key={action.id}>
                  <button
                    onClick={action.onClick}
                    disabled={action.disabled}
                    title={action.disabledReason}
                    className={cn(
                      'w-full flex items-center justify-between gap-3 px-3 py-2 text-sm transition-colors',
                      action.disabled ? 'text-ink-muted cursor-not-allowed opacity-50'
                        : action.danger ? 'text-red-500 hover:bg-red-500/10'
                          : 'text-ink hover:bg-accent-lineage/10 hover:text-accent-lineage',
                    )}
                  >
                    <span className="flex items-center gap-2.5">{getIcon(action.icon)}{action.label}</span>
                    {action.shortcut && (
                      <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded font-mono">{action.shortcut}</span>
                    )}
                  </button>
                  {action.dividerAfter && index < actions.length - 1 && <div className="border-t border-glass-border my-1" />}
                </React.Fragment>
              ))}
              {actions.length === 0 && <div className="px-3 py-2 text-xs text-ink-muted">No actions available</div>}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default AuthoringContextMenu
