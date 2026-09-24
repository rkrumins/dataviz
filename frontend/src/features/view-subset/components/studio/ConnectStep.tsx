/**
 * Step 2 — Connect. How the picks will hang together once everything else is
 * gone: which of them lineage joins directly, which only through steps the
 * subset leaves out (each one a virtual hop the view will draw), and which
 * join nothing else picked. Asked of the graph live as the picks settle.
 */
import { useMemo } from 'react'
import { AlertTriangle, ArrowRight, Crosshair, Loader2, RefreshCw, Unlink, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { LineageBridgeLink } from '@/providers/GraphDataProvider'

import type { LineageBridgesState } from '../../hooks/useLineageBridges'
import { summarizeConnectivity } from '../../model/connectivity'
import { orderedPicks, useSubsetStudioStore } from '../../model/studioStore'
import { ICON_BUTTON, QUIET_BUTTON, SectionTitle, Tile, type StudioLayer } from './atoms'
import { SubsetPreviewDiagram } from './SubsetPreviewDiagram'

const LIST_CAP = 50

export interface ConnectStepProps {
  layers: readonly StudioLayer[]
  preview: LineageBridgesState
  onOpenHop: (link: LineageBridgeLink, point: { x: number; y: number }) => void
  onLocate: (urn: string) => void
}

export function ConnectStep({ layers, preview, onOpenHop, onLocate }: ConnectStepProps) {
  const picks = useSubsetStudioStore((s) => s.picks)
  const order = useSubsetStudioStore((s) => s.order)
  const maxHops = useSubsetStudioStore((s) => s.maxHops)
  const list = useMemo(() => orderedPicks({ picks, order }), [picks, order])
  const labelOf = (urn: string) => picks[urn]?.label ?? urn

  const summary = useMemo(
    () => summarizeConnectivity(order, preview.links, preview.incomplete),
    [order, preview.links, preview.incomplete],
  )
  const inSubset = useMemo(() => {
    const picked = new Set(order)
    return preview.links.filter(l => picked.has(l.source) && picked.has(l.target))
  }, [order, preview.links])

  if (list.length < 2) {
    return (
      <p className="rounded-xl border border-dashed border-black/[0.12] dark:border-white/[0.12] px-4 py-5 text-center text-[12px] text-ink-muted">
        Pick at least two entities to see how they connect.
      </p>
    )
  }

  if (preview.status === 'disabled') {
    return (
      <p className="rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-4 py-3 text-[12px] leading-snug text-ink-secondary">
        Virtual hops aren&apos;t available on this data source — the subset will show the direct
        lines between what it keeps.
      </p>
    )
  }

  const settling = preview.status === 'loading' || preview.status === 'idle'

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle
          aside={
            <span aria-live="polite" className="inline-flex items-center gap-1.5 text-[11px] font-normal normal-case tracking-normal text-ink-muted">
              {settling && (
                <>
                  <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-accent-explore" aria-hidden="true" />
                  Checking…
                </>
              )}
              {preview.isFetching && !settling && (
                <>
                  <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Updating…
                </>
              )}
            </span>
          }
        >
          How they connect
        </SectionTitle>
        {preview.status === 'error' && (
          <p role="alert" className="flex items-center gap-1.5 pb-2 text-[11.5px] text-red-600 dark:text-red-400">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            Couldn&apos;t check the connections.
            <button type="button" className={cn(QUIET_BUTTON, 'text-accent-explore')} onClick={preview.refetch}>
              <RefreshCw className="w-3 h-3" aria-hidden="true" /> Try again
            </button>
          </p>
        )}
        {preview.status === 'oversized' && (
          <p className="pb-2 text-[11.5px] text-ink-muted">Too many picks to check at once — connections show once the subset is made.</p>
        )}
        <div className={cn('grid grid-cols-2 gap-2 transition-opacity', settling && 'opacity-60')}>
          <Tile value={list.length.toLocaleString()} label="Entities kept" />
          <Tile value={summary.direct.length.toLocaleString()} label="Joined directly" />
          <Tile value={summary.virtual.length.toLocaleString()} label="Virtual hops" tone="accent" hint="Joined through steps the subset leaves out" />
          <Tile
            value={summary.isolated.length.toLocaleString()}
            label="Isolated"
            tone={summary.isolated.length > 0 ? 'warning' : 'neutral'}
            hint={`No lineage to anything else picked, within ${maxHops} steps`}
          />
        </div>
      </div>

      {preview.status === 'partial' && (
        <p role="status" className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            Some connections may be missing
            {summary.incomplete.length > 0 && <> for {summary.incomplete.slice(0, 3).map(labelOf).join(', ')}{summary.incomplete.length > 3 ? ` +${summary.incomplete.length - 3} more` : ''}</>}
            {' '}— their lineage is too large to walk in full.
          </span>
        </p>
      )}

      <SubsetPreviewDiagram layers={layers} picks={list} links={inSubset} />

      {summary.virtual.length > 0 && (
        <section aria-label="Virtual hops">
          <SectionTitle>Virtual hops</SectionTitle>
          <p className="-mt-0.5 pb-1.5 text-[11px] leading-snug text-ink-muted">
            Lineage that runs through entities you left out. The subset draws each as one stitched line.
          </p>
          <ul className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
            {summary.virtual.slice(0, LIST_CAP).map(l => (
              <li key={`${l.source}|${l.target}`}>
                <button
                  type="button"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    onOpenHop(l, { x: r.left + r.width / 2, y: r.bottom })
                  }}
                  className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left min-w-0 hover:bg-accent-explore/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-explore/40"
                >
                  <span className="truncate text-[12px] text-ink">{labelOf(l.source)}</span>
                  <ArrowRight className="w-3 h-3 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                  <span className="truncate text-[12px] text-ink">{labelOf(l.target)}</span>
                  <span className="ml-auto flex-shrink-0 rounded-full border border-dashed border-accent-explore/60 px-1.5 text-[9.5px] font-bold tabular-nums text-accent-explore">
                    via {Math.max(1, l.hops - 1)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {summary.virtual.length > LIST_CAP && (
            <p className="px-1 pt-1 text-[10.5px] text-ink-muted">+{(summary.virtual.length - LIST_CAP).toLocaleString()} more</p>
          )}
        </section>
      )}

      {summary.isolated.length > 0 && !settling && (
        <section aria-label="Isolated entities">
          <SectionTitle>Isolated</SectionTitle>
          <p className="-mt-0.5 pb-1.5 text-[11px] leading-snug text-ink-muted">
            No lineage joins these to anything else you picked within {maxHops} steps. Keep them if they
            belong, or grow them to bring in their neighbours.
          </p>
          <ul className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
            {summary.isolated.slice(0, LIST_CAP).map(urn => (
              <li key={urn} className="flex items-center gap-2 px-2.5 py-1.5 min-w-0">
                <Unlink className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
                <span className="truncate text-[12px] text-ink flex-1" title={labelOf(urn)}>{labelOf(urn)}</span>
                {picks[urn]?.origin !== 'outside' && (
                  <button type="button" className={ICON_BUTTON} aria-label={`Show ${labelOf(urn)} on the canvas`} onClick={() => onLocate(urn)}>
                    <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={`Leave ${labelOf(urn)} out`}
                  onClick={() => useSubsetStudioStore.getState().remove([urn], `Remove ${labelOf(urn)}`)}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
