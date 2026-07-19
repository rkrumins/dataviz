/**
 * CanvasStatusChips — bottom-left cluster of glass pills surfacing data
 * that is LOADED but not visible on the canvas. The canvas must never
 * hide lineage silently; each chip names a category of hidden data,
 * explains why in its tooltip, and offers an action where one exists.
 *
 * Chips (each hidden when its count is zero):
 *  - "N connections not on canvas" — projected edges whose endpoints
 *    resolve to no rendered entity (unloaded or unassigned).
 *  - "N entities not in any layer" — loaded nodes that matched no layer;
 *    popover lists them with click-through to the entity drawer.
 *  - "Showing X of Y connections" — expanded aggregated edges whose
 *    underlying detail is truncated; button pages more in.
 *
 * Visual language matches the column overflow chips: rounded-full glass,
 * backdrop blur, soft border, quiet colors.
 */
import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Unlink, Layers, ListPlus, GitBranch, Focus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'

const CHIP_CLASS =
  'pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md ' +
  'border border-white/10 shadow-md text-[11px] font-medium text-ink-muted bg-canvas-elevated/80'

const UNASSIGNED_LIST_CAP = 50

export interface UnassignedEntity {
  id: string
  label: string
  type?: string
}

export function CanvasStatusChips({
  unresolvedEdgeCount,
  unassignedEntities,
  onOpenEntity,
  aggDetailShown,
  aggDetailTotal,
  onLoadMoreDetail,
  viewScope = 'all',
  adaptiveShown,
  adaptiveTotal,
  onShowAllEdges,
  focusShown,
  focusTotal,
  onOpenFocusLens,
  rootsLoaded,
  rootsHaveMore,
  onLoadMoreRoots,
  selectedExternal,
}: {
  /** Projected edges hidden because an endpoint resolves to nothing on canvas. */
  unresolvedEdgeCount: number
  /** Loaded nodes that render in no layer. */
  unassignedEntities: UnassignedEntity[]
  onOpenEntity?: (id: string) => void
  /** Underlying-edge counts across truncated aggregated expansions (0 = none truncated). */
  aggDetailShown: number
  aggDetailTotal: number
  onLoadMoreDetail?: () => void
  /**
   * Scope of the active view. Views are subsets of a Data Source: in a
   * CURATED view, links to out-of-view entities are EXPECTED (the user
   * chose the subset), so the chips use neutral informational wording
   * instead of implying something is missing or broken.
   */
  viewScope?: 'all' | 'curated'
  /** Adaptive ambient budget: strongest flows shown / total projected. */
  adaptiveShown?: number
  adaptiveTotal?: number
  onShowAllEdges?: () => void
  /** Focus fan cap: strongest incident edges shown / node's full fan. */
  focusShown?: number
  focusTotal?: number
  onOpenFocusLens?: () => void
  /** Root pagination: top-level entities loaded so far; `rootsHaveMore`
   *  = the last page was full, so more likely exist beyond it. */
  rootsLoaded?: number
  rootsHaveMore?: boolean
  onLoadMoreRoots?: () => void
  /** Selected node's lineage OUTSIDE the curated view's scope (total
   *  degree − loaded degree). null = none or unknown — no chip. */
  selectedExternal?: { in: number; out: number } | null
}) {
  const [unassignedOpen, setUnassignedOpen] = useState(false)

  const showUnresolved = unresolvedEdgeCount > 0
  const showUnassigned = unassignedEntities.length > 0
  const showAggDetail = aggDetailTotal > aggDetailShown && aggDetailShown > 0
  const showAdaptive = (adaptiveTotal ?? 0) > (adaptiveShown ?? 0) && (adaptiveShown ?? 0) > 0
  const showFocus = (focusTotal ?? 0) > (focusShown ?? 0) && (focusShown ?? 0) > 0
  const showRoots = !!rootsHaveMore && (rootsLoaded ?? 0) > 0
  const showExternal = !!selectedExternal && (selectedExternal.in + selectedExternal.out) > 0

  if (!showUnresolved && !showUnassigned && !showAggDetail && !showAdaptive && !showFocus && !showRoots && !showExternal) return null

  return (
    // Bottom-RIGHT, beneath the Edge Legend — the bottom-left corner
    // belongs to the first layer column's cards, and a status surface
    // must never occlude data.
    <div
      className="absolute right-3 z-30 flex flex-col items-end gap-1.5 pointer-events-none"
      style={{ bottom: 'calc(1rem + var(--trace-dock-height, 0px))' }}
      data-canvas-interactive
    >
      {showExternal && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">This entity has lineage beyond this view</p>
              <p className="text-ink-muted">
                {selectedExternal!.in.toLocaleString()} upstream and{' '}
                {selectedExternal!.out.toLocaleString()} downstream connection
                {selectedExternal!.in + selectedExternal!.out === 1 ? '' : 's'} exist in the
                data source but lead to entities outside this view&apos;s scope.
                That&apos;s expected for a curated view — it is NOT missing data.
                Add those entities to the view, or run a Trace, to see them.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Unlink className="w-3 h-3 text-sky-400/80" />
            <span>
              Selected: <span className="tabular-nums">{selectedExternal!.in.toLocaleString()}</span>↑{' '}
              <span className="tabular-nums">{selectedExternal!.out.toLocaleString()}</span>↓ outside this view
            </span>
          </div>
        </InfoTooltip>
      )}

      {showRoots && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">More top-level entities exist</p>
              <p className="text-ink-muted">
                {rootsLoaded!.toLocaleString()} top-level entities are loaded so far
                and the last page came back full — the source likely has more.
                Loading is additive: nothing on the canvas is replaced.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <ListPlus className="w-3 h-3 text-sky-500/80" />
            <span>
              <span className="tabular-nums">{rootsLoaded!.toLocaleString()}</span> top-level loaded
            </span>
            {onLoadMoreRoots && (
              <button
                type="button"
                className="ml-1 text-accent-lineage hover:underline cursor-pointer"
                onClick={onLoadMoreRoots}
              >
                Load more
              </button>
            )}
          </div>
        </InfoTooltip>
      )}

      {showAdaptive && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">Adaptive edge density</p>
              <p className="text-ink-muted">
                Showing the {adaptiveShown!.toLocaleString()} strongest flows of{' '}
                {adaptiveTotal!.toLocaleString()} on this canvas. The in/out markers on
                each entity summarize the rest — hover or select an entity to focus its
                connections, or show everything.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <GitBranch className="w-3 h-3 text-accent-lineage/80" />
            <span>
              Top <span className="tabular-nums">{adaptiveShown!.toLocaleString()}</span> of{' '}
              <span className="tabular-nums">{adaptiveTotal!.toLocaleString()}</span> flows
            </span>
            {onShowAllEdges && (
              <button
                type="button"
                className="ml-1 text-accent-lineage hover:underline cursor-pointer"
                onClick={onShowAllEdges}
              >
                Show all
              </button>
            )}
          </div>
        </InfoTooltip>
      )}

      {showFocus && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">Large connection fan</p>
              <p className="text-ink-muted">
                This entity has {focusTotal!.toLocaleString()} connections — showing the{' '}
                {focusShown!.toLocaleString()} strongest on canvas. The Lens lists every
                connection, grouped and searchable.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Focus className="w-3 h-3 text-accent-lineage/80" />
            <span>
              Strongest <span className="tabular-nums">{focusShown!.toLocaleString()}</span> of{' '}
              <span className="tabular-nums">{focusTotal!.toLocaleString()}</span>
            </span>
            {onOpenFocusLens && (
              <button
                type="button"
                className="ml-1 text-accent-lineage hover:underline cursor-pointer"
                onClick={onOpenFocusLens}
              >
                Open lens
              </button>
            )}
          </div>
        </InfoTooltip>
      )}

      {showUnresolved && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">
                {unresolvedEdgeCount.toLocaleString()} connection{unresolvedEdgeCount === 1 ? '' : 's'}{' '}
                {viewScope === 'curated' ? 'lead outside this view' : 'not shown'}
              </p>
              {viewScope === 'curated' ? (
                <p className="text-ink-muted">
                  This view is a curated subset of the data source — these links
                  reference entities that aren&apos;t part of the view&apos;s
                  assignments. That&apos;s expected; add those entities to the
                  view to see the connections.
                </p>
              ) : (
                <p className="text-ink-muted">
                  These edges reference entities that aren&apos;t loaded on the canvas
                  or aren&apos;t assigned to any layer. Load or assign those entities
                  to see the connections.
                </p>
              )}
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Unlink className={cn('w-3 h-3', viewScope === 'curated' ? 'text-sky-400/80' : 'text-amber-500/80')} />
            <span className="tabular-nums">{unresolvedEdgeCount.toLocaleString()}</span>
            <span className="text-ink-muted/70">
              {viewScope === 'curated' ? 'connections outside this view' : 'connections not on canvas'}
            </span>
          </div>
        </InfoTooltip>
      )}

      {showUnassigned && (
        <PopoverPrimitive.Root open={unassignedOpen} onOpenChange={setUnassignedOpen}>
          <PopoverPrimitive.Trigger asChild>
            <button type="button" className={`${CHIP_CLASS} cursor-pointer hover:scale-105 active:scale-95 transition-transform`}>
              <Layers className={cn('w-3 h-3', viewScope === 'curated' ? 'text-sky-400/80' : 'text-amber-500/80')} />
              <span className="tabular-nums">{unassignedEntities.length.toLocaleString()}</span>
              <span className="text-ink-muted/70">
                {viewScope === 'curated' ? 'loaded entities not in this view' : 'entities not in any layer'}
              </span>
            </button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              side="top"
              align="start"
              sideOffset={6}
              className="z-[9999] w-72 rounded-lg border border-glass-border/80 bg-canvas-elevated/95 backdrop-blur-md shadow-xl shadow-black/40 p-2"
            >
              <p className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">
                {viewScope === 'curated'
                  ? 'Loaded but not part of this view — assign to include'
                  : 'Loaded but not rendered — assign to a layer to show'}
              </p>
              <div className="max-h-64 overflow-y-auto custom-scrollbar">
                {unassignedEntities.slice(0, UNASSIGNED_LIST_CAP).map(e => (
                  <button
                    key={e.id}
                    type="button"
                    className="w-full text-left px-1.5 py-1 rounded-md hover:bg-white/[0.06] transition-colors flex items-center gap-2 min-w-0"
                    onClick={() => onOpenEntity?.(e.id)}
                  >
                    <span className="truncate text-[11.5px] text-ink">{e.label}</span>
                    {e.type && <span className="ml-auto flex-shrink-0 text-[9.5px] uppercase tracking-wider text-ink-muted/50">{e.type}</span>}
                  </button>
                ))}
              </div>
              {unassignedEntities.length > UNASSIGNED_LIST_CAP && (
                <p className="px-1.5 pt-1.5 text-[10px] text-ink-muted/60">
                  +{unassignedEntities.length - UNASSIGNED_LIST_CAP} more
                </p>
              )}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}

      {showAggDetail && (
        <div className={CHIP_CLASS}>
          <ListPlus className="w-3 h-3 text-sky-500/80" />
          <span>
            Showing <span className="tabular-nums">{aggDetailShown.toLocaleString()}</span> of{' '}
            <span className="tabular-nums">{aggDetailTotal.toLocaleString()}</span> connections
          </span>
          {onLoadMoreDetail && (
            <button
              type="button"
              className="ml-1 text-accent-lineage hover:underline cursor-pointer"
              onClick={onLoadMoreDetail}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  )
}
