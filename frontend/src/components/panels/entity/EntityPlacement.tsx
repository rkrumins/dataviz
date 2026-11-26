/**
 * Where an entity sits in the hierarchy.
 *
 * `PlacementSummary` is the calm, read-only view ("Part of Sales · Contains 12 items"), one click
 * from the parent. `PlacementEditor` is Edit mode's: change how it relates to its parent, or move
 * it under another (or on its own, at the top) — both staged through `useReparentNode`
 * (ontology-checked, reviewed on save), for an entity new in this draft as for a saved one. The move
 * list is a search, not a native select of every loaded entity, and is built only when opened. A
 * move changes the data, and the section says so: the tag, and who it reaches. The entity menu's
 * "Move to another parent…" dialog (MoveParentDialog) offers the same search.
 */
import { useId, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CornerLeftUp, CornerRightDown, Home, Info, MoveRight, Network } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useReparentNode } from '@/components/canvas/context-view/useReparentNode'
import { ChangeKindTag } from '@/components/canvas/context-view/DropHint'
import { NO_REACH, moveReachLine } from '@/components/canvas/context-view/changeKind'
import { moveHost } from '@/store/canvasLayoutBridge'
import { parentPlacementPhrase, relationshipLabel } from '@/lib/relationshipLabel'
import { Button } from '@/components/ui/Button'
import { Section } from '../DrawerSection'
import { useContainmentParent, useMoveTargets } from './useContainment'
import { EntitySearchPicker, type PickerOption } from './EntitySearchPicker'

export function PlacementSummary({ nodeId, childCount, onFocusNode }: {
  nodeId: string
  childCount: number
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
}) {
  const { node, parentNode, parentName, currentEdgeType, childCountLoaded } = useContainmentParent(nodeId)
  if (!node) return null
  const childrenTotal = Math.max(childCount ?? 0, childCountLoaded)

  // The drawer and the selection move to the parent at once (held while there are unsaved
  // edits, like any move), then the canvas reveals it.
  const goToParent = () => {
    if (!parentNode) return
    useCanvasStore.getState().requestDrawerMove(() => {
      const s = useCanvasStore.getState()
      s.openNodeDrawer(parentNode.id)
      s.selectNode(parentNode.id)
      void onFocusNode?.(parentNode.id)
    })
  }

  return (
    <Section title="Relationship" icon={Network} collapsible sectionKey="relationship">
      <div className="space-y-2">
        {parentNode ? (
          <button
            type="button"
            onClick={goToParent}
            aria-label={`Go to ${parentName}`}
            className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] hover:bg-black/[0.07] dark:hover:bg-white/[0.08] transition-colors duration-150 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
          >
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent-lineage/10 text-accent-lineage shrink-0">
              <CornerLeftUp className="w-4 h-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-ink-muted">{parentPlacementPhrase(currentEdgeType)}</span>
              <span className="block text-sm font-medium text-ink truncate">{parentName}</span>
            </span>
            <ArrowUpRight className="w-3.5 h-3.5 text-ink-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150 shrink-0" aria-hidden />
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-black/[0.05] dark:bg-white/10 text-ink-muted shrink-0">
              <Home className="w-4 h-4" aria-hidden />
            </span>
            <span className="text-sm text-ink-muted">Top-level item</span>
          </div>
        )}
        {childrenTotal > 0 && (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05]">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
              <CornerRightDown className="w-4 h-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-ink-muted">Contains</span>
              <span className="block text-sm font-medium text-ink">
                {childrenTotal.toLocaleString()} {childrenTotal === 1 ? 'item' : 'items'}
              </span>
            </span>
          </div>
        )}
      </div>
    </Section>
  )
}

export function PlacementEditor({ nodeId }: { nodeId: string }) {
  const { reparent, moveToTopLevel, topLevelVerdict, retypeContainment } = useReparentNode()
  const { node, parentNode, parentName, currentEdgeType, relTypeOptions } = useContainmentParent(nodeId)
  const inDraft = useBranchStore((s) => !!s.currentBranchId)
  const relId = useId()
  if (!node) return null
  // Offered where the ontology lets its type stand alone, and it is not at the top already. Asked
  // only once the picker is open: the drawer does no move work until then.
  const canStandAlone = () => !!parentNode && topLevelVerdict(nodeId).kind === 'data'
  // Who a move reaches: the other views on the canvas's data source.
  const reach = moveHost()?.reach?.() ?? NO_REACH

  return (
    <div className="pt-5 border-t border-glass-border">
      <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4 flex items-center gap-2">
        <Network className="w-3.5 h-3.5" aria-hidden />
        Relationship
      </h4>
      {!inDraft ? (
        <div className="px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs flex items-start gap-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
          <span>Switch to a draft to change where this entity sits or how it relates to its parent.</span>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <span className="text-xs text-ink-muted">Currently</span>
            <span className="text-xs text-ink text-right font-medium break-words">
              {parentNode ? `${parentPlacementPhrase(currentEdgeType)} ${parentName}` : 'Top-level item'}
            </span>
          </div>
          {parentNode && (
            <div className="space-y-1.5">
              <label htmlFor={relId} className="text-xs font-semibold text-ink-muted">How it relates</label>
              <select
                id={relId}
                value={currentEdgeType}
                onChange={(e) => retypeContainment(nodeId, e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] border border-glass-border focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm text-ink"
              >
                {!relTypeOptions.some((o) => o.edgeType === currentEdgeType) && (
                  <option value={currentEdgeType}>{relationshipLabel(currentEdgeType)}</option>
                )}
                {relTypeOptions.map((o) => <option key={o.edgeType} value={o.edgeType}>{o.label}</option>)}
              </select>
              <p className="text-[11px] text-ink-muted">How this entity belongs to {parentName}.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-ink-muted">Move to a different parent</span>
            <ChangeKindTag kind="data" reach={reach} />
            <p className="text-[11px] leading-snug text-ink-muted">{moveReachLine(reach)}</p>
            <MoveTargetPicker nodeId={nodeId} onPick={(parentId) => reparent(nodeId, parentId)}
              canStandAlone={canStandAlone} onTop={() => moveToTopLevel(nodeId)} />
          </div>
        </div>
      )}
    </div>
  )
}

/** The picker's first option: no parent at all. Not an entity id. */
const TOP = '\u0000top'
const TOP_LABEL = 'On its own, at the top'

/** "Move to a different parent": a search over the entities that can contain this one — and, where
 *  its type may stand alone (`canStandAlone`), no parent at all (`onTop`). The drawer's opens on a
 *  click; the move dialog's is open at once (`defaultOpen`), and its Cancel closes the dialog. */
export function MoveTargetPicker({ nodeId, onPick, canStandAlone, onTop, defaultOpen = false, onCancel }: {
  nodeId: string
  onPick: (parentId: string) => void
  canStandAlone: () => boolean
  onTop: () => void
  defaultOpen?: boolean
  /** Cancel (and Esc) — instead of folding the search away. */
  onCancel?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const targets = useMoveTargets(nodeId, open)
  const inputRef = useRef<HTMLInputElement>(null)

  const topOffered = open && canStandAlone()
  const options = useMemo((): PickerOption[] => [
    ...(topOffered ? [{ id: TOP, label: TOP_LABEL, badge: 'No parent', icon: Home, keywords: `${TOP_LABEL} top level`, separated: true }] : []),
    ...targets.map((t) => ({ id: t.id, label: t.label, badge: t.type })),
  ], [targets, topOffered])

  const close = () => setOpen(false)
  const pick = (id: string) => {
    close()
    if (id === TOP) onTop()
    else onPick(id)
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" leftIcon={MoveRight} onClick={() => { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()) }}>
        Choose a new parent…
      </Button>
    )
  }

  return (
    <EntitySearchPicker
      options={options}
      onPick={pick}
      onCancel={onCancel ?? close}
      searchLabel="Search for a new parent"
      listLabel="Possible parents"
      placeholder={`Search ${targets.length.toLocaleString()} possible parents…`}
      emptyText="Nothing in this view can contain this one."
      autoFocus={defaultOpen}
      inputRef={inputRef}
    />
  )
}
