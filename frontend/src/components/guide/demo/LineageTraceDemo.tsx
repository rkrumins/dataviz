import { useMemo, useRef, useState } from 'react'
import {
  Database,
  Radio,
  Boxes,
  LayoutDashboard,
  Gauge,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * LineageTraceDemo — a self-contained, backend-free "learn tracing by doing"
 * widget embedded in the User Guide. Click a node to trace its lineage:
 * everything UPSTREAM (what feeds it) lights blue, everything DOWNSTREAM
 * (what it feeds) lights green, the selected node glows gold, and the rest
 * dims. Mirrors the real canvas visual language (GenericNode / LineageEdge).
 *
 * Fixed coordinate space (720 x 278) rendered at a fixed size inside a
 * horizontal-scroll container — edges (SVG) and node cards (absolutely
 * positioned HTML) share the same pixel grid so endpoints always align.
 */

// Trace palette — the exact values used by the live canvas.
const GOLD = '#fbbf24' // focus / selected
const BLUE = '#60a5fa' // upstream
const GREEN = '#4ade80' // downstream
const INDIGO = '#6366f1' // idle edge accent (accent-lineage)
const GREY = '#9ca3af' // dimmed edge

type Kind = 'source' | 'model' | 'consumer'

interface NodeDef {
  id: string
  label: string
  badge: string
  kind: Kind
  color: string
  icon: LucideIcon
  x: number
  y: number
}

const NODE_W = 146
const NODE_H = 56
const VIEW_W = 720
const VIEW_H = 278

const NODES: NodeDef[] = [
  { id: 'orders_raw', label: 'orders_raw', badge: 'Postgres', kind: 'source', color: INDIGO, icon: Database, x: 8, y: 44 },
  { id: 'payments_raw', label: 'payments_raw', badge: 'Kafka', kind: 'source', color: '#06b6d4', icon: Radio, x: 8, y: 206 },
  { id: 'orders_clean', label: 'orders_clean', badge: 'dbt', kind: 'model', color: '#10b981', icon: Boxes, x: 192, y: 44 },
  { id: 'revenue_daily', label: 'revenue_daily', badge: 'dbt', kind: 'model', color: '#10b981', icon: Boxes, x: 386, y: 128 },
  { id: 'finance_dashboard', label: 'Finance Dashboard', badge: 'Dashboard', kind: 'consumer', color: '#f59e0b', icon: LayoutDashboard, x: 566, y: 52 },
  { id: 'exec_kpi', label: 'Exec KPI', badge: 'KPI', kind: 'consumer', color: '#f59e0b', icon: Gauge, x: 566, y: 198 },
]

interface EdgeDef {
  from: string
  to: string
}

const EDGES: EdgeDef[] = [
  { from: 'orders_raw', to: 'orders_clean' },
  { from: 'orders_clean', to: 'revenue_daily' },
  { from: 'payments_raw', to: 'revenue_daily' },
  { from: 'revenue_daily', to: 'finance_dashboard' },
  { from: 'revenue_daily', to: 'exec_kpi' },
]

const BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<string, NodeDef>

// Right-center (outgoing) and left-center (incoming) anchor points.
const rightAnchor = (n: NodeDef): [number, number] => [n.x + NODE_W, n.y + NODE_H / 2]
const leftAnchor = (n: NodeDef): [number, number] => [n.x, n.y + NODE_H / 2]

/** Smooth left→right cubic bezier between two anchor points. */
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(30, (x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

type NodeState = 'focus' | 'upstream' | 'downstream' | 'dimmed' | 'idle'
type EdgeState = 'upstream' | 'downstream' | 'dimmed' | 'idle'

/** Ordered for arrow-key roving (columns, then rows). */
const NAV_ORDER = NODES.map((n) => n.id)

export function LineageTraceDemo() {
  const [selected, setSelected] = useState<string | null>(null)
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Ancestors (upstream) and descendants (downstream) of the selected node.
  const { upstream, downstream } = useMemo(() => {
    const up = new Set<string>()
    const down = new Set<string>()
    if (!selected) return { upstream: up, downstream: down }

    const parentsOf = (id: string) => EDGES.filter((e) => e.to === id).map((e) => e.from)
    const childrenOf = (id: string) => EDGES.filter((e) => e.from === id).map((e) => e.to)

    const walk = (id: string, next: (id: string) => string[], seen: Set<string>) => {
      for (const n of next(id)) {
        if (!seen.has(n)) {
          seen.add(n)
          walk(n, next, seen)
        }
      }
    }
    walk(selected, parentsOf, up)
    walk(selected, childrenOf, down)
    return { upstream: up, downstream: down }
  }, [selected])

  const nodeState = (id: string): NodeState => {
    if (!selected) return 'idle'
    if (id === selected) return 'focus'
    if (upstream.has(id)) return 'upstream'
    if (downstream.has(id)) return 'downstream'
    return 'dimmed'
  }

  const edgeState = (e: EdgeDef): EdgeState => {
    if (!selected) return 'idle'
    const upEdge = upstream.has(e.from) && (e.to === selected || upstream.has(e.to))
    if (upEdge) return 'upstream'
    const downEdge = downstream.has(e.to) && (e.from === selected || downstream.has(e.from))
    if (downEdge) return 'downstream'
    return 'dimmed'
  }

  const caption = useMemo(() => {
    if (!selected) return null
    const n = BY_ID[selected]
    const srcCount = [...upstream].filter((id) => BY_ID[id].kind === 'source').length
    const consCount = [...downstream].filter((id) => BY_ID[id].kind === 'consumer').length
    const plural = (n: number) => (n === 1 ? '' : 's')

    if (upstream.size === 0) {
      return `${n.label} is a source — it feeds ${downstream.size} downstream asset${plural(downstream.size)} across the pipeline.`
    }
    if (downstream.size === 0) {
      return `${n.label} is a consumer — it draws on ${srcCount} source${plural(srcCount)}; if any of them break, it breaks.`
    }
    return `${n.label} draws from ${srcCount} source${plural(srcCount)} and feeds ${consCount} consumer${plural(consCount)} — its blast radius.`
  }, [selected, upstream, downstream])

  const handleKey = (index: number) => (e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
        : 0
    if (delta === 0) return
    e.preventDefault()
    const next = (index + delta + NAV_ORDER.length) % NAV_ORDER.length
    btnRefs.current[next]?.focus()
  }

  return (
    <figure className="not-prose my-5 rounded-xl border border-glass-border bg-canvas-elevated/50 p-4">
      {/* Caption / guided nudge + reset */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="min-h-[2.5rem] flex-1 text-sm leading-relaxed text-ink-muted" aria-live="polite">
          {selected ? (
            <span className="text-ink">{caption}</span>
          ) : (
            <span>👆 Click a node to see what it depends on and what breaks if it changes.</span>
          )}
        </p>
        {selected && (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1 text-xs text-ink-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset
          </button>
        )}
      </div>

      {/* Graph */}
      <div className="overflow-x-auto">
        <div className="relative mx-auto" style={{ width: VIEW_W, height: VIEW_H }}>
          {/* Tier labels */}
          <TierLabel label="Sources" left={81} />
          <TierLabel label="Models" left={362} />
          <TierLabel label="Consumers" left={639} />

          {/* Edges */}
          <svg
            className="pointer-events-none absolute inset-0"
            width={VIEW_W}
            height={VIEW_H}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            aria-hidden
          >
            <defs>
              <linearGradient id="ltd-grad-base" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={INDIGO} stopOpacity={0.4} />
                <stop offset="50%" stopColor={INDIGO} stopOpacity={1} />
                <stop offset="100%" stopColor={INDIGO} stopOpacity={0.4} />
              </linearGradient>
              {[
                ['base', INDIGO],
                ['up', BLUE],
                ['down', GREEN],
                ['dim', GREY],
              ].map(([key, color]) => (
                <marker
                  key={key}
                  id={`ltd-arw-${key}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill={color} />
                </marker>
              ))}
            </defs>

            {EDGES.map((e) => {
              const from = BY_ID[e.from]
              const to = BY_ID[e.to]
              const [x1, y1] = rightAnchor(from)
              const [x2, y2] = leftAnchor(to)
              const d = bezierPath(x1, y1, x2, y2)
              const st = edgeState(e)
              const traced = st === 'upstream' || st === 'downstream'
              const color = st === 'upstream' ? BLUE : st === 'downstream' ? GREEN : INDIGO
              const marker = st === 'upstream' ? 'up' : st === 'downstream' ? 'down' : st === 'dimmed' ? 'dim' : 'base'

              return (
                <g key={`${e.from}-${e.to}`}>
                  <path
                    d={d}
                    fill="none"
                    strokeLinecap="round"
                    stroke={!selected ? 'url(#ltd-grad-base)' : traced ? color : GREY}
                    strokeWidth={traced ? 2.5 : st === 'dimmed' ? 1 : 1.5}
                    strokeOpacity={st === 'dimmed' ? 0.15 : traced ? 0.95 : 0.85}
                    markerEnd={`url(#ltd-arw-${marker})`}
                    style={{ transition: 'stroke-width .3s ease, stroke-opacity .3s ease' }}
                  />
                  {/* Marching-dash flow overlay on traced edges */}
                  {traced && (
                    <path
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeWidth={2.5}
                      strokeOpacity={0.9}
                      strokeLinecap="round"
                      strokeDasharray="8 4"
                      className="animate-flow"
                    />
                  )}
                </g>
              )
            })}
          </svg>

          {/* Node cards */}
          {NODES.map((n, i) => {
            const st = nodeState(n.id)
            const accent = st === 'focus' ? GOLD : st === 'upstream' ? BLUE : st === 'downstream' ? GREEN : n.color
            const Icon = n.icon
            return (
              <button
                key={n.id}
                ref={(el) => { btnRefs.current[i] = el }}
                type="button"
                onClick={() => setSelected((prev) => (prev === n.id ? null : n.id))}
                onKeyDown={handleKey(i)}
                aria-pressed={selected === n.id}
                aria-label={`${n.label}, ${n.badge}${st !== 'idle' && st !== 'focus' ? `. ${st}` : ''}. Trace lineage.`}
                className={cn(
                  'group absolute flex items-center gap-2 rounded-xl border border-glass-border px-2.5 text-left',
                  'transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage',
                  st === 'focus' && 'z-10 scale-[1.04] bg-amber-50 ring-2 ring-amber-400 shadow-[0_6px_20px_rgba(251,191,36,0.35)] dark:bg-amber-950/40',
                  st === 'upstream' && 'bg-blue-50 ring-2 ring-blue-400 shadow-[0_4px_14px_rgba(96,165,250,0.28)] dark:bg-blue-950/40',
                  st === 'downstream' && 'bg-green-50 ring-2 ring-green-400 shadow-[0_4px_14px_rgba(74,222,128,0.28)] dark:bg-green-950/40',
                  st === 'dimmed' && 'bg-canvas-elevated opacity-40 grayscale',
                  st === 'idle' && 'bg-canvas-elevated shadow-sm hover:-translate-y-0.5 hover:ring-2 hover:ring-accent-lineage/40',
                )}
                style={{
                  left: n.x,
                  top: n.y,
                  width: NODE_W,
                  height: NODE_H,
                  borderLeftWidth: 4,
                  borderLeftColor: accent,
                }}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${n.color}15` }}
                >
                  <Icon className="h-4 w-4" style={{ color: n.color }} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[9px] font-semibold uppercase tracking-wider" style={{ color: n.color }}>
                    {n.badge}
                  </span>
                  <span className="block truncate text-[13px] font-semibold leading-tight text-ink">
                    {n.label}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-muted">
        <LegendSwatch color={BLUE} label="Upstream — what feeds it" />
        <LegendSwatch color={GOLD} label="Selected" />
        <LegendSwatch color={GREEN} label="Downstream — what it feeds" />
      </div>
    </figure>
  )
}

function TierLabel({ label, left }: { label: string; left: number }) {
  return (
    <span
      className="absolute top-0 -translate-x-1/2 text-[9px] font-semibold uppercase tracking-wider text-ink-muted"
      style={{ left }}
    >
      {label}
    </span>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

export default LineageTraceDemo
