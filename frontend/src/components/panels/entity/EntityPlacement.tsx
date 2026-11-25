/**
 * Where an entity sits in the hierarchy.
 *
 * `PlacementSummary` is the calm, read-only view ("Part of Sales · Contains 12 items"), one click
 * from the parent. `PlacementEditor` is Edit mode's: change how it relates to its parent, or move
 * it under another (or on its own, at the top) — both staged through `useReparentNode`
 * (ontology-checked, reviewed on save), for an entity new in this draft as for a saved one. The move
 * list is a search, not a native select of every loaded entity, and is built only when opened.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, CornerLeftUp, CornerRightDown, Home, Info, MoveRight, Network, Search } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useReparentNode } from '@/components/canvas/context-view/useReparentNode'
import { parentPlacementPhrase, relationshipLabel } from '@/lib/relationshipLabel'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Section } from '../DrawerSection'
import { useContainmentParent, useMoveTargets } from './useContainment'

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
          <MoveTargetPicker nodeId={nodeId} onPick={(parentId) => reparent(nodeId, parentId)}
            canStandAlone={canStandAlone} onTop={() => moveToTopLevel(nodeId)} />
        </div>
      )}
    </div>
  )
}

/** Rows a search shows at once; the rest wait for a narrower search. */
const PICKER_ROWS = 50

/** The picker's first option: no parent at all. Not an entity id. */
const TOP = '\u0000top'
const TOP_LABEL = 'On its own, at the top'

/** "Move to a different parent": a search over the entities that can contain this one — and, where
 *  its type may stand alone (`canStandAlone`), no parent at all (`onTop`). */
function MoveTargetPicker({ nodeId, onPick, canStandAlone, onTop }: {
  nodeId: string
  onPick: (parentId: string) => void
  canStandAlone: () => boolean
  onTop: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const targets = useMoveTargets(nodeId, open)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const topOffered = open && canStandAlone()
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = q ? targets.filter((t) => t.label.toLowerCase().includes(q) || t.type.toLowerCase().includes(q)) : targets
    const top = topOffered && (!q || `${TOP_LABEL} top level`.toLowerCase().includes(q)) ? [{ id: TOP, label: TOP_LABEL, type: '' }] : []
    return [...top, ...hits]
  }, [targets, query, topOffered])
  const shown = matches.slice(0, PICKER_ROWS)

  const close = () => { setOpen(false); setQuery(''); setActive(0) }
  const pick = (id: string) => {
    close()
    if (id === TOP) onTop()
    else onPick(id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); pick(shown[active].id) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  if (!open) {
    return (
      <div className="space-y-1.5">
        <span className="block text-xs font-semibold text-ink-muted">Move to a different parent</span>
        <Button variant="secondary" size="sm" leftIcon={MoveRight} onClick={() => { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()) }}>
          Choose a new parent…
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-semibold text-ink-muted">Move to a different parent</span>
      <div className="rounded-xl border border-glass-border overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-glass-border">
          <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-label="Search for a new parent"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
            placeholder={`Search ${targets.length.toLocaleString()} possible parents…`}
            className="flex-1 min-w-0 py-2 bg-transparent outline-none text-sm text-ink placeholder:text-ink-muted"
          />
          <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
        </div>
        <ul id={listId} role="listbox" aria-label="Possible parents" className="max-h-56 overflow-y-auto custom-scrollbar py-1">
          {shown.map((t, i) => (
            <li
              key={t.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(t.id) }}
              className={cn('flex items-center justify-between gap-3 px-3 py-1.5 cursor-pointer text-sm',
                i === active ? 'bg-accent-lineage/10 text-ink' : 'text-ink',
                t.id === TOP && shown.length > 1 && 'border-b border-glass-border mb-1')}
            >
              {t.id === TOP ? (
                <>
                  <span className="flex items-center gap-2 min-w-0">
                    <Home className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
                    <span className="truncate">{t.label}</span>
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted shrink-0">No parent</span>
                </>
              ) : (
                <>
                  <span className="truncate">{t.label}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted shrink-0">{t.type}</span>
                </>
              )}
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-3 text-xs text-ink-muted italic">
              {targets.length === 0 ? 'Nothing in this view can contain this one.' : 'Nothing matches that search.'}
            </li>
          )}
        </ul>
        {matches.length > shown.length && (
          <p className="px-3 py-1.5 border-t border-glass-border text-[11px] text-ink-muted">
            Showing {shown.length} of {matches.length.toLocaleString()} — type to narrow it down.
          </p>
        )}
      </div>
    </div>
  )
}
