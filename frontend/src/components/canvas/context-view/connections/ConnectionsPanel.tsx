/**
 * ConnectionsPanel — the Context View's bottom-right surface, replacing the
 * Edge Legend whose eye toggles changed nothing and whose counts were wrong.
 *
 * It says three different true things instead of one wrong one:
 *   - {relationships} connections — the underlying relationships in view,
 *     each bundle counted exactly once;
 *   - {drawn} drawn — the lines the overlay is actually painting right now,
 *     published by the overlay itself (never re-derived here);
 *   - {types} types — how many kinds of connection are on screen.
 *
 * A type carried by a connection that carries two types is counted in BOTH
 * rows and once in the total; the row tooltip says so, because a reader who
 * adds the rows up and gets more than the total deserves an explanation.
 *
 * Hiding is real: the projection drops those relationships, so a hidden
 * type's row keeps its name and swatch (to bring it back) but shows NO
 * count — there is no honest number left to show.
 *
 * A row is three lines, at the scale of the Data loads cards docked directly
 * above it (13px name and count, 11px below): the type and its count; the
 * ontology's sentence, wrapped and clamped to two lines; and the direction
 * split, the smallest print on the surface. The sentence used to share a line
 * with the split and lost — hard-truncated mid-word at the dock's 320px.
 *
 * Surface: an opaque elevated card. This panel animates its height inside
 * the canvas's bottom band, which is exactly where a blurred-backdrop
 * surface ghosts a mis-placed translucent tile in Chromium (the "white
 * strip"). Opacity gives the same separation without the mechanism, and
 * `noBackdropFilterInScrollers.test.ts` pins it at the source level.
 */
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Eye, EyeOff, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EdgeTypeDefinition } from '@/utils/edgeTypeUtils'
import { useDrawnEdgesStore } from '@/store/drawnEdges'
import { edgeDashArray } from '../edgeDash'
import type { ConnectionModel } from './connectionModel'

export interface ConnectionsPanelProps {
  /** Must be referentially stable (`useMemo` in the parent); a fresh identity
   *  each render re-emits the highlight. */
  model: ConnectionModel
  /** UPPERCASE keys currently hidden. The model never contains their
   *  bundles, so their rows render dimmed and WITHOUT a count. */
  hiddenTypes: ReadonlySet<string>
  /** Ontology lookup — label, description, color, strokeStyle. */
  resolveType: (type: string) => EdgeTypeDefinition
  /** False → the quiet "Lineage is off" state; no numbers. */
  lineageOn: boolean
  /** True during a trace — the footer says the toggles are trace-scoped. */
  traceMode?: boolean
  onToggleType: (type: string) => void
  onSoloType: (type: string, allTypes: string[]) => void
  onShowAll: () => void
  /** Bundle ids to highlight, or null to clear. */
  onHighlight: (bundleIds: ReadonlySet<string> | null) => void
  className?: string
  defaultExpanded?: boolean
}

const DIRECTION_TITLE = '→ flows with the layer order · ← flows back upstream · ⇄ both ways'
/** Browse subtracts when a type is hidden — the projection drops those
 *  relationships per member. A trace cannot: its lines carry a total rather
 *  than a list of what makes it up, so a line carrying a hidden type AND a
 *  visible one stays on the board at its full count. Said plainly on the row
 *  rather than left for the reader to notice as a number that will not move. */
const TRACE_COUNT_NOTE =
  ' During a trace, a connection that carries several types keeps its full count when one of them is hidden.'
const ROW_HINT = 'Hover a row to spotlight its connections · click to keep it lit.'

function Swatch({ def }: { def: EdgeTypeDefinition }) {
  return (
    <svg width="48" height="8" viewBox="0 0 48 8" className="flex-shrink-0" aria-hidden="true">
      <line
        x1="0"
        y1="4"
        x2="42"
        y2="4"
        stroke={def.color}
        strokeWidth="2"
        strokeDasharray={edgeDashArray(false, def.strokeStyle)}
      />
      <polygon points="42,1 48,4 42,7" fill={def.color} />
    </svg>
  )
}

export function ConnectionsPanel({
  model,
  hiddenTypes,
  resolveType,
  lineageOn,
  traceMode,
  onToggleType,
  onSoloType,
  onShowAll,
  onHighlight,
  className,
  defaultExpanded,
}: ConnectionsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false)
  const [pinnedType, setPinnedType] = useState<string | null>(null)
  const [hoveredType, setHoveredType] = useState<string | null>(null)
  const drawn = useDrawnEdgesStore((s) => s.drawn)

  // A pin must not outlive the thing it pinned. Hiding the type, switching
  // view or entering a trace all replace the model without remounting the
  // panel; without this the key survives and silently re-lights the board
  // the moment a same-named type comes back. Reconciled as the model
  // ARRIVES — React's "adjusting state when a prop changes", not an effect,
  // which would emit the stale highlight for one committed frame first.
  const [seenModel, setSeenModel] = useState(model)
  if (seenModel !== model) {
    setSeenModel(model)
    if (pinnedType && !model.rows.some((r) => r.type === pinnedType)) setPinnedType(null)
  }

  // Crossing INTO or OUT OF a trace replaces the whole board, and the panel
  // is deliberately not keyed on that — entering a trace must not collapse
  // it out from under the reader. So the pin and the hover are dropped
  // here: a browse bundle id means nothing to the trace's wires, and a
  // trace's means nothing to browse. Same idiom as the model above.
  const [seenTraceMode, setSeenTraceMode] = useState(Boolean(traceMode))
  if (seenTraceMode !== Boolean(traceMode)) {
    setSeenTraceMode(Boolean(traceMode))
    setPinnedType(null)
    setHoveredType(null)
  }

  const activeType = hoveredType ?? pinnedType
  const activeBundleIds = useMemo(() => {
    if (!activeType) return null
    const row = model.rows.find((r) => r.type === activeType)
    return row ? new Set(row.bundleIds) : null
  }, [activeType, model])

  useEffect(() => {
    onHighlight(activeBundleIds)
  }, [activeBundleIds, onHighlight])

  const togglePin = (type: string) => setPinnedType((p) => (p === type ? null : type))

  /** Every type the panel knows about — solo has to hide the hidden ones too. */
  const allTypes = useMemo(
    () => [...new Set([...model.rows.map((r) => r.type), ...hiddenTypes])],
    [model, hiddenTypes],
  )
  const hiddenList = useMemo(
    () => [...hiddenTypes].sort((a, b) => resolveType(a).label.localeCompare(resolveType(b).label)),
    [hiddenTypes, resolveType],
  )
  const hiddenCount = hiddenTypes.size

  const summary = !lineageOn
    ? 'Off'
    : hiddenCount > 0
      ? `${model.relationships.toLocaleString()} · ${hiddenCount} hidden`
      : model.relationships.toLocaleString()

  const showFooter = lineageOn && (hiddenCount > 0 || model.untyped > 0 || Boolean(traceMode))

  return (
    <div
      className={cn(
        'bg-canvas-elevated border border-glass-border shadow-lg rounded-xl overflow-hidden',
        className,
      )}
    >
      <button
        type="button"
        data-dock-header
        aria-expanded={isExpanded}
        onClick={() => {
          // React fires no mouseleave when the row list unmounts, so a hover
          // left standing here would dim the board behind a closed panel.
          setHoveredType(null)
          setIsExpanded((v) => !v)
        }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
      >
        <span className="flex items-center gap-2 min-w-0">
          <GitBranch className="w-4 h-4 text-accent-lineage flex-shrink-0" />
          <span className="text-sm font-medium text-ink">Connections</span>
          <span className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 tabular-nums whitespace-nowrap">
            {summary}
          </span>
        </span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-ink-muted flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-ink-muted flex-shrink-0" />
        )}
      </button>

      {isExpanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="overflow-hidden"
        >
          <div className="px-3 pb-3">
            {!lineageOn ? (
              <div className="py-3 text-center">
                <p className="text-xs font-medium text-ink">Lineage is off</p>
                <p className="text-2xs text-ink-muted mt-0.5">
                  Turn Lineage on in the header to see connections.
                </p>
              </div>
            ) : (
              <>
                <p className="text-2xs text-ink-muted tabular-nums pb-2">
                  {`${model.relationships.toLocaleString()} connections · ${drawn.toLocaleString()} drawn · ${model.typeCount} ${model.typeCount === 1 ? 'type' : 'types'}`}
                </p>

                <div
                  data-connection-rows
                  className="space-y-0.5 max-h-[45vh] overflow-y-auto custom-scrollbar"
                  onMouseLeave={() => setHoveredType(null)}
                >
                  {model.rows.length === 0 && (
                    <p className="text-xs text-ink-muted py-3 text-center">No connections in view</p>
                  )}

                  {model.rows.map((row) => {
                    const def = resolveType(row.type)
                    const isPinned = pinnedType === row.type
                    return (
                      <div
                        key={row.type}
                        data-connection-row={row.type}
                        title={`${def.label} — ${row.relationships.toLocaleString()} of the connections in view carry this type. A connection carrying more than one type is counted in each of its types.${traceMode ? TRACE_COUNT_NOTE : ''}`}
                        onMouseEnter={() => setHoveredType(row.type)}
                        onMouseLeave={() => setHoveredType(null)}
                        onClick={() => togglePin(row.type)}
                        className={cn(
                          'group/row flex flex-col gap-0.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors',
                          'hover:bg-black/5 dark:hover:bg-white/5',
                          isPinned && 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {/* The pin is a real button: a screen reader hears the
                              type's name, a role and whether it is pinned. It
                              cannot be the ROW — that holds the Eye and Only
                              buttons (nesting is invalid) and must not displace
                              the collapsed header as the first button in the
                              root. The row keeps the pointer conveniences
                              (hover spotlights, a click anywhere on it pins),
                              so this click stops there rather than counting
                              twice; focus does what hover does, which is also
                              what reveals the Only control. */}
                          <button
                            type="button"
                            aria-pressed={isPinned}
                            onClick={(e) => {
                              e.stopPropagation()
                              togglePin(row.type)
                            }}
                            onFocus={() => setHoveredType(row.type)}
                            onBlur={() => setHoveredType(null)}
                            className="flex-1 min-w-0 flex items-center gap-2 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                          >
                            <Swatch def={def} />
                            <span className="flex-1 min-w-0 text-[13px] font-medium text-ink truncate">{def.label}</span>
                            <span className="flex-shrink-0 text-[13px] font-semibold text-ink tabular-nums">
                              {row.relationships.toLocaleString()}
                            </span>
                          </button>
                          <button
                            type="button"
                            title="Hide this type"
                            onClick={(e) => {
                              e.stopPropagation()
                              onToggleType(row.type)
                            }}
                            className="flex-shrink-0 p-1 rounded text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </span>

                        {/* The ontology's sentence gets the line to itself and
                            WRAPS. Sharing it with the direction split left it
                            hard-truncated mid-word at the dock's 320px — a
                            description cut to "Many detailed flows…" explains
                            nothing. Two lines is the whole of every sentence
                            the ontology actually writes; the title carries the
                            rest for the rare one that is longer. */}
                        {def.description && (
                          <span
                            data-connection-description
                            title={def.description}
                            className="pl-14 text-[11px] leading-snug text-ink-muted line-clamp-2 break-words"
                          >
                            {def.description}
                          </span>
                        )}

                        {/* The split is the row's smallest print: its own line,
                            right-aligned under the count so the numbers read as
                            one column, and it yields its slot to `Only`. */}
                        <span className="flex items-center gap-2 pl-14">
                          <span
                            title={DIRECTION_TITLE}
                            className="ml-auto flex-shrink-0 text-[11px] text-ink-muted tabular-nums whitespace-nowrap group-hover/row:hidden group-focus-within/row:hidden"
                          >
                            {`→ ${row.forward.toLocaleString()} · ← ${row.backward.toLocaleString()}`}
                            {row.bidirectional > 0 ? ` · ⇄ ${row.bidirectional.toLocaleString()}` : ''}
                          </span>
                          <button
                            type="button"
                            data-connection-only
                            title="Show only this type"
                            onClick={(e) => {
                              e.stopPropagation()
                              onSoloType(row.type, allTypes)
                            }}
                            className="ml-auto hidden group-hover/row:inline-flex group-focus-within/row:inline-flex flex-shrink-0 items-center text-[11px] text-ink-muted hover:text-ink px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                          >
                            Only
                          </button>
                        </span>
                      </div>
                    )
                  })}

                  {hiddenList.map((type) => {
                    const def = resolveType(type)
                    return (
                      <div
                        key={`hidden-${type}`}
                        data-connection-row={type}
                        title={`${def.label} — hidden. Its connections are not drawn and not counted.`}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-lg opacity-45"
                      >
                        <Swatch def={def} />
                        <span className="flex-1 min-w-0 text-[13px] font-medium text-ink truncate">{def.label}</span>
                        <button
                          type="button"
                          title="Show this type"
                          onClick={() => onToggleType(type)}
                          className="flex-shrink-0 p-1 rounded text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 transition-colors"
                        >
                          <EyeOff className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>

                {(showFooter || model.rows.length > 0) && (
                  <div className="mt-2 pt-2 border-t border-glass-border space-y-1">
                    {showFooter && (
                      <div className="flex items-center justify-between gap-2">
                        {hiddenCount > 0 ? (
                          <button
                            type="button"
                            onClick={onShowAll}
                            className="text-2xs font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded"
                          >
                            Show all
                          </button>
                        ) : (
                          <span />
                        )}
                        <span className="text-2xs text-ink-muted text-right">
                          {model.untyped > 0 && (
                            <span className="tabular-nums">{`+${model.untyped.toLocaleString()} with no type`}</span>
                          )}
                          {model.untyped > 0 && traceMode && <span> · </span>}
                          {traceMode && <span>Applies to this trace only.</span>}
                        </span>
                      </div>
                    )}
                    {model.rows.length > 0 && (
                      <p className="text-[10px] text-ink-muted/60">{ROW_HINT}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      )}
    </div>
  )
}

export default ConnectionsPanel
