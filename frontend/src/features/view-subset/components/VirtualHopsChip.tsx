/**
 * VirtualHopsChip — the canvas's word on its virtual hops, in the status
 * cluster beside the other "what this board is and isn't showing" chips.
 *
 * It says, in turn: that lines are being stitched; how many virtual hops the
 * board draws (opening a list of them — the keyboard route to each hop's
 * steps, where the lines themselves are only reachable by pointer); that the
 * answer may be incomplete, and for whom; or that stitching failed, with a
 * retry. It says nothing when there is nothing to say: no hops to draw, or a
 * server that does not offer them.
 */
import { useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { AlertTriangle, ArrowRight, Loader2, RefreshCw, Waypoints } from 'lucide-react'

import { InfoTooltip } from '@/components/canvas/search/panel/builder-atoms/InfoTooltip'
import { cn } from '@/lib/utils'

import { BRIDGE_MEMBERS_MAX } from '../model/limits'
import type { VirtualHopsSummary } from '../model/virtualHops'

const LIST_CAP = 100
const NAMES_CAP = 4

const ACTION_CLASS =
  'ml-1 px-1.5 py-0.5 rounded-md text-accent-explore hover:bg-accent-explore/10 cursor-pointer ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40'

export function VirtualHopsChip({
  summary,
  chipClassName,
}: {
  summary: VirtualHopsSummary
  /** The cluster's shared chip look. */
  chipClassName: string
}) {
  const [open, setOpen] = useState(false)
  const { status, isFetching, lines, incompleteNames, retryable, maxHops, onOpenLine, onRetry } = summary

  if (status === 'loading') {
    return (
      <InfoTooltip
        side="right"
        content={
          <div>
            <p className="font-semibold mb-1">Stitching lineage</p>
            <p className="text-ink-muted">
              Finding where entities in this view connect through lineage the view leaves out.
            </p>
          </div>
        }
      >
        <div className={chipClassName} role="status">
          <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-accent-explore" aria-hidden="true" />
          <span>Stitching lineage…</span>
        </div>
      </InfoTooltip>
    )
  }

  if (status === 'error') {
    return (
      <div className={chipClassName} role="alert">
        <AlertTriangle className="w-3 h-3 text-amber-500" aria-hidden="true" />
        <span>Couldn&apos;t stitch lineage</span>
        <button type="button" className={ACTION_CLASS} onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (status === 'oversized') {
    return (
      <InfoTooltip
        side="right"
        content={
          <div>
            <p className="font-semibold mb-1">Virtual hops paused</p>
            <p className="text-ink-muted">
              This view holds more than {BRIDGE_MEMBERS_MAX.toLocaleString()} entities — too many to
              stitch in one pass. Lines between entities it holds still draw.
            </p>
          </div>
        }
      >
        <div className={chipClassName} tabIndex={0}>
          <Waypoints className="w-3 h-3 text-ink-muted" aria-hidden="true" />
          <span>Virtual hops paused</span>
        </div>
      </InfoTooltip>
    )
  }

  const partial = status === 'partial'
  const count = lines.length
  const sorted = [...lines].sort((a, b) => a.hops - b.hops || a.sourceLabel.localeCompare(b.sourceLabel))

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(chipClassName, 'cursor-pointer hover:scale-105 active:scale-95 transition-transform motion-reduce:transition-none motion-reduce:hover:scale-100')}
          aria-label={`${count} virtual hop${count === 1 ? '' : 's'}${partial ? ', may be incomplete' : ''}`}
        >
          {isFetching
            ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-accent-explore" aria-hidden="true" />
            : <Waypoints className="w-3 h-3 text-accent-explore" aria-hidden="true" />}
          <span className="tabular-nums">{count.toLocaleString()}</span>
          <span>virtual hop{count === 1 ? '' : 's'}</span>
          {partial && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              may be incomplete
            </span>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-[9999] w-80 rounded-lg border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated shadow-xl shadow-black/40 p-2 animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none"
          data-canvas-interactive
        >
          <div className="px-1.5 pb-2">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
              <Waypoints className="w-3.5 h-3.5 text-accent-explore" aria-hidden="true" />
              Virtual hops
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">
              Lineage between entities in this view that runs through steps it leaves out,
              up to {maxHops} steps long. Pick one to see the steps.
            </p>
          </div>

          {partial && (
            <div role="status" className="mx-1.5 mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
              Some links may be missing
              {incompleteNames.length > 0 && (
                <>
                  {' '}for{' '}
                  <span className="font-medium">
                    {incompleteNames.slice(0, NAMES_CAP).join(', ')}
                    {incompleteNames.length > NAMES_CAP ? ` +${incompleteNames.length - NAMES_CAP} more` : ''}
                  </span>
                </>
              )}
              {retryable
                ? ' — part of the walk did not finish in time.'
                : ' — the lineage there is too large to walk in full.'}
              {retryable && (
                <button type="button" className={cn(ACTION_CLASS, 'inline-flex items-center gap-1')} onClick={onRetry}>
                  <RefreshCw className="w-3 h-3" aria-hidden="true" /> Try again
                </button>
              )}
            </div>
          )}

          {count === 0 ? (
            <p className="px-1.5 py-1 text-[11px] text-ink-muted">No virtual hops found so far.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto custom-scrollbar" aria-label="Virtual hops on this board">
              {sorted.slice(0, LIST_CAP).map(line => (
                <li key={line.lineId}>
                  <button
                    type="button"
                    className="w-full text-left px-1.5 py-1 rounded-md hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors flex items-center gap-1.5 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setOpen(false)
                      onOpenLine(line.lineId, { x: r.left + r.width / 2, y: r.top })
                    }}
                  >
                    <span className="truncate text-[11.5px] text-ink">{line.sourceLabel}</span>
                    <ArrowRight className="w-3 h-3 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="truncate text-[11.5px] text-ink">{line.targetLabel}</span>
                    <span className="ml-auto flex-shrink-0 rounded-full border border-dashed border-accent-explore/60 px-1.5 text-[9.5px] font-bold tabular-nums text-accent-explore">
                      via {Math.max(1, line.hops - 1)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {count > LIST_CAP && (
            <p className="px-1.5 pt-1.5 text-[10px] text-ink-muted">+{(count - LIST_CAP).toLocaleString()} more</p>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
