import { ArrowUp, ArrowDown, ChevronDown, Layers, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TraceConfig } from '@/hooks/useUnifiedTrace'
import { FULL_WALK_INITIAL_DEPTH } from '@/hooks/useLensWalk'
import { TraceDockSlider } from './TraceDockSlider'
import { TraceDockEdgeFilter } from './TraceDockEdgeFilter'

/** The native engine's "apply": there is nothing to apply. Depth already
 *  re-projected on change; the only thing `onApply` could still reach is
 *  `continueWalk`, which grants budget and re-arms failed frontiers — a
 *  network round-trip behind a control whose contract is that it makes none.
 *  Continuing an unfinished walk belongs to the truncation notice. */
const NO_APPLY = (): void => {}

export interface GranularityOption {
  id: string
  name: string
  level: number
}

export interface TraceDockControlsProps {
  config: TraceConfig
  granularityOptions: GranularityOption[]
  availableEdgeTypes: string[]
  resolveEdgeColor: (edgeType: string) => string
  onChangeConfig: (patch: Partial<TraceConfig>) => void
  onApply: () => void
  /** Driven by the NATIVE trace engine, which walks the whole flow once and
   *  answers every later question from the model it already holds. The
   *  edge-type filter and the hierarchy level are parameters of a /trace/v2
   *  request that will never be made, so they are withdrawn rather than left
   *  on screen doing nothing. */
  nativeMode?: boolean
}

/**
 * Settings tab controls — 2x2 grid:
 *   [ Upstream slider     ]  [ Downstream slider   ]
 *   [ Hierarchy level sel ]  [ Edge filter         ]
 *
 * …and in `nativeMode`, only the top row: the bottom two configure a fetch
 * the native engine does not make.
 *
 * Each control opens with a 6x6 gradient icon container + 10px eyebrow,
 * matching the app's premium pattern. The Level select is a styled
 * gradient pill with a custom chevron (mirroring the lineage-flow
 * granularity select that used to live in ContextViewHeader).
 */
export function TraceDockControls({
  config,
  granularityOptions,
  availableEdgeTypes,
  resolveEdgeColor,
  onChangeConfig,
  onApply,
  nativeMode = false,
}: TraceDockControlsProps) {
  // The other `onApply` callers (edge filter, level select) are withdrawn in
  // native mode already; the sliders are the one control that survives, so
  // this is the whole seam.
  const commit = nativeMode ? NO_APPLY : onApply
  const isAllSelected = config.lineageEdgeTypes.length === 0
  const effectiveSet = new Set(isAllSelected ? availableEdgeTypes : config.lineageEdgeTypes)

  const toggleEdgeType = (edgeType: string) => {
    const next = new Set(effectiveSet)
    if (next.has(edgeType)) next.delete(edgeType)
    else next.add(edgeType)
    onChangeConfig({
      lineageEdgeTypes: next.size === availableEdgeTypes.length ? [] : Array.from(next),
    })
    onApply()
  }

  const selectAll = () => {
    onChangeConfig({ lineageEdgeTypes: [] })
    onApply()
  }

  const levelValue = typeof config.level === 'string' || typeof config.level === 'number'
    ? String(config.level)
    : 'auto'

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
      <TraceDockSlider
        label="Upstream depth"
        icon={<ArrowUp className="w-3.5 h-3.5" strokeWidth={2.4} />}
        accent="blue"
        value={config.upstreamDepth}
        max={nativeMode ? FULL_WALK_INITIAL_DEPTH : undefined}
        onChange={v => onChangeConfig({ upstreamDepth: v })}
        onCommit={commit}
      />

      <TraceDockSlider
        label="Downstream depth"
        icon={<ArrowDown className="w-3.5 h-3.5" strokeWidth={2.4} />}
        accent="emerald"
        value={config.downstreamDepth}
        max={nativeMode ? FULL_WALK_INITIAL_DEPTH : undefined}
        onChange={v => onChangeConfig({ downstreamDepth: v })}
        onCommit={commit}
      />

      {!nativeMode && (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
              'bg-accent-lineage border border-accent-lineage',
            )}
          >
            <Layers className="w-3.5 h-3.5 text-white" strokeWidth={2.4} />
          </div>
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-ink">
            Hierarchy level
          </span>
        </div>
        <div className="relative">
          <select
            value={levelValue}
            onChange={e => {
              const v = e.target.value
              const next: TraceConfig['level'] = v === 'auto' ? 'auto' : v
              onChangeConfig({ level: next })
              onApply()
            }}
            className={cn(
              'w-full appearance-none px-3 pr-9 h-9 rounded-xl',
              'bg-white/[0.08] border border-white/[0.15]',
              'text-xs text-ink font-semibold tracking-tight',
              'cursor-pointer transition-all duration-200',
              'hover:bg-white/[0.14] hover:border-accent-lineage/40',
              'focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage/50',
            )}
          >
            <option value="auto">Auto · Match focus level</option>
            {granularityOptions
              .slice()
              .sort((a, b) => a.level - b.level)
              .map(opt => (
                <option key={opt.id} value={opt.id}>
                  {opt.name} · L{opt.level}
                </option>
              ))}
          </select>
          <ChevronDown
            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink pointer-events-none"
            strokeWidth={2.4}
            aria-hidden
          />
        </div>
      </div>
      )}

      {!nativeMode && (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
              'bg-accent-lineage border border-accent-lineage',
            )}
          >
            <Filter className="w-3.5 h-3.5 text-white" strokeWidth={2.4} />
          </div>
          <span className="text-[11px] uppercase tracking-[0.14em] font-bold text-ink">
            Edge types
          </span>
        </div>
        <div className="min-w-0">
          <TraceDockEdgeFilter
            availableEdgeTypes={availableEdgeTypes}
            effectiveSet={effectiveSet}
            resolveEdgeColor={resolveEdgeColor}
            onToggle={toggleEdgeType}
            onSelectAll={selectAll}
          />
        </div>
      </div>
      )}
    </div>
  )
}
