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
import { Unlink, Layers, ListPlus } from 'lucide-react'
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
}) {
  const [unassignedOpen, setUnassignedOpen] = useState(false)

  const showUnresolved = unresolvedEdgeCount > 0
  const showUnassigned = unassignedEntities.length > 0
  const showAggDetail = aggDetailTotal > aggDetailShown && aggDetailShown > 0

  if (!showUnresolved && !showUnassigned && !showAggDetail) return null

  return (
    <div
      className="absolute left-3 z-30 flex flex-col items-start gap-1.5 pointer-events-none"
      style={{ bottom: 'calc(3.25rem + var(--trace-dock-height, 0px))' }}
      data-canvas-interactive
    >
      {showUnresolved && (
        <InfoTooltip
          side="right"
          content={
            <div>
              <p className="font-semibold mb-1">
                {unresolvedEdgeCount.toLocaleString()} connection{unresolvedEdgeCount === 1 ? '' : 's'} not shown
              </p>
              <p className="text-ink-muted">
                These edges reference entities that aren&apos;t loaded on the canvas
                or aren&apos;t assigned to any layer. Load or assign those entities
                to see the connections.
              </p>
            </div>
          }
        >
          <div className={CHIP_CLASS}>
            <Unlink className="w-3 h-3 text-amber-500/80" />
            <span className="tabular-nums">{unresolvedEdgeCount.toLocaleString()}</span>
            <span className="text-ink-muted/70">connections not on canvas</span>
          </div>
        </InfoTooltip>
      )}

      {showUnassigned && (
        <PopoverPrimitive.Root open={unassignedOpen} onOpenChange={setUnassignedOpen}>
          <PopoverPrimitive.Trigger asChild>
            <button type="button" className={`${CHIP_CLASS} cursor-pointer hover:scale-105 active:scale-95 transition-transform`}>
              <Layers className="w-3 h-3 text-amber-500/80" />
              <span className="tabular-nums">{unassignedEntities.length.toLocaleString()}</span>
              <span className="text-ink-muted/70">entities not in any layer</span>
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
                Loaded but not rendered — assign to a layer to show
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
