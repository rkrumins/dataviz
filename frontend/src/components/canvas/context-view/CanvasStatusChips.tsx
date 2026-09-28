/**
 * CanvasStatusChips — bottom-left cluster of glass pills surfacing data
 * that is LOADED but not visible on the canvas. The canvas must never
 * hide lineage silently; each chip names a category of hidden data,
 * explains why in its tooltip, and offers an action where one exists.
 *
 * Chips (each hidden when its count is zero):
 *  - "N flows outside this view" — flows from a drawn row whose other end
 *    is outside the view. Only a curated view has an outside: a view open
 *    to its whole data source counts none (useEdgeProjection).
 *  - "N entities not in any layer" — loaded nodes that matched no layer;
 *    popover lists them with click-through to the entity drawer.
 *  - "Showing X of Y underlying flows" — expanded aggregated edges whose
 *    underlying detail is truncated; button pages more in.
 *  - "N placements not found here" — entities placed in the view that this
 *    graph doesn't hold (typically a view brought in from another
 *    environment); popover lists them and says what to do.
 *
 * Adaptive's "strongest N of M lines" is not here: it is the lineage guide at
 * the end of the layer strip (LineageGuide).
 *
 * Every relationship counted here is a FLOW (the placements chip counts
 * placements, not relationships): every one of these numbers
 * comes from `useEdgeProjection`, which drops containment edges in all
 * three of its sections, or from `useExternalDegrees`, which asks the
 * server for lineage types only. Nothing structural can reach a chip.
 *
 * Every count here names its unit too; the words come from
 * `connections/connectionUnits.ts` so no two chips can drift apart. The one
 * exception is the unresolved chip, which counts underlying flows (a
 * roll-up weighs every flow it stands for) and says so in its own words.
 *
 * Visual language matches the column overflow chips: rounded-full glass,
 * backdrop blur, soft border, quiet colors.
 */
import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Unlink, Layers, ListPlus, Focus, SearchX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { unitMeaning, unitNoun } from './connections/connectionUnits'

const CHIP_CLASS =
  'pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md ' +
  'border border-black/10 dark:border-white/10 shadow-md text-[11px] font-medium text-ink-muted bg-canvas-elevated/80'

const UNASSIGNED_LIST_CAP = 50

/** A placement in the view whose entity this graph doesn't hold. */
export interface NotFoundPlacement {
  urn: string
  label: string
  layerName?: string
}

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

  focusShown,
  focusTotal,
  onOpenFocusLens,
  rootsLoaded,
  rootsHaveMore,
  onLoadMoreRoots,
  selectedExternal,
  onPreviewExternal,
  notFoundPlacements = [],
}: {
  /** Flows from a drawn row whose other end is outside the view: none in a
   *  view open to its whole data source (useEdgeProjection). */
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
  /** Feature-flagged: fetch + show the out-of-view partners in the Lens. */
  onPreviewExternal?: () => void
  /** Placements the load asked the graph for and didn't get: kept in the view, marked not found. */
  notFoundPlacements?: NotFoundPlacement[]
}) {
  const [unassignedOpen, setUnassignedOpen] = useState(false)
  const [notFoundOpen, setNotFoundOpen] = useState(false)

  const showUnresolved = unresolvedEdgeCount > 0
  const showUnassigned = unassignedEntities.length > 0
  const showAggDetail = aggDetailTotal > aggDetailShown && aggDetailShown > 0
  const showFocus = (focusTotal ?? 0) > (focusShown ?? 0) && (focusShown ?? 0) > 0
  const showRoots = !!rootsHaveMore && (rootsLoaded ?? 0) > 0
  const showExternal = !!selectedExternal && (selectedExternal.in + selectedExternal.out) > 0
  const showNotFound = notFoundPlacements.length > 0

  if (!showUnresolved && !showUnassigned && !showAggDetail && !showFocus && !showRoots && !showExternal && !showNotFound) return null

  return (
    // Bottom-RIGHT, above the reserved dock band (--edge-legend-height) but
    // to the LEFT of the dock's own column — the bottom-left corner belongs
    // to the first layer column's cards, and a status surface must never
    // occlude data.
    //
    // Clear of the dock horizontally, not merely under it: the dock is w-80
    // at right:1rem (16px–336px from the edge) and paints an opaque body at
    // z-40, so a cluster right-aligned at right-3 was covered chip-for-chip
    // — 'Load more' and the unassigned-entities popover both dead — whenever
    // a panel was open. z-50 would not fix it; the chips would then paint
    // over the panel's own rows. 1rem dock offset + 20rem width + 0.5rem gap.
    <div
      className="absolute z-30 flex flex-col items-end gap-1.5 pointer-events-none"
      style={{
        bottom: 'calc(0.5rem + var(--edge-legend-height, 0px) + var(--trace-dock-height, 0px) + var(--selection-bar-height, 0px))',
        right: 'calc(1rem + 20rem + 0.5rem)',
      }}
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
                {selectedExternal!.out.toLocaleString()} downstream{' '}
                {unitNoun(selectedExternal!.in + selectedExternal!.out, 'flows')} exist in the
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
            {onPreviewExternal && (
              <button
                type="button"
                className="ml-1 px-1.5 py-0.5 rounded-md text-accent-lineage hover:bg-accent-lineage/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                onClick={onPreviewExternal}
              >
                Preview
              </button>
            )}
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
                className="ml-1 px-1.5 py-0.5 rounded-md text-accent-lineage hover:bg-accent-lineage/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                onClick={onLoadMoreRoots}
              >
                Load more
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
              <p className="font-semibold mb-1">Large flow fan</p>
              <p className="text-ink-muted">
                The selection touches {focusTotal!.toLocaleString()}{' '}
                {unitNoun(focusTotal!, 'lines')} — showing the{' '}
                {focusShown!.toLocaleString()} strongest on canvas. The Lens lists every
                one, grouped and searchable.
              </p>
              <p className="text-ink-muted/70 mt-1">{unitMeaning('lines')}</p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Focus className="w-3 h-3 text-accent-lineage/80" />
            <span>
              Strongest <span className="tabular-nums">{focusShown!.toLocaleString()}</span> of{' '}
              <span className="tabular-nums">{focusTotal!.toLocaleString()}</span>{' '}
              {unitNoun(focusTotal!, 'lines')}
            </span>
            {onOpenFocusLens && (
              <button
                type="button"
                className="ml-1 px-1.5 py-0.5 rounded-md text-accent-lineage hover:bg-accent-lineage/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
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
                {unresolvedEdgeCount.toLocaleString()} flow{unresolvedEdgeCount === 1 ? '' : 's'}{' '}
                lead outside this view
              </p>
              <p className="text-ink-muted">
                This view is a curated subset of the data source — these links
                reference entities that aren&apos;t part of the view&apos;s
                assignments. That&apos;s expected; add those entities to the
                view to see the flows.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Unlink className="w-3 h-3 text-sky-400/80" />
            <span className="tabular-nums">{unresolvedEdgeCount.toLocaleString()}</span>
            <span className="text-ink-muted/70">flows outside this view</span>
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

      {showNotFound && (
        <PopoverPrimitive.Root open={notFoundOpen} onOpenChange={setNotFoundOpen}>
          <PopoverPrimitive.Trigger asChild>
            <button type="button" className={`${CHIP_CLASS} cursor-pointer hover:scale-105 active:scale-95 transition-transform`}>
              <SearchX className="w-3 h-3 text-amber-500" />
              {/* The space is for screen readers: the flex gap separates them on screen. */}
              <span className="tabular-nums">{notFoundPlacements.length.toLocaleString()}</span>{' '}
              <span>{notFoundPlacements.length === 1 ? 'placement' : 'placements'} not found here</span>
            </button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              side="top"
              align="start"
              sideOffset={6}
              className="z-[9999] w-80 rounded-lg border border-glass-border bg-canvas-elevated shadow-xl shadow-black/40 p-2"
            >
              <p className="px-1.5 text-[11.5px] font-semibold text-ink">Placed in this view, but not in this graph</p>
              <p className="px-1.5 pt-0.5 pb-2 text-[11px] text-ink-muted leading-relaxed">
                Usually a view brought in from another environment. They’re kept, and appear as soon as the entity
                arrives here. To remove them, edit the view and see Assignments.
              </p>
              <div className="max-h-64 overflow-y-auto custom-scrollbar">
                {notFoundPlacements.slice(0, UNASSIGNED_LIST_CAP).map(p => (
                  <div key={p.urn} className="px-1.5 py-1 flex items-center gap-2 min-w-0" title={p.urn}>
                    <span className="truncate text-[11.5px] text-ink">{p.label}</span>
                    {p.layerName && <span className="ml-auto flex-shrink-0 text-[10px] text-ink-muted">{p.layerName}</span>}
                  </div>
                ))}
              </div>
              {notFoundPlacements.length > UNASSIGNED_LIST_CAP && (
                <p className="px-1.5 pt-1.5 text-[10px] text-ink-muted">
                  +{(notFoundPlacements.length - UNASSIGNED_LIST_CAP).toLocaleString()} more
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
            <span className="tabular-nums">{aggDetailTotal.toLocaleString()}</span>{' '}
            {unitNoun(aggDetailTotal, 'flows')}
          </span>
          {onLoadMoreDetail && (
            <button
              type="button"
              className="ml-1 px-1.5 py-0.5 rounded-md text-accent-lineage hover:bg-accent-lineage/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
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
