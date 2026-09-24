/**
 * Step 3 — Shape. How the subset reads once made: which of the source's
 * layers it keeps, whether each container comes with what sits inside it,
 * whether groups carry over, and how far a virtual hop may reach.
 */
import { useMemo } from 'react'
import * as Switch from '@radix-ui/react-switch'
import { Layers } from 'lucide-react'

import { VIRTUAL_HOP_COLOR } from '@/components/canvas/context-view/edgeDash'
import { cn } from '@/lib/utils'

import { MAX_HOPS_CAP } from '../../model/limits'
import { orderedPicks, useSubsetStudioStore } from '../../model/studioStore'
import { LayerDot, QUIET_BUTTON, SectionTitle, type StudioLayer } from './atoms'

const CONTAINER_LIST_CAP = 40

export interface ShapeStepProps {
  layers: readonly StudioLayer[]
  /** Picks that hold something beneath them (a table's columns). */
  containerUrns: ReadonlySet<string>
}

export function ShapeStep({ layers, containerUrns }: ShapeStepProps) {
  const picks = useSubsetStudioStore((s) => s.picks)
  const order = useSubsetStudioStore((s) => s.order)
  const maxHops = useSubsetStudioStore((s) => s.maxHops)
  const keepGroups = useSubsetStudioStore((s) => s.keepGroups)
  const list = useMemo(() => orderedPicks({ picks, order }), [picks, order])
  const store = useSubsetStudioStore.getState

  const perLayer = useMemo(() => {
    const c = new Map<string, number>()
    for (const p of list) c.set(p.layerId, (c.get(p.layerId) ?? 0) + 1)
    return c
  }, [list])
  const kept = layers.filter(l => perLayer.has(l.id))
  const dropped = layers.filter(l => !perLayer.has(l.id))
  const containers = list.filter(p => containerUrns.has(p.urn))
  const reachPct = ((maxHops - 1) / (MAX_HOPS_CAP - 1)) * 100
  const grouped = list.some(p => p.logicalNodeId)

  return (
    <div className="space-y-5">
      <section aria-label="Layers">
        <SectionTitle>Layers</SectionTitle>
        <ul className="space-y-1">
          {kept.map(l => (
            <li key={l.id} className="flex items-center gap-2 text-[12px] text-ink">
              <LayerDot color={l.color} />
              <span className="truncate">{l.name}</span>
              <span className="ml-auto text-[11px] text-ink-muted tabular-nums">{(perLayer.get(l.id) ?? 0).toLocaleString()} kept</span>
            </li>
          ))}
        </ul>
        {dropped.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-ink-muted">
            <Layers className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden="true" />
            <span>
              Left out, nothing picked from them: {dropped.map(l => l.name).join(', ')}.
            </span>
          </p>
        )}
      </section>

      {containers.length > 0 && (
        <section aria-label="What sits inside">
          <SectionTitle
            aside={
              <>
                <button type="button" className={QUIET_BUTTON} onClick={() => store().setInherits(containers.map(p => p.urn), true)}>All inside</button>
                <button type="button" className={QUIET_BUTTON} onClick={() => store().setInherits(containers.map(p => p.urn), false)}>None</button>
              </>
            }
          >
            What sits inside
          </SectionTitle>
          <p className="-mt-0.5 pb-1.5 text-[11px] leading-snug text-ink-muted">
            A container can come with everything beneath it (a table and its columns) or on its own.
          </p>
          <ul className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
            {containers.slice(0, CONTAINER_LIST_CAP).map(p => (
              <li key={p.urn} className="flex items-center gap-2 px-2.5 py-1.5 min-w-0">
                <span className="truncate text-[12px] text-ink flex-1" title={p.label}>{p.label}</span>
                <label className="flex items-center gap-1.5 text-[11px] text-ink-muted cursor-pointer select-none flex-shrink-0">
                  {p.inheritsChildren ? 'With contents' : 'On its own'}
                  <Switch.Root
                    checked={p.inheritsChildren}
                    onCheckedChange={(on) => store().setInherits([p.urn], on)}
                    aria-label={`${p.label} comes with what sits inside it`}
                    className="relative w-7 h-4 rounded-full bg-black/15 dark:bg-white/15 data-[state=checked]:bg-accent-explore transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
                  >
                    <Switch.Thumb className="block w-3 h-3 rounded-full bg-white shadow translate-x-0.5 data-[state=checked]:translate-x-[14px] transition-transform" />
                  </Switch.Root>
                </label>
              </li>
            ))}
          </ul>
          {containers.length > CONTAINER_LIST_CAP && (
            <p className="px-1 pt-1 text-[10.5px] text-ink-muted">+{(containers.length - CONTAINER_LIST_CAP).toLocaleString()} more — use All inside / None</p>
          )}
        </section>
      )}

      {grouped && (
        <section aria-label="Groups">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <Switch.Root
              checked={keepGroups}
              onCheckedChange={(on) => store().setKeepGroups(on)}
              className="relative mt-0.5 w-7 h-4 flex-shrink-0 rounded-full bg-black/15 dark:bg-white/15 data-[state=checked]:bg-accent-explore transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
            >
              <Switch.Thumb className="block w-3 h-3 rounded-full bg-white shadow translate-x-0.5 data-[state=checked]:translate-x-[14px] transition-transform" />
            </Switch.Root>
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-ink">Keep the source view&apos;s groups</span>
              <span className="block text-[11px] leading-snug text-ink-muted">Entities stay in the groups they sit in now; off, each layer lists them flat.</span>
            </span>
          </label>
        </section>
      )}

      <section aria-label="Virtual hop reach">
        <SectionTitle aside={<span className="text-[11px] font-semibold text-accent-explore tabular-nums">{maxHops} steps</span>}>
          Virtual hop reach
        </SectionTitle>
        <input
          type="range"
          min={1}
          max={MAX_HOPS_CAP}
          value={maxHops}
          onChange={(e) => store().setMaxHops(Number(e.target.value))}
          aria-label="Longest virtual hop, in lineage steps"
          aria-valuetext={`${maxHops} steps`}
          style={{ background: `linear-gradient(to right, ${VIRTUAL_HOP_COLOR} ${reachPct}%, rgba(127, 127, 127, 0.25) ${reachPct}%)` }}
          className={cn(
            'w-full h-1.5 my-2 appearance-none rounded-full cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40 focus-visible:ring-offset-2',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4',
            '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md',
            '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-solid [&::-webkit-slider-thumb]:border-[#06b6d4]',
            '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full',
            '[&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-solid [&::-moz-range-thumb]:border-[#06b6d4]',
          )}
        />
        <div className="flex justify-between text-[10px] text-ink-muted tabular-nums" aria-hidden="true">
          <span>1 step · close relatives</span>
          <span>{MAX_HOPS_CAP} steps · far reaching</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-muted">
          The longest chain of left-out steps a virtual hop may stand for. Longer reach finds more
          connections; shorter keeps the picture to close relatives.
        </p>
      </section>
    </div>
  )
}
