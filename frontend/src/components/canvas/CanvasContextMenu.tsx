/**
 * CanvasContextMenu - Modern context menu for graph CRUD operations
 * 
 * Provides a unified right-click experience across all canvas views with:
 * - Node operations: Edit, Duplicate, Delete, Create Child
 * - Edge operations: Edit, Delete, Reverse
 * - Canvas operations: Create Node, Paste, Select All
 * - Visual feedback and keyboard shortcut hints
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { LAYER_COLORS } from '@/components/views/ViewWizard/layerColors'
import { placeMenu } from './menuPlacement'
import { usePersonaMode } from '@/store/persona'
import { ChangeKindTag } from './context-view/DropHint'
import { COLUMN_KIND_ICON } from './context-view/columnKind'
import type { ColumnChoice, DataReach } from './context-view/changeKind'

// ============================================
// Types
// ============================================

export type ContextMenuTarget =
    | { type: 'node'; id: string; data?: Record<string, unknown> }
    | { type: 'edge'; id: string; source: string; target: string }
    | { type: 'canvas'; position: { x: number; y: number }; layerId?: string }
    | { type: 'layer'; layerId: string }

/**
 * A layer's menu (Context View) — opened from its column header or its Layer Strip chip, so a
 * layer can be inserted beside any other without scrolling to the end of the canvas. Layout edits
 * need a draft; outside one the menu says so and offers to start editing.
 */
export interface LayerMenuModel {
    name: string
    color: string
    /** Where the layer sits, so a move past either end is not offered. */
    index: number
    count: number
    folded: boolean
    canEdit: boolean
    onInsert: (side: 'left' | 'right') => void
    onRename: () => void
    onRecolor: (color: string) => void
    onMove: (dir: -1 | 1) => void
    onToggleFold?: () => void
    onDelete: () => void
    /** Outside a draft: open one, to change the layers. */
    onStartEditing?: () => void
    /** Narrow the canvas to what is in this layer (and what that reaches). */
    onNarrow?: () => void
    /** Change a property on every entity in this layer (on the draft). */
    onEditProperties?: () => void
    /** The layer's settings — its essentials and its own properties; its
     *  details, read-only, outside a draft. */
    onOpenSettings?: () => void
    /** The header's own actions — add an entity, start a group, build many at
     *  once — for wherever its actions tray does not show them: the Business
     *  view's, and a column too narrow for the tray's icons (its ⋯ opens this). */
    onAddEntity?: () => void
    /** The entity the layer is mapped to, which Add entity adds inside — named in its label. */
    addInside?: string
    onNewGroup?: () => void
    onBuild?: () => void
    /** Select everything the layer shows (layerSelection.ts) — in both views, and
     *  during a trace too: selecting writes nothing. */
    selectAll?: { count: number; onSelect: () => void }
    /** Mapping the column to an entity — a view change (columnKind.ts `mapOffer`): map it (or map
     *  it to another, `mapped`), show the entity it is mapped to as a row, or why it can't be. */
    mapping?: {
        onMap?: () => void
        mapped?: boolean
        unmap?: { name: string; onUnmap: () => void }
        refused?: string
    }
}

/** Move to Layer, guided: where the entity could go, and what each choice changes. */
export interface MoveChoices {
    /** The entity, by the name the reader sees. */
    name: string
    choices: ColumnChoice[]
    /** Who a data choice reaches. */
    reach: DataReach
    /** The two kinds, side by side (changeKind.ts `moveFooter`). */
    footer: string
}

export interface ContextMenuAction {
    id: string
    label: string
    icon: keyof typeof LucideIcons
    shortcut?: string
    disabled?: boolean
    /** A quieter second line — for a disabled item, why. */
    hint?: string
    /** The kind of change it makes, as a tag under its label (changeKind.ts). */
    change?: 'data' | 'view'
    /** A switch on the item's own row, changing what the item does (its label
     *  says what it does now). Flipping it keeps the menu open. */
    toggle?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
    danger?: boolean
    dividerAfter?: boolean
    onClick: () => void
}

export interface CanvasContextMenuProps {
    /** Whether the menu is open */
    isOpen: boolean
    /** Position of the menu */
    position: { x: number; y: number }
    /** What was right-clicked */
    target: ContextMenuTarget | null
    /** Close handler */
    onClose: () => void
    /** Node actions */
    onEditNode?: (id: string) => void
    onDuplicateNode?: (id: string) => void
    /** Duplicate… — choose what comes with the copy (children, incoming, outgoing). */
    onDuplicateWithOptions?: (id: string) => void
    onDeleteNode?: (id: string) => void
    onCreateChild?: (parentId: string) => void
    onTraceNode?: (id: string) => void
    /** Open the Lineage Lens on this node — its immediate connections,
     *  grouped and searchable. */
    onFocusConnections?: (id: string) => void
    /** Ask the view's owners about this node — opens the questions drawer with the
     *  question about it. Absent where questions are off or there is no saved view. */
    onAskAboutNode?: (nodeId: string) => void
    /** Export… — this node (or the selection it is part of) with everything inside it, to edit
     *  offline and import back. */
    onExportNode?: (id: string) => void
    onCopyUrn?: (id: string) => void
    /** Arm edge connect-mode from this node */
    onConnect?: (sourceId: string) => void
    /** Open the click-based "Link to…" popover from this node */
    onLinkNode?: (nodeId: string) => void
    /** Edge actions */
    onEditEdge?: (id: string) => void
    onDeleteEdge?: (id: string) => void
    onReverseEdge?: (id: string) => void
    /** Canvas actions */
    onCreateNode?: (position: { x: number; y: number }, layerId?: string) => void
    /** The entity Create Entity Here adds inside (a column mapped to it) — named in its label. */
    createNodeInside?: string
    onPaste?: (position: { x: number; y: number }) => void
    onSelectAll?: () => void
    /** Additional custom actions */
    customActions?: ContextMenuAction[]
    /** Questions about the node right-clicked, answered by the search
     *  panel — shown together after its read affordances. */
    queryActions?: ContextMenuAction[]
    /** Move to Layer's choices for an entity — none where it can't be moved between columns. */
    moveChoices?: (nodeId: string) => MoveChoices | null
    /** A view choice: show the entity in this column. */
    onMoveToLayer?: (nodeId: string, layerId: string) => void
    /** A data choice: move the entity inside the one a column is mapped to. */
    onMoveInside?: (nodeId: string, parentId: string) => void
    /** "Give ‹it› its own column": a top-level entity's own column, mapped to it, right after the
     *  one it is in — none where it can't have one. */
    ownColumnFor?: (nodeId: string) => { name: string; onGive: () => void } | null
    /** Move to another parent… — a data change, chosen in a dialog. */
    onMoveToParent?: (nodeId: string) => void
    /** What it changes, under its label. */
    moveToParentHint?: string
    /** The right-clicked layer's menu (target type `layer`). */
    layerMenu?: LayerMenuModel | null
    /** Narrow the canvas to the right-clicked entity (or the selection it is
     *  part of): one entry per reach, shown in a "Narrow to this" submenu. */
    narrowActions?: ContextMenuAction[]
    /** Nothing here can be edited (Published, or a trace holding the canvas):
     *  View & Edit reads as View details — the panel it opens reads only. */
    viewOnly?: boolean
    /** Open what is inside the entity (or the selection it is part of) — a
     *  level at a time, or every level — and close it all again. Right after
     *  View: opening an entity is the first thing after looking at it. */
    expandActions?: ContextMenuAction[]
    /** An empty column right-clicked: select everything in ITS layer, beside
     *  `onSelectAll`'s everything the canvas shows. */
    selectLayer?: { name: string; count: number; onSelect: () => void } | null
    /** A trace holds the canvas. Its own actions lead the entity's menu (start
     *  it again from here, add this, take this out), and every menu ends by
     *  saying why there is nothing to edit, with the way out. */
    trace?: {
        actions: ContextMenuAction[]
        /** Editing would otherwise be on — the trace is what pauses it. */
        editingPaused: boolean
        onExit: () => void
    }
}

// ============================================
// Component
// ============================================

export function CanvasContextMenu({
    isOpen,
    position,
    target,
    onClose,
    onEditNode,
    onDuplicateNode,
    onDuplicateWithOptions,
    onDeleteNode,
    onCreateChild,
    onTraceNode,
    onFocusConnections,
    onAskAboutNode,
    onExportNode,
    onCopyUrn,
    onConnect,
    onLinkNode,
    onEditEdge,
    onDeleteEdge,
    onReverseEdge,
    onCreateNode,
    createNodeInside,
    onPaste,
    onSelectAll,
    customActions = [],
    queryActions = [],
    moveChoices,
    onMoveToLayer,
    onMoveInside,
    ownColumnFor,
    onMoveToParent,
    moveToParentHint,
    layerMenu = null,
    narrowActions = [],
    viewOnly = false,
    expandActions = [],
    selectLayer = null,
    trace,
}: CanvasContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const [submenu, setSubmenu] = React.useState<'layer' | 'narrow' | null>(null)
    const showLayerSubmenu = submenu === 'layer'
    const showNarrowSubmenu = submenu === 'narrow'

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return

        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose()
            }
        }

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose()
            }
        }

        // Delay to prevent immediate close from the same click
        setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside)
            document.addEventListener('keydown', handleEscape)
        }, 0)

        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [isOpen, onClose])

    // Reset submenu when menu closes
    useEffect(() => {
        if (!isOpen) setSubmenu(null)
    }, [isOpen])

    // Opened from a button (a layer header's ⋯), not a right-click:
    // the keyboard follows into the menu, and back to the button when it closes,
    // unless what was chosen took the focus somewhere of its own.
    useEffect(() => {
        if (!isOpen) return
        const trigger = document.activeElement
        if (!(trigger instanceof HTMLElement) || !trigger.matches('[data-canvas-menu-trigger]')) return
        listRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
        return () => {
            if (trigger.isConnected && (!document.activeElement || document.activeElement === document.body)) trigger.focus()
        }
    }, [isOpen])

    // The Business view's entity menu reads and walks; copying an identifier
    // and narrowing the canvas are the Technical view's.
    const technical = usePersonaMode() === 'technical'

    // What Move to Layer would offer the entity right-clicked — asked once per opening.
    const guide = React.useMemo(
        () => (isOpen && target?.type === 'node' && onMoveToLayer && moveChoices ? moveChoices(target.id) : null),
        [isOpen, target, onMoveToLayer, moveChoices],
    )

    /** "Select all in <Layer> (N)" — offered with nothing to select too, saying why. */
    const selectAllIn = useCallback((name: string, count: number, onSelect: () => void): ContextMenuAction => ({
        id: 'select-layer',
        label: `Select all in ${name}${count > 0 ? ` (${count.toLocaleString()})` : ''}`,
        icon: 'CheckSquare',
        disabled: count === 0,
        hint: count === 0 ? 'Nothing in this layer is on the canvas yet' : undefined,
        onClick: () => { if (count > 0) { onSelect(); onClose() } },
    }), [onClose])

    // Build actions based on target type
    const actions = useCallback((): ContextMenuAction[] => {
        if (!target) return []

        const result: ContextMenuAction[] = []

        if (target.type === 'node') {
            // A trace's own actions first: on a trace card they are what the
            // reader came for.
            if (trace && trace.actions.length > 0) {
                const own = trace.actions.map((a) => ({ ...a, onClick: () => { a.onClick(); onClose() } }))
                own[own.length - 1] = { ...own[own.length - 1], dividerAfter: true }
                result.push(...own)
            }

            // Node actions
            if (onEditNode) {
                result.push({
                    id: 'edit',
                    label: viewOnly ? 'View details' : 'View & Edit',
                    icon: 'PanelRight',
                    shortcut: 'Enter',
                    onClick: () => { onEditNode(target.id); onClose() }
                })
            }

            if (expandActions.length > 0) {
                if (result.length > 0) result[result.length - 1] = { ...result[result.length - 1], dividerAfter: true }
                result.push(...expandActions.map((a, i) => ({
                    ...a,
                    dividerAfter: i === expandActions.length - 1,
                    onClick: () => { a.onClick(); onClose() },
                })))
            }

            if (onTraceNode) {
                result.push({
                    id: 'trace',
                    label: 'Trace Lineage',
                    icon: 'GitBranch',
                    shortcut: 'T',
                    onClick: () => { onTraceNode(target.id); onClose() }
                })
            }

            if (onFocusConnections) {
                result.push({
                    id: 'focus-connections',
                    label: 'Focus Connections',
                    icon: 'Focus',
                    shortcut: 'F',
                    onClick: () => { onFocusConnections(target.id); onClose() }
                })
            }

            if (onAskAboutNode) {
                result.push({
                    id: 'ask-about',
                    label: 'Ask about this',
                    icon: 'MessageCircleQuestion',
                    onClick: () => { onAskAboutNode(target.id); onClose() }
                })
            }

            if (onExportNode) {
                result.push({
                    id: 'export-with-children',
                    label: 'Export with children…',
                    icon: 'FileDown',
                    onClick: () => { onExportNode(target.id); onClose() }
                })
            }

            if (technical && narrowActions.length > 0) {
                result.push({
                    id: 'narrow',
                    label: 'Narrow to this…',
                    icon: 'ScanSearch',
                    onClick: () => setSubmenu('narrow')
                })
            }

            if (!technical && result.length > 0) {
                // Copy URN closes the reading group in the Technical view.
                result[result.length - 1] = { ...result[result.length - 1], dividerAfter: true }
            }
            if (technical && onCopyUrn) {
                result.push({
                    id: 'copy-urn',
                    label: 'Copy URN',
                    icon: 'Copy',
                    shortcut: '⌘C',
                    dividerAfter: true,
                    onClick: () => { onCopyUrn(target.id); onClose() }
                })
            }

            result.push(...queryActions.map((a, i) =>
                i === queryActions.length - 1 ? { ...a, dividerAfter: true } : a))

            if (onCreateChild) {
                result.push({
                    id: 'create-child',
                    label: 'Add Child Entity',
                    icon: 'Plus',
                    onClick: () => { onCreateChild(target.id); onClose() }
                })
            }

            if (onConnect) {
                result.push({
                    id: 'connect',
                    label: 'Connect To…',
                    icon: 'Spline',
                    shortcut: 'C',
                    onClick: () => { onConnect(target.id); onClose() }
                })
            }

            if (onLinkNode) {
                result.push({
                    id: 'link-to',
                    label: 'Link to…',
                    icon: 'Link2',
                    onClick: () => { onLinkNode(target.id); onClose() }
                })
            }

            // One Duplicate. Where the canvas offers the dialog, it is the item: it opens on
            // the quick copy's choices, so Enter makes the copy ⌘D would, and anything more
            // is a click away. ⌘D still copies at once from the keyboard.
            if (onDuplicateWithOptions) {
                result.push({
                    id: 'duplicate-options',
                    label: 'Duplicate…',
                    icon: 'CopyPlus',
                    shortcut: '⇧⌘D',
                    onClick: () => { onDuplicateWithOptions(target.id); onClose() }
                })
            } else if (onDuplicateNode) {
                result.push({
                    id: 'duplicate',
                    label: 'Duplicate',
                    icon: 'Copy',
                    shortcut: '⌘D',
                    onClick: () => { onDuplicateNode(target.id); onClose() }
                })
            }

            // Where this view shows it (a view change) — then where it is in the data (a data change).
            if (guide && guide.choices.length > 0) {
                result.push({
                    id: 'move-to-layer',
                    label: 'Move to Layer',
                    icon: 'Layers',
                    hint: 'Where this view shows it',
                    onClick: () => setSubmenu('layer')
                })
            }
            const own = ownColumnFor?.(target.id)
            if (own) {
                result.push({
                    id: 'own-column',
                    label: `Give ${own.name} its own column`,
                    icon: 'Columns3',
                    change: 'view',
                    onClick: () => { own.onGive(); onClose() }
                })
            }
            if (onMoveToParent) {
                result.push({
                    id: 'move-to-parent',
                    label: 'Move to another parent…',
                    icon: 'FolderInput',
                    hint: moveToParentHint,
                    onClick: () => { onMoveToParent(target.id); onClose() }
                })
            }
            const last = result[result.length - 1]
            if (last && (last.id === 'move-to-layer' || last.id === 'own-column' || last.id === 'move-to-parent')) result[result.length - 1] = { ...last, dividerAfter: true }

            if (onDeleteNode) {
                result.push({
                    id: 'delete',
                    label: 'Delete',
                    icon: 'Trash2',
                    shortcut: '⌫',
                    danger: true,
                    onClick: () => { onDeleteNode(target.id); onClose() }
                })
            }
        } else if (target.type === 'edge') {
            // Edge actions
            if (onEditEdge) {
                result.push({
                    id: 'edit-edge',
                    label: 'Edit Edge',
                    icon: 'Pencil',
                    onClick: () => { onEditEdge(target.id); onClose() }
                })
            }

            if (onReverseEdge) {
                result.push({
                    id: 'reverse-edge',
                    label: 'Reverse Direction',
                    icon: 'ArrowLeftRight',
                    onClick: () => { onReverseEdge(target.id); onClose() }
                })
            }

            if (onDeleteEdge) {
                result.push({
                    id: 'delete-edge',
                    label: 'Delete Edge',
                    icon: 'Trash2',
                    shortcut: '⌫',
                    danger: true,
                    onClick: () => { onDeleteEdge(target.id); onClose() }
                })
            }
        } else if (target.type === 'canvas') {
            // Canvas actions
            if (onCreateNode) {
                result.push({
                    id: 'create-node',
                    label: createNodeInside ? `Add inside ${createNodeInside}` : 'Create Entity Here',
                    icon: 'Plus',
                    shortcut: 'N',
                    onClick: () => { onCreateNode(target.position, target.layerId); onClose() }
                })
            }

            if (onPaste) {
                result.push({
                    id: 'paste',
                    label: 'Paste',
                    icon: 'Clipboard',
                    shortcut: '⌘V',
                    dividerAfter: true,
                    onClick: () => { onPaste(target.position); onClose() }
                })
            }

            if (selectLayer) {
                result.push(selectAllIn(selectLayer.name, selectLayer.count, selectLayer.onSelect))
            }
            if (onSelectAll) {
                result.push({
                    id: 'select-all',
                    // Beside a layer's own, "all" needs saying: the whole canvas.
                    label: selectLayer ? 'Select everything' : 'Select All',
                    icon: selectLayer ? 'ListChecks' : 'CheckSquare',
                    shortcut: '⌘A',
                    onClick: () => { onSelectAll(); onClose() }
                })
            }
        } else if (target.type === 'layer' && layerMenu) {
            const m = layerMenu
            if (m.onOpenSettings) {
                result.push({
                    id: 'layer-settings',
                    label: m.canEdit ? 'Layer settings…' : 'Layer details…',
                    icon: 'SlidersHorizontal',
                    dividerAfter: !m.selectAll,
                    onClick: () => { m.onOpenSettings?.(); onClose() },
                })
            }
            if (m.selectAll) {
                result.push({ ...selectAllIn(m.name, m.selectAll.count, m.selectAll.onSelect), dividerAfter: true })
            }
            if (m.canEdit) {
                const adds: ContextMenuAction[] = []
                if (m.onAddEntity) adds.push({ id: 'layer-add-entity', label: m.addInside ? `Add inside ${m.addInside}` : 'Add entity', icon: 'Plus', onClick: () => { m.onAddEntity?.(); onClose() } })
                if (m.onNewGroup) adds.push({ id: 'layer-new-group', label: 'New group', icon: 'FolderPlus', onClick: () => { m.onNewGroup?.(); onClose() } })
                if (m.onBuild) adds.push({ id: 'layer-build', label: 'Build a lot at once', icon: 'LayoutGrid', onClick: () => { m.onBuild?.(); onClose() } })
                if (adds.length > 0) adds[adds.length - 1] = { ...adds[adds.length - 1], dividerAfter: true }
                result.push(...adds)
                const map = m.mapping
                const maps: ContextMenuAction[] = []
                if (map?.unmap) {
                    const { onUnmap } = map.unmap
                    maps.push({ id: 'unmap-layer', label: `Show ${map.unmap.name} as a row`, icon: 'Rows3', change: 'view', onClick: () => { onUnmap(); onClose() } })
                }
                if (map?.onMap) {
                    const { onMap } = map
                    maps.push({ id: 'map-layer', label: map.mapped ? 'Map to another entity…' : 'Map this column to…', icon: 'Link2', change: 'view', onClick: () => { onMap(); onClose() } })
                } else if (map?.refused) {
                    maps.push({ id: 'map-layer', label: 'Map this column to…', icon: 'Link2', disabled: true, hint: map.refused, onClick: () => {} })
                }
                if (maps.length > 0) maps[maps.length - 1] = { ...maps[maps.length - 1], dividerAfter: true }
                result.push(...maps)
            }
            if (m.onNarrow) {
                result.push({
                    id: 'narrow-layer',
                    label: 'Narrow to this layer…',
                    icon: 'ScanSearch',
                    dividerAfter: true,
                    onClick: () => { m.onNarrow?.(); onClose() },
                })
            }
            if (m.onEditProperties) {
                result.push({
                    id: 'layer-edit-properties',
                    label: 'Change properties in this layer…',
                    icon: 'PencilLine',
                    dividerAfter: true,
                    onClick: () => { m.onEditProperties?.(); onClose() },
                })
            }
            if (m.canEdit) {
                result.push(
                    {
                        id: 'insert-left',
                        label: 'Insert layer to the left',
                        icon: 'BetweenVerticalStart',
                        onClick: () => { m.onInsert('left'); onClose() },
                    },
                    {
                        id: 'insert-right',
                        label: 'Insert layer to the right',
                        icon: 'BetweenVerticalEnd',
                        dividerAfter: true,
                        onClick: () => { m.onInsert('right'); onClose() },
                    },
                    {
                        id: 'rename-layer',
                        label: 'Rename',
                        icon: 'Pencil',
                        onClick: () => { m.onRename(); onClose() },
                    },
                    {
                        id: 'move-left',
                        label: 'Move left',
                        icon: 'ChevronLeft',
                        disabled: m.index <= 0,
                        onClick: () => { if (m.index > 0) { m.onMove(-1); onClose() } },
                    },
                    {
                        id: 'move-right',
                        label: 'Move right',
                        icon: 'ChevronRight',
                        disabled: m.index >= m.count - 1,
                        dividerAfter: true,
                        onClick: () => { if (m.index < m.count - 1) { m.onMove(1); onClose() } },
                    },
                )
            }
            if (m.onToggleFold) {
                result.push({
                    id: 'fold-layer',
                    label: m.folded ? 'Unfold layer' : 'Fold layer',
                    icon: m.folded ? 'UnfoldHorizontal' : 'FoldHorizontal',
                    dividerAfter: m.canEdit,
                    onClick: () => { m.onToggleFold?.(); onClose() },
                })
            }
            if (m.canEdit) {
                result.push({
                    id: 'delete-layer',
                    label: 'Delete layer',
                    icon: 'Trash2',
                    danger: true,
                    onClick: () => { m.onDelete(); onClose() },
                })
            } else if (m.onStartEditing) {
                result.push({
                    id: 'start-editing',
                    label: 'Start editing to change layers',
                    icon: 'PencilLine',
                    onClick: () => { m.onStartEditing?.(); onClose() },
                })
            }
        }

        // Add custom actions
        result.push(...customActions)

        return result
    }, [target, onEditNode, onDuplicateNode, onDuplicateWithOptions, onDeleteNode, onCreateChild, onTraceNode, onFocusConnections, onAskAboutNode, onExportNode,
        onCopyUrn, onConnect, onLinkNode, onEditEdge, onDeleteEdge, onReverseEdge, onCreateNode, createNodeInside, onPaste,
        onSelectAll, customActions, queryActions, guide, ownColumnFor, onMoveToParent, moveToParentHint, layerMenu, onClose, narrowActions.length, technical,
        viewOnly, trace, selectLayer, selectAllIn, expandActions])

    // Get icon component
    const getIcon = (iconName: keyof typeof LucideIcons) => {
        const IconComponent = LucideIcons[iconName] as React.ComponentType<{ className?: string }>
        return IconComponent ? <IconComponent className="w-4 h-4" /> : null
    }

    // Fit the menu in the window — measured before it paints, and again when its
    // contents change (a submenu opens) or the window is resized. Written straight
    // to the element: a measurement is not state, and the next paint needs it now.
    const { x, y } = position
    useLayoutEffect(() => {
        if (!isOpen || !target) return
        const place = () => {
            const menu = menuRef.current
            const list = listRef.current
            if (!menu || !list) return
            // Its natural height, whatever height it is held to now.
            const natural = menu.offsetHeight - list.clientHeight + list.scrollHeight
            const at = placeMenu({ x, y }, { width: menu.offsetWidth, height: natural },
                { width: window.innerWidth, height: window.innerHeight })
            menu.style.left = `${at.left}px`
            menu.style.top = `${at.top}px`
            menu.style.maxHeight = `${at.maxHeight}px`
            list.dataset.more = String(list.scrollTop + list.clientHeight < list.scrollHeight - 1)
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
    }, [isOpen, target, x, y, submenu])

    // A fade at the bottom edge while there is more below.
    const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const list = e.currentTarget
        list.dataset.more = String(list.scrollTop + list.clientHeight < list.scrollHeight - 1)
    }

    // In the document's body, not the canvas: no canvas transform shifts where it
    // sits, and no canvas pan or zoom takes the wheel that should scroll it. No
    // <AnimatePresence>: a portaled node must never outlive an interrupted exit
    // (src/__tests__/noStrandedPortalOverlays.test.ts) — it animates in, and is
    // gone the moment it closes.
    return createPortal(
        <>
            {isOpen && target && (
                <motion.div
                    ref={menuRef}
                    // Esc closes the menu first — and only the menu (a trace's own
                    // Esc, which leaves the trace, waits for it to be gone).
                    data-canvas-context-menu
                    initial={{ opacity: 0, scale: 0.95, y: -5 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ duration: 0.1 }}
                    className={cn(
                        "fixed z-[100] min-w-[200px] py-1.5 flex flex-col",
                        "bg-canvas-elevated/98 backdrop-blur-xl",
                        "border border-glass-border rounded-xl shadow-lg",
                        "overflow-hidden"
                    )}
                    style={{ left: x, top: y }}
                    // The wheel scrolls the menu, never the canvas behind it (React
                    // passes events up the component tree, portal or not).
                    onWheel={(e) => e.stopPropagation()}
                >
                    {/* Menu Header */}
                    {target.type === 'layer' && layerMenu ? (
                        <div className="flex-none px-3 pt-2 pb-2 border-b border-glass-border bg-black/5 dark:bg-white/5">
                            <span className="flex items-center gap-2 min-w-0">
                                <span className="w-2.5 h-2.5 rounded-full flex-none ring-2 ring-white/40 dark:ring-black/30" style={{ backgroundColor: layerMenu.color }} />
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted flex-none">Layer</span>
                                <span className="text-xs font-semibold text-ink truncate">{layerMenu.name}</span>
                            </span>
                            {/* Colour, one click — the layer's own colour ticked. */}
                            {layerMenu.canEdit && (
                                <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="Layer colour">
                                    {LAYER_COLORS.map((c) => {
                                        const on = c.toLowerCase() === layerMenu.color.toLowerCase()
                                        return (
                                            <button
                                                key={c}
                                                type="button"
                                                role="radio"
                                                aria-checked={on}
                                                aria-label={`Colour ${c}`}
                                                onClick={() => { layerMenu.onRecolor(c); onClose() }}
                                                className={cn(
                                                    'w-5 h-5 rounded-full grid place-items-center transition-transform hover:scale-110',
                                                    on && 'ring-2 ring-offset-2 ring-offset-canvas-elevated',
                                                )}
                                                style={{ backgroundColor: c, ...(on ? { ['--tw-ring-color' as string]: c } : {}) }}
                                            >
                                                {on && <LucideIcons.Check className="w-3 h-3 text-white" strokeWidth={3} />}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                            {!layerMenu.canEdit && !trace && (
                                <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                                    Layers change in a draft — start editing to insert, rename, recolour or move them.
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className="flex-none px-3 py-1.5 border-b border-glass-border bg-black/5 dark:bg-white/5">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                {showNarrowSubmenu && target.type === 'node' ? 'Narrow to this — how far?' :
                                    showLayerSubmenu && target.type === 'node' ? 'Move to Layer' :
                                    target.type === 'node' ? 'Node Actions' :
                                    target.type === 'edge' ? 'Edge Actions' : 'Canvas Actions'}
                            </span>
                        </div>
                    )}

                    {/* The items scroll under the header when the window is too short for them. */}
                    <div
                        ref={listRef}
                        onScroll={onListScroll}
                        className={cn(
                            "min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar",
                            "data-[more=true]:[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]",
                        )}
                    >
                    {/* Narrow submenu: one entry per reach */}
                    {showNarrowSubmenu && target.type === 'node' ? (
                        <div className="py-1" role="menu" aria-label="Narrow to this">
                            <button
                                onClick={() => setSubmenu(null)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                <LucideIcons.ChevronLeft className="w-3 h-3" />
                                Back
                            </button>
                            <div className="border-t border-glass-border my-1" />
                            {narrowActions.map((action) => (
                                <React.Fragment key={action.id}>
                                    <button
                                        role="menuitem"
                                        onClick={action.onClick}
                                        disabled={action.disabled}
                                        className={cn(
                                            "w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors",
                                            action.disabled
                                                ? "text-ink-muted cursor-not-allowed opacity-50"
                                                : "text-ink hover:bg-accent-lineage/10 hover:text-accent-lineage"
                                        )}
                                    >
                                        {getIcon(action.icon)}
                                        {action.label}
                                    </button>
                                    {action.dividerAfter && <div className="border-t border-glass-border my-1" />}
                                </React.Fragment>
                            ))}
                        </div>
                    ) : showLayerSubmenu && target.type === 'node' && guide ? (
                        // Guided: each column, with what choosing it changes — the view (a column to
                        // show it in) or the data (inside the entity a column is mapped to).
                        <div className="py-1 w-[300px] max-w-[calc(100vw-24px)]" role="menu" aria-label={`Where should ${guide.name} go?`}>
                            <button
                                onClick={() => setSubmenu(null)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                <LucideIcons.ChevronLeft className="w-3 h-3" />
                                Back
                            </button>
                            <div className="border-t border-glass-border my-1" />
                            <p className="px-3 pt-1 pb-1.5 text-[13px] font-semibold text-ink truncate">Where should {guide.name} go?</p>
                            {guide.choices.map((choice) => {
                                const KindIcon = COLUMN_KIND_ICON[choice.column]
                                const off = !!choice.hint
                                return (
                                    <button
                                        key={`${choice.layerId}:${choice.change}`}
                                        role="menuitem"
                                        disabled={off}
                                        data-move-choice={choice.change}
                                        onClick={() => {
                                            if (choice.change === 'data' && choice.parentId) onMoveInside?.(target.id, choice.parentId)
                                            else onMoveToLayer?.(target.id, choice.layerId)
                                            onClose()
                                        }}
                                        className={cn(
                                            "w-full flex items-start gap-2.5 px-3 py-1.5 text-left text-sm transition-colors",
                                            off ? "cursor-not-allowed" : "text-ink hover:bg-accent-lineage/10",
                                        )}
                                    >
                                        <span className={cn("mt-0.5 flex-none flex items-center gap-1", off && "opacity-50")} aria-hidden>
                                            <span className="w-2.5 h-2.5 rounded-full border border-white/20" style={{ backgroundColor: choice.color }} />
                                            <KindIcon className="w-3.5 h-3.5 text-ink-muted" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className={cn("block truncate", off ? "text-ink-muted" : "text-ink")}>{choice.label}</span>
                                            <span className="mt-1 flex items-center gap-1.5 min-w-0">
                                                <ChangeKindTag kind={choice.change} reach={guide.reach} className={cn("min-w-0", off && "opacity-60")} />
                                                {/* Kept readable on a disabled choice: it is the reason. */}
                                                {choice.hint && <span className="text-[11px] text-ink-muted truncate">{choice.hint}</span>}
                                            </span>
                                        </span>
                                    </button>
                                )
                            })}
                            <p className="px-3 pt-2 pb-1 mt-1 border-t border-glass-border text-[11px] leading-snug text-ink-muted">{guide.footer}</p>
                        </div>
                    ) : (
                        <div className="py-1">
                            {actions().map((action, index) => (
                                <React.Fragment key={action.id}>
                                    <div className="flex items-center">
                                    <button
                                        onClick={action.onClick}
                                        disabled={action.disabled}
                                        className={cn(
                                            "flex-1 min-w-0 flex items-center justify-between gap-3 px-3 py-2 text-sm transition-colors",
                                            action.disabled
                                                ? "text-ink-muted cursor-not-allowed"
                                                : action.danger
                                                    ? "text-red-500 hover:bg-red-500/10"
                                                    : "text-ink hover:bg-accent-lineage/10 hover:text-accent-lineage"
                                        )}
                                    >
                                        <span className="flex items-start gap-2.5 text-left">
                                            <span className={cn("mt-0.5 flex-none", action.disabled && "opacity-50")}>{getIcon(action.icon)}</span>
                                            <span className="min-w-0">
                                                <span className={cn("block", action.disabled && "opacity-50")}>{action.label}</span>
                                                {/* Kept readable on a disabled item: it is the reason. */}
                                                {action.hint && (
                                                    <span className="block max-w-[15rem] text-[11px] leading-snug text-ink-muted">{action.hint}</span>
                                                )}
                                                {action.change && <ChangeKindTag kind={action.change} className="mt-1" />}
                                            </span>
                                        </span>
                                        {action.shortcut && (
                                            <span className="text-[10px] text-ink-muted bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded font-mono">
                                                {action.shortcut}
                                            </span>
                                        )}
                                    </button>
                                    {action.toggle && (
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={action.toggle.checked}
                                            aria-label={action.toggle.label}
                                            onClick={() => action.toggle!.onChange(!action.toggle!.checked)}
                                            className={cn(
                                                "shrink-0 mr-2 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] font-medium transition-colors",
                                                "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5",
                                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40",
                                            )}
                                        >
                                            {action.toggle.label}
                                            <span className={cn(
                                                "relative inline-flex h-3.5 w-6 rounded-full transition-colors",
                                                action.toggle.checked ? "bg-accent-lineage" : "bg-black/15 dark:bg-white/20",
                                            )}>
                                                <span className={cn(
                                                    "absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform",
                                                    action.toggle.checked ? "translate-x-3" : "translate-x-0.5",
                                                )} />
                                            </span>
                                        </button>
                                    )}
                                    </div>
                                    {action.dividerAfter && index < actions().length - 1 && (
                                        <div className="border-t border-glass-border my-1" />
                                    )}
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                    </div>
                    {/* Why there is nothing to edit while a trace is on, and the way
                        out — instead of the menu simply going quiet about it. */}
                    {trace && (
                        <div className="flex-none flex items-center justify-between gap-3 px-3 pt-2 pb-1 mt-1 border-t border-glass-border">
                            <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                <LucideIcons.Lock className="w-3 h-3 flex-none" aria-hidden="true" />
                                {trace.editingPaused ? 'Editing is paused while tracing' : 'Viewing a trace'}
                            </span>
                            <button
                                type="button"
                                onClick={() => { trace.onExit(); onClose() }}
                                className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                            >
                                Exit trace
                            </button>
                        </div>
                    )}
                </motion.div>
            )}
        </>,
        document.body,
    )
}

export default CanvasContextMenu

