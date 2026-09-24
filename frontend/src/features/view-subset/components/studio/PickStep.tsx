/**
 * Step 1 — Pick. Everything that decides WHAT the subset holds: clicking on
 * the canvas (the primary gesture — this step mostly explains it), whole
 * layers or types at once, growing the picks along their lineage, and the
 * list of what is in so far, by layer, each entry saying how it came in.
 */
import { useMemo, useState, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Switch from '@radix-ui/react-switch'
import {
  ArrowDown, ArrowUp, ChevronDown, Crosshair, Loader2, MousePointerClick, Plus, Search, Sprout, Undo2, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import type { GrowDepth, GrowDirection } from '../../model/grow'
import { SUBSET_MEMBERS_MAX } from '../../model/limits'
import { orderedPicks, useSubsetStudioStore, type SubsetPick } from '../../model/studioStore'
import { REACH_BEYOND_PICK_CAP } from '../../hooks/useSubsetGrow'
import { ICON_BUTTON, LayerDot, OriginBadge, QUIET_BUTTON, SectionTitle, type StudioLayer } from './atoms'

/** Picks a layer lists before "Show all". */
const LAYER_PAGE = 25

export interface PickStepProps {
  layers: readonly StudioLayer[]
  /** What each layer holds on the canvas, as ready-made picks. */
  layerCandidates: ReadonlyMap<string, readonly SubsetPick[]>
  onGrow: (direction: GrowDirection, depth: GrowDepth) => void
  growing: boolean
  /** Why Grow cannot run yet; absent = it can. */
  growBlockedReason?: string
  onLocate: (urn: string) => void
}

export function PickStep({ layers, layerCandidates, onGrow, growing, growBlockedReason, onLocate }: PickStepProps) {
  const picks = useSubsetStudioStore((s) => s.picks)
  const order = useSubsetStudioStore((s) => s.order)
  const undoStack = useSubsetStudioStore((s) => s.undoStack)
  const reachBeyond = useSubsetStudioStore((s) => s.reachBeyond)
  const list = useMemo(() => orderedPicks({ picks, order }), [picks, order])

  const [direction, setDirection] = useState<GrowDirection>('upstream')
  const [depth, setDepth] = useState<GrowDepth>('one')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const byType = useMemo(() => {
    const out = new Map<string, SubsetPick[]>()
    layerCandidates.forEach(rows => rows.forEach(r => {
      const key = r.entityType || 'Other'
      const bucket = out.get(key)
      if (bucket) bucket.push(r)
      else out.set(key, [r])
    }))
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [layerCandidates])

  const q = query.trim().toLowerCase()
  const grouped = useMemo(() => {
    const byLayer = new Map<string, SubsetPick[]>()
    for (const p of list) {
      if (q && !p.label.toLowerCase().includes(q) && !(p.entityType ?? '').toLowerCase().includes(q)) continue
      const bucket = byLayer.get(p.layerId)
      if (bucket) bucket.push(p)
      else byLayer.set(p.layerId, [p])
    }
    return layers.filter(l => byLayer.has(l.id)).map(l => ({ layer: l, picks: byLayer.get(l.id)! }))
  }, [list, layers, q])

  const store = useSubsetStudioStore.getState
  const addAll = (rows: readonly SubsetPick[], label: string) => { store().add(rows, label) }
  const lastUndo = undoStack[undoStack.length - 1]

  return (
    <div className="space-y-4">
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-accent-explore/40 bg-accent-explore/5 px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-8 h-8 flex-shrink-0 rounded-lg bg-accent-explore/15 grid place-items-center">
              <MousePointerClick className="w-4 h-4 text-accent-explore" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-ink">Click entities on the canvas to keep them</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-muted">
                Click again to leave one out. Keep only what your audience needs — lineage between the
                entities you keep stays connected, even through the ones you leave out.
              </p>
            </div>
          </div>
          {layers.some(l => (layerCandidates.get(l.id)?.length ?? 0) > 0) && (
            <div className="mt-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted pb-1.5">Or start from a whole layer</p>
              <div className="flex flex-wrap gap-1.5">
                {layers.map(l => {
                  const rows = layerCandidates.get(l.id) ?? []
                  if (rows.length === 0) return null
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => addAll(rows, `Add all in ${l.name}`)}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated text-[11.5px] text-ink hover:border-accent-explore/50 hover:bg-accent-explore/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
                    >
                      <LayerDot color={l.color} />
                      {l.name}
                      <span className="text-ink-muted tabular-nums">{rows.length.toLocaleString()}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Add in bulk, undo */}
          <div className="flex items-center gap-1">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className={QUIET_BUTTON}>
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add
                  <ChevronDown className="w-3 h-3" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-[9999] min-w-[220px] max-h-80 overflow-y-auto custom-scrollbar rounded-lg border border-black/[0.08] dark:border-white/[0.08] bg-canvas-elevated shadow-xl shadow-black/30 p-1 text-[12px]"
                >
                  <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">All in a layer</DropdownMenu.Label>
                  {layers.map(l => {
                    const rows = layerCandidates.get(l.id) ?? []
                    return (
                      <DropdownMenu.Item
                        key={l.id}
                        disabled={rows.length === 0}
                        onSelect={() => addAll(rows, `Add all in ${l.name}`)}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-ink outline-none cursor-pointer data-[highlighted]:bg-accent-explore/10 data-[disabled]:opacity-40 data-[disabled]:cursor-default"
                      >
                        <LayerDot color={l.color} />
                        <span className="truncate">{l.name}</span>
                        <span className="ml-auto text-ink-muted tabular-nums">{rows.length.toLocaleString()}</span>
                      </DropdownMenu.Item>
                    )
                  })}
                  {byType.length > 0 && (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-black/[0.08] dark:bg-white/[0.08]" />
                      <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">All of a type</DropdownMenu.Label>
                      {byType.map(([type, rows]) => (
                        <DropdownMenu.Item
                          key={type}
                          onSelect={() => addAll(rows, `Add every ${type}`)}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md text-ink outline-none cursor-pointer data-[highlighted]:bg-accent-explore/10"
                        >
                          <span className="truncate">{type}</span>
                          <span className="ml-auto text-ink-muted tabular-nums">{rows.length.toLocaleString()}</span>
                        </DropdownMenu.Item>
                      ))}
                    </>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              type="button"
              className={cn(QUIET_BUTTON, 'ml-auto')}
              disabled={!lastUndo}
              onClick={() => store().undo()}
              aria-label={lastUndo ? `Undo: ${lastUndo.label}` : 'Nothing to undo'}
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Undo
            </button>
          </div>

          {/* Grow */}
          <section aria-label="Grow along lineage" className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] px-3 py-3">
            <div className="flex items-center gap-2">
              <Sprout className="w-3.5 h-3.5 text-accent-explore" aria-hidden="true" />
              <h4 className="text-[12px] font-semibold text-ink">Grow along lineage</h4>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">
              Bring in what feeds your picks, or what they feed.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <Segmented
                label="Direction"
                value={direction}
                onChange={setDirection}
                options={[
                  { value: 'upstream', label: 'Upstream', icon: <ArrowUp className="w-3 h-3" aria-hidden="true" /> },
                  { value: 'downstream', label: 'Downstream', icon: <ArrowDown className="w-3 h-3" aria-hidden="true" /> },
                ]}
              />
              <Segmented
                label="How far"
                value={depth}
                onChange={setDepth}
                options={[
                  { value: 'one', label: '1 step' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <label className="flex items-center gap-2 text-[11.5px] text-ink cursor-pointer select-none min-w-0">
                <Switch.Root
                  checked={reachBeyond}
                  onCheckedChange={(on) => store().setReachBeyond(on)}
                  className="relative w-7 h-4 flex-shrink-0 rounded-full bg-black/15 dark:bg-white/15 data-[state=checked]:bg-accent-explore transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
                >
                  <Switch.Thumb className="block w-3 h-3 rounded-full bg-white shadow translate-x-0.5 data-[state=checked]:translate-x-[14px] transition-transform" />
                </Switch.Root>
                <span className="truncate">Reach beyond this view</span>
              </label>
              <button
                type="button"
                onClick={() => onGrow(direction, depth)}
                disabled={growing || !!growBlockedReason}
                aria-describedby={growBlockedReason ? 'subset-grow-blocked' : undefined}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-accent-explore hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/50"
              >
                {growing && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Grow
              </button>
            </div>
            {reachBeyond && (
              <p className="mt-2 text-[11px] leading-snug text-ink-muted">
                Entities from outside this view come one step at a time and land in the layer the
                view&apos;s rules choose — or next to what they were grown from.
                {list.length > REACH_BEYOND_PICK_CAP && ` Reaches from your first ${REACH_BEYOND_PICK_CAP} picks.`}
              </p>
            )}
            {growBlockedReason && (
              <p id="subset-grow-blocked" className="mt-2 text-[11px] leading-snug text-ink-muted">{growBlockedReason}</p>
            )}
          </section>

          {/* The picks */}
          <section aria-label="Picked entities">
            <SectionTitle
              aside={<span className="text-[11px] text-ink-muted tabular-nums">{list.length.toLocaleString()} / {SUBSET_MEMBERS_MAX.toLocaleString()}</span>}
            >
              In the subset
            </SectionTitle>
            {list.length > 12 && (
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name or type…"
                  aria-label="Filter picked entities"
                  className="w-full pl-8 pr-3 py-1.5 text-[12px] rounded-lg bg-black/[0.04] dark:bg-white/[0.04] border border-black/[0.08] dark:border-white/[0.08] focus:border-accent-explore/50 outline-none transition-colors placeholder:text-ink-muted"
                />
              </div>
            )}
            <div className="space-y-2.5">
              {grouped.length === 0 && (
                <p className="px-1 py-2 text-[12px] text-ink-muted">Nothing picked matches.</p>
              )}
              {grouped.map(({ layer, picks: rows }) => {
                const shown = expanded[layer.id] ? rows : rows.slice(0, LAYER_PAGE)
                return (
                  <div key={layer.id}>
                    <div className="flex items-center gap-1.5 px-1 pb-1">
                      <LayerDot color={layer.color} />
                      <span className="text-[11.5px] font-semibold text-ink truncate">{layer.name}</span>
                      <span className="text-[11px] text-ink-muted tabular-nums">{rows.length.toLocaleString()}</span>
                      <button
                        type="button"
                        className={cn(ICON_BUTTON, 'ml-auto text-[10.5px] px-1.5')}
                        onClick={() => store().remove(rows.map(r => r.urn), `Remove everything from ${layer.name}`)}
                      >
                        Remove all
                      </button>
                    </div>
                    <ul className="rounded-lg border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
                      {shown.map(p => (
                        <li key={p.urn} className="group flex items-center gap-2 px-2.5 py-1.5 min-w-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="truncate text-[12px] text-ink" title={p.label}>{p.label}</span>
                              <OriginBadge origin={p.origin} />
                            </div>
                            {p.entityType && <p className="text-[10px] uppercase tracking-wider text-ink-muted">{p.entityType}</p>}
                          </div>
                          {p.origin !== 'outside' && (
                            <button type="button" className={ICON_BUTTON} aria-label={`Show ${p.label} on the canvas`} onClick={() => onLocate(p.urn)}>
                              <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          )}
                          <button type="button" className={ICON_BUTTON} aria-label={`Leave ${p.label} out`} onClick={() => store().toggle(p)}>
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {rows.length > shown.length && (
                      <button
                        type="button"
                        className={cn(QUIET_BUTTON, 'mt-1')}
                        onClick={() => setExpanded(e => ({ ...e, [layer.id]: true }))}
                      >
                        Show all {rows.length.toLocaleString()}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Segmented<T extends string>({ label, value, onChange, options }: {
  label: string
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; icon?: ReactNode }>
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.06]">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40',
            value === o.value ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
