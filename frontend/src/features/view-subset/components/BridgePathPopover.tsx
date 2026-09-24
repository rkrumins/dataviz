/**
 * BridgePathPopover — "how are these two connected?", answered where the
 * reader asked it: at the virtual hop they clicked.
 *
 * The line said "via N"; this names the N. Steps are shown at the grain the
 * view speaks (a hidden column is filed under its table), top to bottom from
 * the source, with the two members as solid ends and the hidden steps as
 * dashed stops — the same stitch the line itself is drawn with. Where routes
 * of equal length run side by side, the step says so rather than picking one
 * silently.
 *
 * Portaled (Radix) and anchored to the click point, so no card or column can
 * clip it; Escape and a click outside close it; focus moves into it and back.
 */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { AlertTriangle, ArrowRight, ListPlus, Loader2, RefreshCw, Route, Waypoints, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { GraphNode, LineageBridgeLink, LineageBridgeMember } from '@/providers/GraphDataProvider'

import { useBridgePath } from '../hooks/useBridgePath'
import { buildBridgePathModel, hiddenStepsLabel, type BridgeStep } from '../model/bridgePath'

export interface BridgePathTarget {
  /** The clicked line — the popover starts afresh for each. */
  lineId: string
  /** Every link the line stands for; more than one when a closed group or a
   *  collapsed parent gathers several members at one end. */
  links: readonly LineageBridgeLink[]
  /** The click, in viewport coordinates. */
  point: { x: number; y: number }
}

export interface BridgePathPopoverProps {
  target: BridgePathTarget | null
  /** The member set the lines were drawn with — the path is walked with it. */
  members: readonly LineageBridgeMember[]
  maxHops: number
  generation?: number | string
  /** A name for an entity the canvas holds; the path's own answer otherwise. */
  labelOf: (urn: string) => string | undefined
  onClose: () => void
  /** Open the Lineage Lens on the route, source first. */
  onWalkInLens?: (trail: string[]) => void
  /** Re-ask for every line, when this one turns out to be out of date. */
  onRefreshLines?: () => void
  /** The Subset Studio: bring the hidden steps into the subset, so the hop
   *  becomes direct lineage. Absent outside the studio. */
  onIncludeSteps?: (steps: BridgeStep[], nodes: GraphNode[], link: LineageBridgeLink) => void
}

function tail(urn: string): string {
  const parts = urn.split(/[:/.]/).filter(Boolean)
  return parts[parts.length - 1] ?? urn
}

/** A zero-size rect at a viewport point — the click Radix positions against. */
function measurableAt(x: number, y: number) {
  return {
    getBoundingClientRect: () =>
      ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect,
  }
}

export function BridgePathPopover({ target, onClose, ...rest }: BridgePathPopoverProps) {
  const titleId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const x = target?.point.x ?? 0
  const y = target?.point.y ?? 0
  // A new object per point: Radix re-anchors when the ref's value changes.
  const anchorRef = useMemo(() => ({ current: measurableAt(x, y) }), [x, y])

  return (
    <PopoverPrimitive.Root open={!!target} onOpenChange={(open) => { if (!open) onClose() }}>
      <PopoverPrimitive.Anchor virtualRef={anchorRef} />
      <PopoverPrimitive.Portal>
        {target && (
          <PopoverPrimitive.Content
            ref={contentRef}
            side="bottom"
            align="center"
            sideOffset={12}
            collisionPadding={12}
            aria-labelledby={titleId}
            tabIndex={-1}
            // Focus lands on the card itself, not its first control: a
            // keyboard reader is inside it, and a pointer reader is not shown
            // a focus ring on Close they never reached for.
            onOpenAutoFocus={(e) => { e.preventDefault(); contentRef.current?.focus() }}
            className={cn(
              'z-[9999] w-[22rem] max-w-[calc(100vw-24px)] rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated',
              'shadow-xl shadow-black/40 outline-none',
              'animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none',
            )}
            data-canvas-interactive
          >
            <BridgePathBody key={target.lineId} target={target} titleId={titleId} {...rest} />
          </PopoverPrimitive.Content>
        )}
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function BridgePathBody({
  target,
  titleId,
  members,
  maxHops,
  generation,
  labelOf,
  onWalkInLens,
  onRefreshLines,
  onIncludeSteps,
}: Omit<BridgePathPopoverProps, 'onClose' | 'target'> & { target: BridgePathTarget; titleId: string }) {
  const links = useMemo(
    () => [...target.links].sort((a, b) => a.hops - b.hops || a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
    [target.links],
  )
  const [chosen, setChosen] = useState(0)
  const link = links[Math.min(chosen, links.length - 1)]
  const path = useBridgePath({ link, members, maxHops, generation })
  const model = useMemo(() => (path.result ? buildBridgePathModel(path.result) : null), [path.result])

  const pathNames = useMemo(
    () => new Map((path.result?.nodes ?? []).map(n => [n.urn, n.displayName])),
    [path.result],
  )
  const nameOf = (urn: string) => labelOf(urn) || pathNames.get(urn) || tail(urn)
  const hops = model?.hops ?? link.hops
  const stale = path.status === 'ready' && model?.hops === null

  return (
    <div className="flex flex-col">
      <header className="px-4 pt-3.5 pb-3 border-b border-black/[0.08] dark:border-white/[0.08]">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-explore/10 text-accent-explore text-[10px] font-bold uppercase tracking-wider">
            <Waypoints className="w-3 h-3" aria-hidden="true" />
            {hops >= 2 ? 'Virtual hop' : 'Direct'}
          </span>
          {hops >= 2 && (
            <span className="text-[11px] text-ink-muted tabular-nums">{hiddenStepsLabel(hops)}</span>
          )}
          <PopoverPrimitive.Close
            aria-label="Close"
            className="ml-auto -mr-1 p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </PopoverPrimitive.Close>
        </div>
        <h3 id={titleId} className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink min-w-0">
          <span className="truncate" title={nameOf(link.source)}>{nameOf(link.source)}</span>
          <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-accent-explore" aria-hidden="true" />
          <span className="truncate" title={nameOf(link.target)}>{nameOf(link.target)}</span>
        </h3>
        <p className="mt-1 text-[11.5px] leading-snug text-ink-muted">
          {hops >= 2
            ? 'Connected through lineage this view leaves out.'
            : 'Lineage runs directly between what these two hold.'}
        </p>
      </header>

      {links.length > 1 && (
        <div className="px-3 pt-2.5">
          <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            This line stands for {links.length} connections
          </p>
          <div role="radiogroup" aria-label="Connections this line stands for" className="max-h-28 overflow-y-auto custom-scrollbar space-y-0.5">
            {links.map((l, i) => (
              <button
                key={`${l.source}|${l.target}`}
                type="button"
                role="radio"
                aria-checked={i === chosen}
                onClick={() => setChosen(i)}
                className={cn(
                  'w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left text-[11.5px] min-w-0 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40',
                  i === chosen ? 'bg-accent-explore/10 text-ink' : 'text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                )}
              >
                <span className="truncate">{nameOf(l.source)}</span>
                <ArrowRight className="w-3 h-3 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="truncate">{nameOf(l.target)}</span>
                <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-accent-explore">
                  {l.hops >= 2 ? `via ${l.hops - 1}` : 'direct'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3">
        {path.status === 'loading' && <StepsSkeleton />}

        {path.status === 'error' && (
          <Notice tone="error" text="Couldn't load the steps behind this line.">
            <button
              type="button"
              onClick={path.refetch}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-explore hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 rounded"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" /> Try again
            </button>
          </Notice>
        )}

        {path.status === 'disabled' && (
          <Notice tone="info" text="The steps behind this line can't be shown here." />
        )}

        {stale && (
          <Notice
            tone="warning"
            text={`These two no longer connect within ${maxHops} steps — the lineage changed since this line was drawn.`}
          >
            {onRefreshLines && (
              <button
                type="button"
                onClick={onRefreshLines}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-explore hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 rounded"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Refresh lines
              </button>
            )}
          </Notice>
        )}

        {model && model.hops !== null && (
          <ol aria-label="The route, source first" className="relative">
            <MemberStop name={nameOf(link.source)} />
            {model.levels.map((level, i) => (
              <StepStop key={i} index={i + 1} steps={level} />
            ))}
            <MemberStop name={nameOf(link.target)} />
          </ol>
        )}

        {path.result?.truncated && model?.hops !== null && (
          <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
            Some steps may be missing — the lineage here is too large to walk in full.
          </p>
        )}
      </div>

      {(onWalkInLens || onIncludeSteps) && model && model.hops !== null && (
        <footer className="px-3 py-2.5 border-t border-black/[0.08] dark:border-white/[0.08] flex items-center justify-end gap-2">
          {onIncludeSteps && model.levels.length > 0 && (
            <PopoverPrimitive.Close asChild>
              <button
                type="button"
                onClick={() => onIncludeSteps(model.levels.flat(), path.result?.nodes ?? [], link)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 transition-colors"
              >
                <ListPlus className="w-3.5 h-3.5" aria-hidden="true" />
                Include these steps
              </button>
            </PopoverPrimitive.Close>
          )}
          {onWalkInLens && (
            <PopoverPrimitive.Close asChild>
              <button
                type="button"
                onClick={() => onWalkInLens(model.trail)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-semibold text-accent-explore bg-accent-explore/10 hover:bg-accent-explore/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 transition-colors"
              >
                <Route className="w-3.5 h-3.5" aria-hidden="true" />
                Walk it in the Lens
              </button>
            </PopoverPrimitive.Close>
          )}
        </footer>
      )}
    </div>
  )
}

/** A member at either end of the route: in the view, so drawn solid. */
function MemberStop({ name }: { name: string }) {
  return (
    <li className="relative flex items-center gap-2.5 min-w-0 py-1">
      <span className="relative z-[1] w-2.5 h-2.5 flex-shrink-0 rounded-full bg-accent-explore ring-2 ring-accent-explore/20" aria-hidden="true" />
      <span className="truncate text-[12px] font-semibold text-ink" title={name}>{name}</span>
      <span className="ml-auto flex-shrink-0 text-[9.5px] uppercase tracking-wider text-ink-muted">In this view</span>
    </li>
  )
}

/** One hidden step: a dashed stop on the stitched spine. Several entries mean
 *  equal-length routes diverge here. */
function StepStop({ index, steps }: { index: number; steps: BridgeStep[] }) {
  const [first, ...others] = steps
  return (
    <li className="relative flex gap-2.5 min-w-0 py-1.5">
      <span
        className="absolute left-[4.5px] -top-1.5 -bottom-1.5 w-0 border-l-2 border-dashed border-accent-explore/40"
        aria-hidden="true"
      />
      <span className="relative z-[1] mt-1 w-2.5 h-2.5 flex-shrink-0 rounded-full border-2 border-dashed border-accent-explore bg-canvas-elevated" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="truncate text-[12px] font-medium text-ink" title={first.name}>{first.name}</span>
          {first.entityType && (
            <span className="flex-shrink-0 text-[9.5px] uppercase tracking-wider text-ink-muted">{first.entityType}</span>
          )}
          <span className="ml-auto flex-shrink-0 text-[9.5px] tabular-nums text-ink-muted">step {index}</span>
        </div>
        {first.context.length > 0 && (
          <p className="truncate text-[10.5px] text-ink-muted" title={first.context.join(' › ')}>
            {first.context.join(' › ')}
          </p>
        )}
        {first.nodes > 1 && steps.length === 1 && (
          <p className="text-[10.5px] text-ink-muted tabular-nums">{first.nodes} steps inside</p>
        )}
        {others.length > 0 && (
          <p className="truncate text-[10.5px] text-ink-muted" title={others.map(s => s.name).join(', ')}>
            or {others.slice(0, 2).map(s => s.name).join(', ')}
            {others.length > 2 ? ` +${others.length - 2} more` : ''}
          </p>
        )}
      </div>
    </li>
  )
}

function StepsSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-2.5">
      <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-accent-explore" aria-hidden="true" />
        Tracing the hidden steps…
      </p>
      {[0, 1, 2].map(i => (
        <div key={i} className="flex items-center gap-2.5 animate-pulse motion-reduce:animate-none">
          <span className="w-2.5 h-2.5 rounded-full bg-black/[0.08] dark:bg-white/[0.08]" />
          <span className="h-2.5 rounded bg-black/[0.08] dark:bg-white/[0.08]" style={{ width: `${70 - i * 15}%` }} />
        </div>
      ))}
    </div>
  )
}

function Notice({ tone, text, children }: { tone: 'error' | 'warning' | 'info'; text: string; children?: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg px-3 py-2 text-[11.5px] leading-snug',
        tone === 'error' && 'bg-red-500/10 text-red-700 dark:text-red-300',
        tone === 'warning' && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        tone === 'info' && 'bg-black/[0.04] dark:bg-white/[0.05] text-ink-secondary',
      )}
    >
      <span>{text}</span>
      {children}
    </div>
  )
}
