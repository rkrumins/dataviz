/**
 * HierarchyBuilderPanel — the right-rail Hierarchy Builder.
 *
 * Presentation follows the old UnifiedCreatePanel's quick-mode backbone — the
 * "ADDING (N) / Save to keep" outline card, a prominent always-visible
 * ENTITY TYPE list, a labeled DISPLAY NAME field, and a green + Add button —
 * with the outliner powers layered on top: Enter/Tab keyboard flow, per-row
 * retarget/rename/details/remove, containment-chain templates, and a
 * multi-line paste mode. All logic lives in {@link useHierarchyOutline}
 * (allowed types, edge auto-pick, blocking, staging, rename/details/remove) —
 * this panel only renders and forwards. It reads its scope
 * (parent/layer/type/mode/template) from {@link useHierarchyBuilderStore}.
 *
 * Note on accents: this repo defines no `accent-primary` color (the old
 * panel's `accent-primary` classes were dead no-ops). The real primary accent
 * is `accent-lineage`; the green Plus/Add CTA is kept from the old panel.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import type { LineageNode } from '@/store/canvas'
import { useWorkspacesStore } from '@/store/workspaces'
import {
  useViewEntityTypes,
  useViewRootEntityTypes,
  useViewEntityTypeHierarchyMap,
  useViewRelationshipTypes,
  useViewContainmentEdgeTypes,
} from '@/hooks/useViewSchema'
import {
  containmentChains,
  builderAllowedChildTypeIds,
  type AllowedEdgeOption,
} from '@/services/ontologyPreflightService'
import { relationshipLabel } from '@/lib/relationshipLabel'
import { useAppNotifications } from '@/components/ui/notifications'
import { boundFieldIds, useCanvasNodeIdentity } from '@/components/dataSource/NodeIdentity'
import { parseIndentedOutline, type ParsedOutlineRow, type OutlineParseContext } from './outlineParser'
import { useCreateLinkStore } from '../edge-create/createLinkStore'
import { useHierarchyBuilderStore } from './hierarchyBuilderStore'
import { ContinueAddingPill } from './ContinueAddingPill'
import { useHierarchyOutline, type OutlineRow } from './useHierarchyOutline'
import { childTypesLookup } from './resolveCreationScope'
import { ScopePickerPopover } from './ScopePicker'
import { article, useDismiss, useScopeName } from './scopePickerHooks'
import { usePersonaMode } from '@/store/persona'
import { useLayers } from '@/store/referenceModelStore'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

// ─── Local helpers (copied from UnifiedCreatePanel — it is deleted soon) ─────

/** Prefer the ontology's human label; fall back to a humanized id. Never a raw id. */
function relationshipText(o: AllowedEdgeOption): string {
  return o.label && o.label !== o.edgeType ? o.label : relationshipLabel(o.edgeType)
}

function DynamicIcon({ name, className, style }: { name?: string; className?: string; style?: React.CSSProperties }) {
  const Icon = name
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
    : undefined
  if (!Icon) return <LucideIcons.Box className={className} style={style} />
  return <Icon className={className} style={style} />
}

/** The ontology-colored icon chip shown wherever a type appears. */
function TypeChip({ type, size = 'sm' }: { type?: EntityTypeSchema; size?: 'xs' | 'sm' }) {
  const color = type?.visual?.color
  return (
    <span
      className={cn('rounded flex items-center justify-center flex-shrink-0', size === 'xs' ? 'w-4 h-4' : 'w-5 h-5')}
      style={{ backgroundColor: `${color}20`, color }}
    >
      <DynamicIcon name={type?.visual?.icon} className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
    </span>
  )
}

const splitTags = (s: string): string[] => s.split(',').map((t) => t.trim()).filter(Boolean)

/** How many of the scope's parents the "Or inside" row names; the picker has the rest. */
const QUICK_CHOICES = 4

/**
 * The entity types allowed directly under `parentType` (or root when null),
 * for the paste-preview type dropdown — the builder gate
 * ({@link builderAllowedChildTypeIds}), sorted by level then name.
 */
function allowedChildSchemas(
  parentType: string | null,
  entityTypes: EntityTypeSchema[],
  rootEntityTypes: string[],
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>,
  relationshipTypes: RelationshipTypeSchema[],
  containmentEdgeTypes: string[],
): EntityTypeSchema[] {
  const ids = builderAllowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes)
  return [...ids]
    .map((id) => entityTypes.find((et) => et.id === id))
    .filter((t): t is EntityTypeSchema => !!t)
    .sort((a, b) => a.hierarchy.level - b.hierarchy.level || a.name.localeCompare(b.name))
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface HierarchyBuilderPanelProps {
  onClose: () => void
  /** Fired per staged entity so the canvas can assign layers / expand parents. */
  onEntityStaged?: (tempUrn: string, parentUrn?: string) => void
}

export function HierarchyBuilderPanel({ onClose, onEntityStaged }: HierarchyBuilderPanelProps) {
  const isOpen = useHierarchyBuilderStore((s) => s.isOpen)
  const scopeParentUrn = useHierarchyBuilderStore((s) => s.parentUrn)
  const layerId = useHierarchyBuilderStore((s) => s.layerId)
  const initialTypeId = useHierarchyBuilderStore((s) => s.initialTypeId)
  const askParent = useHierarchyBuilderStore((s) => s.askParent)
  const scopeChoices = useHierarchyBuilderStore((s) => s.choices)
  const topLevelTypeId = useHierarchyBuilderStore((s) => s.topLevelTypeId)
  const batchId = useHierarchyBuilderStore((s) => s.batchId)
  const initialMode = useHierarchyBuilderStore((s) => s.initialMode)
  const initialTemplate = useHierarchyBuilderStore((s) => s.initialTemplate)
  const sessionAddedCount = useHierarchyBuilderStore((s) => s.sessionAddedCount)
  const suspended = useHierarchyBuilderStore((s) => s.suspended)

  const {
    tree, active, allowedTypes, edgeOptions, blockedReason, canCommit,
    setName, setType, setEdgeType, setDetails, setIdentifier, identifierUrn, identifierProblem,
    awaitingParent, retarget, placeAtTopLevel,
    commitSibling, commitAndNest, indent, outdent,
    renameRow, updateRowDetails, removeRow, descendantCount, stageRows,
  } = useHierarchyOutline({ scopeParentUrn, initialTypeId, askParent, onEntityStaged })
  // In the Playground a new entity may be given its identifier (its `id`, which a file's key of the
  // same value finds): offered beside its name.
  const nodeIdentity = useCanvasNodeIdentity()
  const inPlayground = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === nodeIdentity?.workspaceId)?.kind === 'playground')
  const identifierId = useId()

  const entityTypes = useViewEntityTypes()
  const rootEntityTypes = useViewRootEntityTypes()
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()
  const canvasNodes = useCanvasStore((s) => s.nodes)
  const { notify } = useAppNotifications()

  const typeById = useMemo(() => new Map(entityTypes.map((t) => [t.id, t])), [entityTypes])
  const activeType = active.typeId ? typeById.get(active.typeId) : undefined

  // Local UI state (view-only; all data lives in the hook / store).
  const [mode, setMode] = useState<'outline' | 'paste'>('outline')
  const [templateChain, setTemplateChain] = useState<string[] | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [typeQuery, setTypeQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [showParentPicker, setShowParentPicker] = useState(false)
  const [showEdgePicker, setShowEdgePicker] = useState(false)
  /** Committed row the single bottom details editor is bound to (null = the active row). */
  const [detailsRowUrn, setDetailsRowUrn] = useState<string | null>(null)
  const [blockFlash, setBlockFlash] = useState(0)
  const nameRef = useRef<HTMLInputElement>(null)
  /** The "where it goes" banner: the parent picker opens under it. */
  const scopeRef = useRef<HTMLDivElement>(null)
  const typeSearchRef = useRef<HTMLInputElement>(null)
  const typeListRef = useRef<HTMLDivElement>(null)
  const didInitialFocus = useRef(false)
  const focusTimer = useRef<number | null>(null)

  // ── Where things go: the scope's own parents, the top level, and what can hold what. ──
  const technical = usePersonaMode() === 'technical'
  const nameOf = useScopeName()
  const childTypes = useMemo(
    () => childTypesLookup(entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes),
    [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes],
  )
  const askedType = initialTypeId ? typeById.get(initialTypeId) : undefined
  const canHold = useCallback(
    (typeId: string) => (awaitingParent && initialTypeId ? childTypes(typeId).includes(initialTypeId) : childTypes(typeId).length > 0),
    [awaitingParent, initialTypeId, childTypes],
  )
  const layers = useLayers()
  const layerName = layerId ? layers.find((l) => l.id === layerId)?.name : undefined
  const topLevelType = topLevelTypeId ? typeById.get(topLevelTypeId) : undefined
  const topLevelLabel = topLevelType
    ? (technical ? `New top-level ${topLevelType.name}` : `A new ${topLevelType.name}, on its own`)
    : 'At the top level'
  const toTopLevel = useCallback(() => placeAtTopLevel(topLevelTypeId), [placeAtTopLevel, topLevelTypeId])

  const focusName = useCallback(() => {
    if (focusTimer.current) window.clearTimeout(focusTimer.current)
    focusTimer.current = window.setTimeout(() => nameRef.current?.focus(), 20)
  }, [])
  /** Cancel a scheduled focus — a click that becomes a rename must not steal it back. */
  const cancelFocusName = useCallback(() => {
    if (focusTimer.current) { window.clearTimeout(focusTimer.current); focusTimer.current = null }
  }, [])

  // Asked where it goes: the question is the first thing it shows, each time it is asked (set as
  // the batch is rendered, not after it).
  const [askedInBatch, setAskedInBatch] = useState<number | null>(null)
  if (askParent && askedInBatch !== batchId) {
    setAskedInBatch(batchId)
    setShowParentPicker(true)
  }

  // Sync mode/template from the store each time the panel is (re)opened.
  useEffect(() => {
    setMode(initialMode === 'paste' ? 'paste' : 'outline')
    setTemplateChain(initialTemplate && initialTemplate.length > 0 ? initialTemplate : null)
  }, [initialMode, initialTemplate])

  // Old-panel focus flow: open → the type search; returning to the outline
  // later (from paste/template) → the name input.
  useEffect(() => {
    if (mode !== 'outline' || templateChain) return
    const t = window.setTimeout(() => {
      if (didInitialFocus.current) {
        nameRef.current?.focus()
      } else if (useHierarchyBuilderStore.getState().askParent) {
        // The parent picker, open, has the focus: that question comes first.
        didInitialFocus.current = true
      } else if (typeSearchRef.current) {
        // Latch only on an ACTUAL focus — if the panel isn't rendered yet the
        // first real open must still get the type-search focus.
        typeSearchRef.current.focus()
        didInitialFocus.current = true
      }
    }, 60)
    return () => window.clearTimeout(t)
  }, [mode, templateChain])

  // The bound details row was removed (or cascaded away) — fall back to the active row.
  useEffect(() => {
    if (detailsRowUrn && !tree.some((r) => r.tempUrn === detailsRowUrn)) setDetailsRowUrn(null)
  }, [detailsRowUrn, tree])

  // A retarget/nest changes the allowed types — a stale query would hide the
  // auto-inferred pick, so reset the search with the parent.
  useEffect(() => {
    setTypeQuery('')
    setHighlighted(0)
  }, [active.parentUrn])

  // Keep the selected (possibly auto-inferred) type row visible in the list.
  useEffect(() => {
    if (!active.typeId) return
    typeListRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active.typeId])

  // ── Canvas selection while adding. A STAGED entity (one this session added) binds the details
  // editor right here, and re-scopes "Adding inside X" when it can hold children. Any other entity
  // is a look at what is already there: the builder steps aside — kept as it was, hidden — for
  // that entity's details, and Continue adding (or Add inside it) brings it back. Clicks are read
  // from `lastNodeClick` (every click, the same node again included, and in a view whose details
  // open on demand, where a click moves no drawer); other moves of the drawer (a palette jump, a
  // search Reveal) count the same. Only TRANSITIONS count — what was selected before the panel
  // opened, or while it stood aside, is ignored. ──
  const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
  const lastNodeClick = useCanvasStore((s) => s.lastNodeClick)
  const lastSeenDrawer = useRef(drawerNodeId)
  const lastSeenClickSeq = useRef(lastNodeClick.seq)
  useEffect(() => {
    const clicked = lastNodeClick.seq !== lastSeenClickSeq.current
    lastSeenClickSeq.current = lastNodeClick.seq
    const moved = drawerNodeId !== lastSeenDrawer.current
    lastSeenDrawer.current = drawerNodeId
    if (suspended) return
    const target = clicked ? lastNodeClick.nodeId : moved ? drawerNodeId : null
    if (!target) return
    const node = canvasNodes.find((n) => n.id === target || (n.data?.urn as string) === target)
    if (!node) return
    const urn = (node.data?.urn as string) || node.id
    if (tree.some((r) => r.tempUrn === urn)) {
      // Intentionally NO focusName() here: the click's intent is the details editor.
      setDetailsRowUrn(urn)
      if (((typeById.get(node.data?.type as string)?.hierarchy.canContain?.length) ?? 0) > 0) retarget(urn)
      return
    }
    useHierarchyBuilderStore.getState().suspend()
    useCanvasStore.getState().openNodeDrawer(node.id)
  }, [drawerNodeId, lastNodeClick, suspended, canvasNodes, tree, typeById, retarget])

  // Back from an entity's details: where it was, or inside the entity it was asked to add to.
  const wasSuspended = useRef(suspended)
  useEffect(() => {
    const resumed = wasSuspended.current && !suspended
    wasSuspended.current = suspended
    if (!resumed) return
    const to = useHierarchyBuilderStore.getState().takeRetarget()
    if (to) retarget(to)
    focusName()
  }, [suspended, retarget, focusName])
  // Closing the details it stepped aside for brings it back.
  const shownWhileAside = useRef<string | null>(null)
  useEffect(() => {
    if (!suspended) { shownWhileAside.current = null; return }
    if (drawerNodeId) shownWhileAside.current = drawerNodeId
    else if (shownWhileAside.current) useHierarchyBuilderStore.getState().resume()
  }, [suspended, drawerNodeId])
  // While it stands aside: the entity on show, and whether things can be added inside it.
  const asideNode = suspended && drawerNodeId
    ? canvasNodes.find((n) => n.id === drawerNodeId || (n.data?.urn as string) === drawerNodeId) : undefined
  const asideCanNest = !!asideNode && ((typeById.get(asideNode.data?.type as string)?.hierarchy.canContain?.length) ?? 0) > 0

  // Resolve where the next entity lands ("Adding inside X") from the active parent —
  // a staged row or a real canvas node.
  const parentInfo = useMemo(() => {
    if (!active.parentUrn) return null
    const row = tree.find((r) => r.tempUrn === active.parentUrn)
    if (row) return { name: row.name, typeId: row.typeId }
    const node = canvasNodes.find((n) => n.id === active.parentUrn || (n.data?.urn as string) === active.parentUrn)
    if (node) return { name: nameOf(node, (node.data?.label as string) || active.parentUrn), typeId: (node.data?.type as string) || null }
    return null
  }, [active.parentUrn, tree, canvasNodes, nameOf])

  // "Or inside …": at the top level, the scope's own parents one click away (those still here).
  const quickChoices = useMemo(() => {
    if (active.parentUrn || awaitingParent || scopeChoices.length === 0) return []
    const wanted = new Set(scopeChoices.map((c) => c.urn))
    const found = new Map<string, LineageNode>()
    for (const n of canvasNodes) {
      const urn = (n.data?.urn as string) || n.id
      if (wanted.has(urn)) found.set(urn, n)
      if (found.size === wanted.size) break
    }
    return scopeChoices.filter((c) => found.has(c.urn)).map((c) => ({
      urn: c.urn, typeId: c.typeId, name: nameOf(found.get(c.urn), c.urn),
    }))
  }, [active.parentUrn, awaitingParent, scopeChoices, canvasNodes, nameOf])
  const activeParentType = parentInfo?.typeId ?? null
  const parentType = activeParentType ? typeById.get(activeParentType) : undefined

  // Templates: only offered on an empty outline. When scoped to a parent, the
  // scaffold creates CHILDREN — the parent's own type is dropped from each
  // chain (brief Amendment 1). Chains that would be a single type aren't a
  // scaffold, so they're dropped.
  const chains = useMemo<string[][]>(() => {
    // Asked where things go: nothing scaffolds at the top level until that is answered.
    if (tree.length !== 0 || awaitingParent) return []
    const raw = containmentChains(entityTypes, rootEntityTypes, { startType: activeParentType ?? undefined })
      .map((c) => (activeParentType ? c.slice(1) : c))
    const seen = new Set<string>()
    const out: string[][] = []
    for (const c of raw) {
      if (c.length < 2) continue
      const key = c.join('>')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
      if (out.length >= 3) break
    }
    return out
  }, [tree.length, awaitingParent, entityTypes, rootEntityTypes, activeParentType])

  const parseCtx = useMemo<OutlineParseContext>(
    () => ({ entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, rootParentType: activeParentType }),
    [entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes, activeParentType],
  )

  const filteredTypes = useMemo(() => {
    if (!typeQuery.trim()) return allowedTypes
    const q = typeQuery.toLowerCase()
    return allowedTypes.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  }, [allowedTypes, typeQuery])

  const pickType = useCallback((id: string) => {
    setType(id)
    focusName()
  }, [setType, focusName])

  const onTypeSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((i) => Math.min(i + 1, filteredTypes.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filteredTypes[highlighted]) pickType(filteredTypes[highlighted].id) }
    else if (e.key === 'Escape') {
      e.preventDefault()
      if (typeQuery) setTypeQuery('')
      else onClose()
    }
  }, [filteredTypes, highlighted, pickType, typeQuery, onClose])

  const doAdd = useCallback(() => { commitSibling(); focusName() }, [commitSibling, focusName])
  const doAddNest = useCallback(() => { commitAndNest(); focusName() }, [commitAndNest, focusName])

  // Expand ⤢ — hand the same scope off to the wider Build Mode surface for
  // adding a lot at once. Carries the rail's ORIGINAL scope (scopeParentUrn/
  // layerId), not the outline's live `active.parentUrn` (which may have been
  // retargeted to a staged row) — Build's rootParentUrn must be a real canvas
  // urn or null.
  // Both carry the scope the rail was opened with, as it was resolved: its parent, starting type,
  // question and choices.
  const openedScope = useCallback(() => ({
    parentUrn: scopeParentUrn ?? undefined,
    layerId: layerId ?? undefined,
    initialTypeId: initialTypeId ?? undefined,
    askParent,
    choices: scopeChoices,
    topLevelTypeId: topLevelTypeId ?? undefined,
  }), [scopeParentUrn, layerId, initialTypeId, askParent, scopeChoices, topLevelTypeId])
  const expandToBuild = useCallback(() => {
    useHierarchyBuilderStore.getState().openBuild(openedScope())
  }, [openedScope])

  // "Start another set" — a fresh open() at the SAME original scope. Bumps
  // batchId (clears the ADDING list + re-scopes `active`) WITHOUT un-staging
  // anything already on the canvas — earlier batches stay in the draft.
  const startAnotherSet = useCallback(() => {
    useHierarchyBuilderStore.getState().open(openedScope())
  }, [openedScope])

  // ── Keyboard model (unchanged from v1). Tab routing is load-bearing:
  //    non-blank name → commitAndNest(); blank name → indent(). ──
  const onNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      // ⌥↵ always talks about the ACTIVE row — rebind first if a committed row is shown.
      if (detailsRowUrn) { setDetailsRowUrn(null); setDetailsOpen(true) }
      else setDetailsOpen((v) => !v)
      return
    }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); doAddNest(); return }
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); return }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (active.name.trim()) { doAddNest() }
      else if (!indent()) { setBlockFlash((n) => n + 1) }
      return
    }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); outdent(); return }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (detailsRowUrn) { setDetailsRowUrn(null); return }
      if (detailsOpen) { setDetailsOpen(false); return }
      if (active.name) { setName(''); return }
      onClose()
    }
  }, [active.name, doAdd, doAddNest, indent, outdent, detailsOpen, detailsRowUrn, setName, onClose])

  // A multi-line paste into the name input switches straight to paste mode.
  const onNamePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    if (text.includes('\n') && !awaitingParent) { e.preventDefault(); setPasteText(text); setMode('paste') }
  }, [awaitingParent])

  const detailsRow = detailsRowUrn ? (tree.find((r) => r.tempUrn === detailsRowUrn) ?? null) : null

  // Binding details (row action or canvas click) must be visible immediately —
  // the editor lives below the type list and can sit under the fold.
  const boundDetailsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (detailsRowUrn) boundDetailsRef.current?.scrollIntoView({ block: 'nearest' })
  }, [detailsRowUrn])

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        key="hierarchy-builder-panel"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 400 }}
        exit={{ opacity: 0, width: 0 }}
        className="relative h-full flex-shrink-0 overflow-hidden glass-panel border-l border-glass-border shadow-lg"
        // Stepped aside for an entity's details: kept as it was, out of sight and out of reach.
        hidden={suspended}
        inert={suspended}
      >
        <div className="w-[400px] h-full flex flex-col">
          {/* ── Header + scope banner ── */}
          <div className="flex-shrink-0 px-5 py-4 border-b border-glass-border bg-canvas-elevated/95">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <LucideIcons.Plus className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-ink">Add entities</h3>
                  <p className="text-xs text-ink-muted">Build the hierarchy — save when you&rsquo;re done</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={expandToBuild}
                  title="Expand to Build mode — add a lot at once"
                  aria-label="Expand to Build mode"
                  className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  <LucideIcons.Maximize2 className="w-4 h-4 text-ink-muted" />
                </button>
                <button onClick={onClose} title="Close" aria-label="Close" className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                  <LucideIcons.X className="w-5 h-5 text-ink-muted" />
                </button>
              </div>
            </div>

            <div ref={scopeRef} className="mt-3 relative" data-testid="builder-scope">
              {awaitingParent ? (
                <button
                  type="button"
                  onClick={() => setShowParentPicker(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-accent-lineage/40 bg-accent-lineage/[0.07] text-xs text-left hover:bg-accent-lineage/10 transition-colors"
                >
                  <LucideIcons.CornerDownRight className="w-3.5 h-3.5 flex-shrink-0 text-accent-lineage" />
                  <span className="min-w-0 flex-1 text-ink truncate">
                    {technical ? 'Choose a parent for' : 'Where does'} {article(askedType?.name ?? 'entity')}{' '}
                    <span className="font-semibold">{askedType?.name ?? 'entity'}</span>{technical ? '' : ' go?'}
                  </span>
                  <span className="text-[11px] font-medium text-accent-lineage flex-shrink-0">Choose</span>
                </button>
              ) : parentInfo ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs">
                  <TypeChip type={parentType} size="xs" />
                  <span className="min-w-0 flex-1 text-ink-muted truncate">
                    Adding inside <span className="font-semibold text-ink">{parentInfo.name}</span>
                    {technical && parentType && <span className="text-ink-muted"> · {parentType.name}</span>}
                  </span>
                  <button
                    onClick={toTopLevel}
                    title="Add at the top level instead"
                    aria-label="Add at the top level instead"
                    className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
                  >
                    <LucideIcons.X className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setShowParentPicker((v) => !v)} className="text-[11px] font-medium text-accent-lineage hover:underline flex-shrink-0">
                    Change
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 px-1 text-[11px] text-ink-muted">
                    <LucideIcons.Globe className="w-3 h-3 flex-shrink-0" />
                    <span className="flex-1">Adding at the top level</span>
                    <button onClick={() => setShowParentPicker((v) => !v)} className="font-medium text-accent-lineage hover:underline">
                      Change
                    </button>
                  </div>
                  {quickChoices.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-1 min-w-0" role="group" aria-label="Or add inside">
                      <span className="text-[11px] text-ink-muted flex-shrink-0">Or inside</span>
                      {quickChoices.slice(0, QUICK_CHOICES).map((c) => (
                        <button
                          key={c.urn}
                          type="button"
                          onClick={() => { retarget(c.urn); setShowParentPicker(false); focusName() }}
                          title={`Add inside ${c.name}`}
                          className="min-w-0 max-w-[150px] flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] text-[11px] text-ink hover:border-accent-lineage/50 hover:bg-accent-lineage/[0.06] transition-colors"
                        >
                          <TypeChip type={typeById.get(c.typeId)} size="xs" />
                          <span className="truncate">{c.name}</span>
                        </button>
                      ))}
                      {quickChoices.length > QUICK_CHOICES && (
                        <button
                          type="button"
                          onClick={() => setShowParentPicker(true)}
                          className="flex-shrink-0 text-[11px] font-medium text-accent-lineage hover:underline"
                        >
                          +{quickChoices.length - QUICK_CHOICES} more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {showParentPicker && (
                <ScopePickerPopover
                  anchorRef={scopeRef}
                  nodes={canvasNodes}
                  typeById={typeById}
                  canHold={canHold}
                  choices={scopeChoices}
                  choicesLabel={awaitingParent
                    ? `Can hold ${article(askedType?.name ?? 'entity')} ${askedType?.name ?? 'entity'}`
                    : layerName ? `In ${layerName}` : undefined}
                  emptyText={awaitingParent
                    ? `Nothing on the canvas can hold ${article(askedType?.name ?? 'entity')} ${askedType?.name ?? 'entity'} yet.`
                    : undefined}
                  topLevel={{ label: topLevelLabel, typeId: topLevelTypeId, onPick: () => { toTopLevel(); setShowParentPicker(false); focusName() } }}
                  selectedUrn={awaitingParent ? undefined : active.parentUrn}
                  onPick={(urn) => { retarget(urn); setShowParentPicker(false); focusName() }}
                  onClose={() => setShowParentPicker(false)}
                />
              )}
            </div>
          </div>

          {/* ── Body (mode switch) ── */}
          {mode === 'paste' ? (
            <PasteMode
              text={pasteText}
              setText={setPasteText}
              ctx={parseCtx}
              typeById={typeById}
              rootParentType={activeParentType}
              entityTypes={entityTypes}
              rootEntityTypes={rootEntityTypes}
              hierarchyMap={hierarchyMap}
              relationshipTypes={relationshipTypes}
              containmentEdgeTypes={containmentEdgeTypes}
              onAdd={() => {
                const n = stageRows(parseIndentedOutline(pasteText, parseCtx), active.parentUrn)
                notify('success', `Added ${n} items — save when you're done`)
                setPasteText('')
                setMode('outline')
              }}
              onBack={() => { setPasteText(''); setMode('outline') }}
            />
          ) : templateChain ? (
            <TemplateForm
              chain={templateChain}
              typeById={typeById}
              onCreate={(rows) => {
                const n = stageRows(rows, active.parentUrn)
                notify('success', `Added ${n} entities — save when you're done`)
                setTemplateChain(null)
              }}
              onBack={() => setTemplateChain(null)}
            />
          ) : (
            <>
              <div className="flex-1 overflow-y-auto p-5 space-y-5 custom-scrollbar">
                {/* ADDING (N) — the live outline of the CURRENT batch. Click a
                    row to add the next entity under it. Earlier batches this
                    session stay staged on the canvas but drop out of this
                    list once "Start another set" draws a new boundary. */}
                {tree.length > 0 ? (
                  <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-2">
                    <div className="flex items-center justify-between px-1 pb-1.5">
                      <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Adding ({tree.length})</span>
                      <span className="text-[10px] text-ink-muted/70">Save to keep</span>
                    </div>
                    <div className="max-h-40 overflow-y-auto custom-scrollbar">
                      <AnimatePresence initial={false}>
                        {tree.map((row) => {
                          const t = typeById.get(row.typeId)
                          return (
                            <AddingRow
                              key={row.tempUrn}
                              row={row}
                              type={t}
                              isTarget={active.parentUrn === row.tempUrn}
                              canNest={(t?.hierarchy.canContain?.length ?? 0) > 0}
                              descendants={descendantCount(row.tempUrn)}
                              detailsShown={detailsRowUrn === row.tempUrn}
                              onSelect={() => { retarget(row.tempUrn); focusName() }}
                              onRenameStart={cancelFocusName}
                              onToggleDetails={() => { setDetailsRowUrn((cur) => (cur === row.tempUrn ? null : row.tempUrn)) }}
                              onLink={(anchor) => useCreateLinkStore.getState().open({ sourceUrn: row.tempUrn, anchor })}
                              onRemove={() => removeRow(row.changeId)}
                              onRename={(name) => renameRow(row.tempUrn, name)}
                            />
                          )
                        })}
                      </AnimatePresence>
                    </div>
                  </div>
                ) : sessionAddedCount > 0 ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[11px] text-ink-muted">
                    <LucideIcons.CheckCircle2 className="w-3.5 h-3.5 text-accent-lineage/70 flex-shrink-0" />
                    <span>{sessionAddedCount} added this session — on the canvas</span>
                  </div>
                ) : null}

                {/* Templates — a scaffold to start from, only on an empty outline. */}
                {chains.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                      <LucideIcons.Sparkles className="w-3 h-3" />Start from a template
                    </div>
                    {chains.map((chain) => (
                      <button
                        key={chain.join('>')}
                        type="button"
                        onClick={() => setTemplateChain(chain)}
                        className="w-full flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-glass-border hover:border-accent-lineage/60 hover:bg-accent-lineage/5 hover:-translate-y-0.5 hover:shadow-md text-left transition-all duration-200"
                      >
                        <span className="flex items-center gap-1 flex-shrink-0">
                          {chain.map((id, i) => (
                            <React.Fragment key={id}>
                              {i > 0 && <LucideIcons.ChevronRight className="w-3 h-3 text-ink-muted/50" />}
                              <TypeChip type={typeById.get(id)} size="xs" />
                            </React.Fragment>
                          ))}
                        </span>
                        <span className="min-w-0 flex-1 text-xs text-ink truncate">
                          {chain.map((id) => typeById.get(id)?.name ?? id).join(' → ')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Entity type — the anchor: search + always-visible icon-rich list. */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                    Entity Type <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                      ref={typeSearchRef} type="text" value={typeQuery}
                      onChange={(e) => { setTypeQuery(e.target.value); setHighlighted(0) }}
                      onKeyDown={onTypeSearchKeyDown} placeholder="Search entity types..."
                      className="input w-full pl-10"
                    />
                  </div>
                  <div ref={typeListRef} className="max-h-[240px] overflow-y-auto custom-scrollbar space-y-1 mt-1">
                    {filteredTypes.map((t, i) => (
                      <button key={t.id} data-active={t.id === active.typeId || undefined} onClick={() => pickType(t.id)}
                        className={cn('w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
                          t.id === active.typeId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage'
                            : i === highlighted ? 'bg-black/5 dark:bg-white/5' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${t.visual?.color}20`, color: t.visual?.color }}>
                          <DynamicIcon name={t.visual?.icon} className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-ink truncate">{t.name}</div>
                          {t.description && <div className="text-[10px] text-ink-muted truncate">{t.description}</div>}
                        </div>
                        {t.id === active.typeId && <LucideIcons.Check className="w-4 h-4 text-accent-lineage" />}
                      </button>
                    ))}
                    {filteredTypes.length === 0 && <div className="text-center py-6 text-amber-500 text-xs">No entity types allowed here</div>}
                  </div>
                </div>

                {/* Relationship: a fixed plain phrase — never an edge-type label here.
                    Edge choices live only behind "Change". */}
                {awaitingParent ? (
                  <div className="flex items-start gap-1.5 px-1 text-[11px] text-ink-muted">
                    <LucideIcons.Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>Choose where it goes, above, to add it.</span>
                  </div>
                ) : blockedReason ? (
                  <motion.div
                    key={`blocked-${blockFlash}`}
                    initial={{ opacity: 0, x: 0 }}
                    animate={{ opacity: 1, x: [0, -3, 3, -2, 2, 0] }}
                    transition={{ duration: 0.15 }}
                    className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2"
                  >
                    <LucideIcons.AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>{blockedReason}</span>
                  </motion.div>
                ) : allowedTypes.length === 0 && parentInfo ? (
                  <div className="flex items-start gap-1.5 px-1 text-[11px] text-ink-muted">
                    <LucideIcons.CircleSlash className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>
                      Nothing more can go inside <span className="text-ink">{parentInfo.name}</span> — press{' '}
                      <kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">⇧⇥</kbd> to go back.
                    </span>
                  </div>
                ) : parentInfo && active.typeId ? (
                  <div className="relative flex items-center gap-1.5 px-1 text-[11px] text-ink-muted">
                    <LucideIcons.CornerDownRight className="w-3 h-3 flex-shrink-0 text-accent-lineage/70" />
                    <span>Inside <span className="font-medium text-ink">{parentInfo.name}</span></span>
                    {edgeOptions.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setShowEdgePicker((v) => !v)}
                        className="font-medium text-accent-lineage hover:underline"
                      >
                        Change
                      </button>
                    )}
                    <AnimatePresence>
                      {showEdgePicker && (
                        <EdgePickerPopover
                          options={edgeOptions}
                          selectedId={active.edgeType}
                          onPick={(id) => { setEdgeType(id); setShowEdgePicker(false) }}
                          onClose={() => setShowEdgePicker(false)}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                ) : null}

                {/* Name */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                    Display Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    ref={nameRef} type="text" value={active.name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={onNameKeyDown} onPaste={onNamePaste}
                    placeholder="Enter display name..." className="input w-full"
                  />
                </div>

                {inPlayground && (
                  <div className="space-y-1.5">
                    <label htmlFor={identifierId} className="flex items-center gap-1.5 text-xs font-medium text-ink-muted uppercase tracking-wider">
                      <LucideIcons.Fingerprint className="w-3.5 h-3.5" aria-hidden /> Identifier
                      <span className="normal-case tracking-normal font-normal text-ink-muted/70">· optional</span>
                    </label>
                    <input
                      id={identifierId} type="text" value={active.identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); doAdd() } }}
                      placeholder="e.g. orders_daily" spellCheck={false} autoComplete="off"
                      aria-invalid={!!identifierProblem || undefined} aria-describedby={`${identifierId}-hint`}
                      className={cn('input w-full font-mono text-[13px]', identifierProblem && 'border-rose-500/60')}
                    />
                    <p id={`${identifierId}-hint`} aria-live="polite"
                      className={cn('text-[11px] leading-snug', identifierProblem ? 'text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
                      {identifierProblem ?? (identifierUrn
                        ? <>Saved as <code className="font-mono text-ink-secondary">{identifierUrn}</code> — a file with this key finds it again.</>
                        : 'How files and connections name it. Left blank, one is made for it.')}
                    </p>
                  </div>
                )}

                {/* Details — ONE editor in ONE place: bound to a committed row via
                    its row action, or to the entity being typed. Never inline in
                    the ADDING list, never two open at once. */}
                {detailsRow ? (
                  <div ref={boundDetailsRef} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[11px] font-medium text-ink truncate">Details — {detailsRow.name}</span>
                      <button
                        type="button"
                        // Rebinds to the ACTIVE row AND opens its editor — symmetry with ⌥↵.
                        onClick={() => { setDetailsRowUrn(null); setDetailsOpen(true) }}
                        className="text-[11px] font-medium text-accent-lineage hover:underline flex-shrink-0"
                      >
                        Back to new entity
                      </button>
                    </div>
                    <RowDetails
                      key={detailsRow.tempUrn}
                      type={typeById.get(detailsRow.typeId)}
                      node={canvasNodes.find((n) => n.id === detailsRow.tempUrn || (n.data?.urn as string) === detailsRow.tempUrn)}
                      onSave={(v) => updateRowDetails(detailsRow.tempUrn, { description: v.description, tags: splitTags(v.tags), properties: v.fieldValues })}
                    />
                  </div>
                ) : (
                  <div>
                    <button
                      type="button"
                      onClick={() => setDetailsOpen((v) => !v)}
                      className="flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
                    >
                      {detailsOpen ? <LucideIcons.ChevronDown className="w-3 h-3" /> : <LucideIcons.ChevronRight className="w-3 h-3" />}
                      Add details
                      <span className="text-ink-muted/50">⌥↵</span>
                    </button>
                    <AnimatePresence>
                      {detailsOpen && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden"
                        >
                          <DetailsForm type={activeType} value={active.details} onChange={setDetails} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Action buttons — mouse parity with the keyboard flow. */}
                <div className="flex items-center gap-2">
                  <button
                    type="button" onClick={doAdd} disabled={!canCommit}
                    className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
                      canCommit ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed')}
                  >
                    <LucideIcons.Plus className="w-4 h-4" />Add
                  </button>
                  <button
                    type="button" onClick={doAddNest} disabled={!canCommit}
                    title="Add, then create the next entity inside it"
                    className="px-3 py-2 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    Add &amp; nest inside
                    <kbd className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">⇥</kbd>
                  </button>
                </div>

                {!awaitingParent && (
                  <button
                    type="button"
                    onClick={() => setMode('paste')}
                    className="flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink transition-colors"
                  >
                    <LucideIcons.ClipboardList className="w-3.5 h-3.5" />Paste a list
                  </button>
                )}
              </div>

              {/* ── Footer ── */}
              <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
                <span className="text-[10px] text-ink-muted">
                  <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">↵</kbd> add ·{' '}
                  <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">⇥</kbd> add inside ·{' '}
                  <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">⇧⇥</kbd> back out
                </span>
                <div className="flex items-center gap-2">
                  {tree.length > 0 && <span className="text-[10px] text-ink-muted">{tree.length} staged · Save when you&rsquo;re done</span>}
                  <button
                    type="button"
                    onClick={startAnotherSet}
                    title="Keep everything staged and start a new set"
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-sm shadow-accent-lineage/30 transition-colors flex items-center gap-1.5"
                  >
                    <LucideIcons.RefreshCw className="w-3.5 h-3.5" />
                    Start another set
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </motion.div>
      {suspended && (
        <ContinueAddingPill key="continue-adding" added={sessionAddedCount}
          insideName={asideCanNest ? String(asideNode?.data?.label ?? '') || null : null}
          onContinue={() => useHierarchyBuilderStore.getState().resume()}
          onAddInside={asideNode ? () => useHierarchyBuilderStore.getState().resume({ parentUrn: (asideNode.data?.urn as string) || asideNode.id }) : undefined}
          onDone={onClose} />
      )}
    </AnimatePresence>
  )
}

// ─── ADDING (N) outline row ──────────────────────────────────────────────────

type DetailsValue = { description: string; tags: string; fieldValues: Record<string, unknown> }

function AddingRow({
  row, type, isTarget, canNest, descendants, detailsShown,
  onSelect, onRenameStart, onToggleDetails, onLink, onRemove, onRename,
}: {
  row: OutlineRow
  type?: EntityTypeSchema
  isTarget: boolean
  canNest: boolean
  descendants: number
  detailsShown: boolean
  onSelect: () => void
  /** Fired when a double-click opens the rename editor, BEFORE it mounts. */
  onRenameStart: () => void
  onToggleDetails: () => void
  /** Open the "Link to…" popover for this row, anchored at the given viewport point. */
  onLink: (anchor: { x: number; y: number }) => void
  onRemove: () => void
  onRename: (name: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(row.name)
  const rowRef = useRef<HTMLDivElement>(null)

  const commitRename = () => {
    const name = draft.trim()
    if (name && name !== row.name) onRename(name)
    else setDraft(row.name)
    setRenaming(false)
  }

  const actionCls = cn('p-0.5 rounded text-ink-muted transition-all',
    isTarget ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100')

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
      <div
        ref={rowRef}
        className={cn('group/row flex items-center gap-1.5 rounded-md pr-1 py-1 transition-colors',
          isTarget ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/40' : 'hover:bg-black/5 dark:hover:bg-white/5')}
        style={{ paddingLeft: 6 + row.depth * 14 }}
      >
        <TypeChip type={type} size="xs" />
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              else if (e.key === 'Escape') { e.preventDefault(); setDraft(row.name); setRenaming(false) }
            }}
            className="flex-1 min-w-0 bg-transparent text-[12px] text-ink focus:outline-none border-b border-accent-lineage/50"
          />
        ) : (
          <button
            // A double-click is click→click→dblclick: only the FIRST click may
            // retarget (e.detail === 1), and the rename must cancel any focus
            // still scheduled by it — otherwise the 20ms focus timer would blur
            // (and close) the rename editor as it mounts.
            onClick={(e) => { if (e.detail === 1) onSelect() }}
            onDoubleClick={() => { onRenameStart(); setDraft(row.name); setRenaming(true) }}
            title="Add the next entity under this one — double-click to rename"
            className="flex-1 min-w-0 text-left"
          >
            <span className="block text-[12px] text-ink truncate">{row.name}</span>
          </button>
        )}
        {row.hasDetails && <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage/60 flex-shrink-0" title="Has details" />}

        {canNest && (
          <button onClick={onSelect} title="Add a child" aria-label="Add a child" className={cn(actionCls, 'hover:text-accent-lineage')}>
            <LucideIcons.CornerDownRight className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => {
            const rect = rowRef.current?.getBoundingClientRect()
            onLink(rect ? { x: rect.right + 8, y: rect.top } : { x: window.innerWidth / 2, y: window.innerHeight / 2 })
          }}
          title={`Link ${row.name} to…`}
          aria-label={`Link ${row.name} to…`}
          className={cn(actionCls, 'hover:text-accent-lineage')}
        >
          <LucideIcons.Link2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={onToggleDetails} title="Details" aria-label="Details" className={cn(actionCls, detailsShown ? 'opacity-100 text-accent-lineage' : 'hover:text-ink')}>
          <LucideIcons.SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRemove}
          title={descendants > 0 ? `Removes ${descendants} nested item${descendants === 1 ? '' : 's'} too` : 'Remove'}
          aria-label="Remove"
          className={cn(actionCls, 'hover:text-rose-500')}
        >
          <LucideIcons.X className="w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

/** Committed-row details — seeded from the staged node, saved on blur/change. */
function RowDetails({ type, node, onSave }: { type?: EntityTypeSchema; node?: LineageNode; onSave: (v: DetailsValue) => void }) {
  const identity = useCanvasNodeIdentity()
  const customFields = useMemo(
    () => {
      const bound = boundFieldIds(identity)
      return type ? type.fields.filter((f) => f.showInPanel && !bound.has(f.id) && !['description', 'urn'].includes(f.id)) : []
    },
    [type, identity],
  )
  const initial = useMemo<DetailsValue>(() => {
    const props = (node?.data?.properties ?? {}) as Record<string, unknown>
    const fieldValues: Record<string, unknown> = {}
    for (const f of customFields) if (f.id in props) fieldValues[f.id] = props[f.id]
    return {
      // A node field; rows staged before it was one kept it among the properties.
      description: (node?.data?.description as string | undefined) ?? (props.description as string | undefined) ?? '',
      tags: (node?.data?.classifications ?? []).join(', '),
      fieldValues,
    }
  }, [node, customFields])

  const [value, setValue] = useState<DetailsValue>(initial)
  return <DetailsForm type={type} value={value} onChange={setValue} commitOnBlur={onSave} />
}

/**
 * Shared details editor: description, tags, and the type's custom schema fields.
 * Controlled via `value`/`onChange`. When `commitOnBlur` is set (committed rows)
 * text fields save on blur and toggles save immediately; without it (the active
 * row) the hook holds the values until the row is staged.
 */
function DetailsForm({
  type, value, onChange, commitOnBlur,
}: {
  type?: EntityTypeSchema
  value: DetailsValue
  onChange: (v: DetailsValue) => void
  commitOnBlur?: (v: DetailsValue) => void
}) {
  const identity = useCanvasNodeIdentity()
  const customFields = useMemo(
    () => {
      const bound = boundFieldIds(identity)
      return (type ? type.fields.filter((f) => f.showInPanel && !bound.has(f.id) && !['description', 'urn'].includes(f.id)) : [])
        .sort((a, b) => a.displayOrder - b.displayOrder)
    },
    [type, identity],
  )
  const patch = (p: Partial<DetailsValue>) => onChange({ ...value, ...p })

  return (
    <div className="space-y-2.5 pt-2">
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-ink-muted">Description</label>
        <textarea
          value={value.description}
          onChange={(e) => patch({ description: e.target.value })}
          onBlur={() => commitOnBlur?.(value)}
          rows={2}
          placeholder="What is this?"
          className="input w-full resize-none"
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] font-medium text-ink-muted">Tags</label>
        <input
          value={value.tags}
          onChange={(e) => patch({ tags: e.target.value })}
          onBlur={() => commitOnBlur?.(value)}
          placeholder="tag1, tag2"
          className="input w-full"
        />
        <p className="text-[10px] text-ink-muted">Separate tags with commas</p>
      </div>
      {customFields.map((field) => (
        <div key={field.id} className="space-y-1">
          <label className="text-[10px] text-ink-muted">
            {field.name}{field.required && <span className="text-red-400 ml-1">*</span>}
          </label>
          {field.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!value.fieldValues[field.id]}
                onChange={(e) => {
                  const next = { ...value, fieldValues: { ...value.fieldValues, [field.id]: e.target.checked } }
                  onChange(next)
                  commitOnBlur?.(next)
                }}
                className="rounded"
              />
              <span className="text-xs text-ink">{field.name}</span>
            </label>
          ) : field.type === 'number' ? (
            <input
              type="number"
              value={(value.fieldValues[field.id] as number) ?? ''}
              onChange={(e) => patch({ fieldValues: { ...value.fieldValues, [field.id]: parseFloat(e.target.value) || 0 } })}
              onBlur={() => commitOnBlur?.(value)}
              className="input w-full"
            />
          ) : (
            <input
              type="text"
              value={(value.fieldValues[field.id] as string) ?? ''}
              onChange={(e) => patch({ fieldValues: { ...value.fieldValues, [field.id]: e.target.value } })}
              onBlur={() => commitOnBlur?.(value)}
              className="input w-full"
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Popovers ────────────────────────────────────────────────────────────────

function TypeChipDropdown({
  types, selectedId, onPick, onClose,
}: {
  types: EntityTypeSchema[]
  selectedId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  useDismiss(ref, onClose)
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    if (!q.trim()) return types
    const s = q.toLowerCase()
    return types.filter((t) => t.name.toLowerCase().includes(s) || t.id.toLowerCase().includes(s))
  }, [types, q])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) onPick(filtered[hi].id) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute left-0 top-full mt-1 z-50 w-[260px] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-2 border-b border-glass-border">
        <div className="relative">
          <LucideIcons.Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
          <input ref={searchRef} value={q} onChange={(e) => { setQ(e.target.value); setHi(0) }} onKeyDown={onKeyDown} placeholder="Search types…" className="input w-full pl-8 text-sm" />
        </div>
      </div>
      <div className="max-h-[240px] overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
        {filtered.length === 0 && <div className="text-center py-5 text-[11px] text-amber-500">No types allowed here.</div>}
        {filtered.map((t, i) => (
          <button
            key={t.id}
            onClick={() => onPick(t.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
              t.id === selectedId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/40' : i === hi ? 'bg-black/5 dark:bg-white/5' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <TypeChip type={t} size="sm" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-ink truncate">{t.name}</span>
              {t.description && <span className="block text-[10px] text-ink-muted truncate">{t.description}</span>}
            </span>
            {t.id === selectedId && <LucideIcons.Check className="w-3.5 h-3.5 text-accent-lineage flex-shrink-0" />}
          </button>
        ))}
      </div>
    </motion.div>
  )
}

function EdgePickerPopover({
  options, selectedId, onPick, onClose,
}: {
  options: AllowedEdgeOption[]
  selectedId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute left-0 top-full mt-1 z-50 w-[260px] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden p-1.5 space-y-1"
    >
      {options.map((o) => (
        <button
          key={o.edgeType}
          type="button"
          onClick={() => onPick(o.edgeType)}
          className={cn(
            'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors',
            selectedId === o.edgeType ? 'border-accent-lineage bg-accent-lineage/5' : 'border-glass-border hover:border-ink-muted/50',
          )}
        >
          <span className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 grid place-items-center', selectedId === o.edgeType ? 'border-accent-lineage' : 'border-ink-muted/40')}>
            {selectedId === o.edgeType && <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink truncate">{relationshipText(o)}</span>
            {o.description && <span className="block text-[10px] text-ink-muted truncate">{o.description}</span>}
          </span>
        </button>
      ))}
    </motion.div>
  )
}

// ─── Template fill-names form ────────────────────────────────────────────────

function TemplateForm({
  chain, typeById, onCreate, onBack,
}: {
  chain: string[]
  typeById: Map<string, EntityTypeSchema>
  onCreate: (rows: ParsedOutlineRow[]) => void
  onBack: () => void
}) {
  const [names, setNames] = useState<string[]>(() => chain.map((id) => `New ${typeById.get(id)?.name ?? id}`))
  const refs = useRef<(HTMLInputElement | null)[]>([])
  useEffect(() => { refs.current[0]?.focus(); refs.current[0]?.select() }, [])

  const submit = () => {
    const rows: ParsedOutlineRow[] = chain.map((id, i) => ({
      name: names[i].trim() || `New ${typeById.get(id)?.name ?? id}`,
      typeId: id,
      explicitType: true,
      depth: i,
      issues: [],
    }))
    onCreate(rows)
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-5 space-y-3 custom-scrollbar">
        <p className="text-xs text-ink-muted">Name each level, then create the whole branch at once.</p>
        {chain.map((id, i) => {
          const t = typeById.get(id)
          return (
            <div key={`${id}-${i}`} className="space-y-1" style={{ marginLeft: i * 14 }}>
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
                <TypeChip type={t} size="xs" />{t?.name ?? id}
              </label>
              <input
                ref={(el) => { refs.current[i] = el }}
                value={names[i]}
                onChange={(e) => setNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); if (i < chain.length - 1) refs.current[i + 1]?.focus(); else submit() }
                  else if (e.key === 'Escape') { e.preventDefault(); onBack() }
                }}
                className="input w-full text-sm"
              />
            </div>
          )
        })}
      </div>
      <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors">
          Back
        </button>
        <button type="button" onClick={submit} className="px-4 py-2 rounded-lg text-sm font-semibold bg-green-500 text-white hover:bg-green-600 shadow-sm transition-colors flex items-center gap-2">
          <LucideIcons.Plus className="w-4 h-4" />Create {chain.length} entities
        </button>
      </div>
    </>
  )
}

// ─── Paste mode ──────────────────────────────────────────────────────────────

const PASTE_PLACEHOLDER = 'Sales Domain\n  Customers Platform\n    Orders Dataset'

function PasteMode({
  text, setText, ctx, typeById, rootParentType,
  entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes,
  onAdd, onBack,
}: {
  text: string
  setText: (t: string) => void
  ctx: OutlineParseContext
  typeById: Map<string, EntityTypeSchema>
  rootParentType: string | null
  entityTypes: EntityTypeSchema[]
  rootEntityTypes: string[]
  hierarchyMap: Record<string, { canContain?: string[]; canBeContainedBy?: string[] }>
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  onAdd: () => void
  onBack: () => void
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [openTypeRow, setOpenTypeRow] = useState<number | null>(null)
  useEffect(() => { areaRef.current?.focus() }, [])

  const parsed = useMemo(() => parseIndentedOutline(text, ctx), [text, ctx])
  const stageable = parsed.filter((r) => r.issues.length === 0 && r.typeId).length

  // Map each parsed row back to its (non-blank) source line so a type pick can
  // rewrite that line — the textarea stays the single source of truth.
  const lineIndex = useMemo(() => {
    const out: number[] = []
    text.split('\n').forEach((l, i) => { if (l.trim().length > 0) out.push(i) })
    return out
  }, [text])

  // Parent type at each row (from resolved ancestors) → the row's plausible types.
  const parentTypeAt = useMemo(() => {
    const out: (string | null)[] = []
    const lastAtDepth: (string | null)[] = []
    for (const r of parsed) {
      out.push(r.depth === 0 ? rootParentType : (lastAtDepth[r.depth - 1] ?? null))
      lastAtDepth[r.depth] = r.typeId
    }
    return out
  }, [parsed, rootParentType])

  const rewriteType = (rowIdx: number, typeId: string) => {
    const li = lineIndex[rowIdx]
    if (li === undefined) return
    const lines = text.split('\n')
    const leading = /^\s*/.exec(lines[li])?.[0] ?? ''
    lines[li] = `${leading}${typeById.get(typeId)?.name ?? typeId}: ${parsed[rowIdx].name}`
    setText(lines.join('\n'))
    setOpenTypeRow(null)
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-5 space-y-3 custom-scrollbar">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
          <LucideIcons.ClipboardList className="w-3 h-3" />Paste a list
        </div>
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={PASTE_PLACEHOLDER}
          className="input w-full resize-none font-mono text-xs leading-relaxed"
        />
        <p className="text-[10px] text-ink-muted">Indent with spaces or tabs to nest. Prefix a line with <span className="font-mono">Type:</span> to set its type.</p>

        {parsed.length > 0 && (
          <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-1.5 space-y-0.5">
            {parsed.map((r, i) => {
              const t = r.typeId ? typeById.get(r.typeId) : undefined
              const issue = r.issues[0]
              return (
                <div key={i} className="relative">
                  <div
                    className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-1', issue && 'bg-rose-500/10')}
                    style={{ paddingLeft: 6 + r.depth * 14 }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenTypeRow((cur) => (cur === i ? null : i))}
                      title="Set type"
                      aria-label="Set type"
                      className="flex items-center gap-1 rounded hover:bg-black/5 dark:hover:bg-white/5 flex-shrink-0"
                    >
                      {t ? <TypeChip type={t} size="xs" /> : <span className="w-4 h-4 rounded flex items-center justify-center bg-ink-muted/10 text-ink-muted text-[10px]">?</span>}
                      <LucideIcons.ChevronDown className="w-2.5 h-2.5 text-ink-muted" />
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-[12px] truncate', issue ? 'text-rose-600 dark:text-rose-400' : 'text-ink')}>{r.name || '(unnamed)'}</span>
                      {issue && <span className="block text-[10px] text-rose-500 truncate">{issue}</span>}
                    </span>
                  </div>
                  <AnimatePresence>
                    {openTypeRow === i && (
                      <TypeChipDropdown
                        types={allowedChildSchemas(parentTypeAt[i], entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes)}
                        selectedId={r.typeId}
                        onPick={(id) => rewriteType(i, id)}
                        onClose={() => setOpenTypeRow(null)}
                      />
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors">
          Back
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={stageable === 0}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
            stageable > 0 ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed',
          )}
        >
          <LucideIcons.Plus className="w-4 h-4" />Add {stageable} item{stageable === 1 ? '' : 's'}
        </button>
      </div>
    </>
  )
}

export default HierarchyBuilderPanel
