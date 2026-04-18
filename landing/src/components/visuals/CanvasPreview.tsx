import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

/*
 * Compact, realistic canvas preview showing a mini lineage graph
 * with proper node cards, bezier edges, trace glow, a toolbar,
 * selection state, and a minimap. Designed to convey "this is an
 * interactive design tool, not a static diagram."
 */

interface Node {
  id: string; x: number; y: number; w: number; h: number
  label: string; type: string; color: string; secondary?: string
}

const NODES: Node[] = [
  { id: 'a', x: 10, y: 24, w: 100, h: 40, label: 'raw_events', type: 'SOURCE', color: '#10b981', secondary: 'Kafka' },
  { id: 'b', x: 10, y: 100, w: 100, h: 40, label: 'customer_db', type: 'DATABASE', color: '#3b82f6', secondary: 'Postgres' },
  { id: 'c', x: 160, y: 14, w: 110, h: 46, label: 'dim_customers', type: 'TABLE', color: '#3b82f6', secondary: '12 columns' },
  { id: 'd', x: 160, y: 90, w: 110, h: 40, label: 'fct_orders', type: 'TABLE', color: '#3b82f6', secondary: '8 columns' },
  { id: 'e', x: 160, y: 160, w: 110, h: 40, label: 'stg_payments', type: 'TABLE', color: '#8b5cf6', secondary: 'dbt model' },
  { id: 'f', x: 322, y: 30, w: 108, h: 40, label: 'Customer 360', type: 'DASHBOARD', color: '#06b6d4', secondary: 'Looker' },
  { id: 'g', x: 322, y: 100, w: 108, h: 40, label: 'churn_model', type: 'ML MODEL', color: '#f59e0b', secondary: 'v2.1' },
  { id: 'h', x: 322, y: 170, w: 108, h: 40, label: 'rev_report', type: 'REPORT', color: '#8b5cf6', secondary: 'Finance' },
]

// Selected/focus node
const FOCUS = 'c'

// Trace states
const UPSTREAM = new Set(['a', 'b'])
const DOWNSTREAM = new Set(['f', 'g'])
const DIMMED = new Set(['e', 'h'])

interface Edge { from: string; to: string }
const EDGES: Edge[] = [
  { from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'b', to: 'd' },
  { from: 'a', to: 'd' }, { from: 'c', to: 'f' }, { from: 'c', to: 'g' },
  { from: 'd', to: 'g' }, { from: 'd', to: 'h' }, { from: 'b', to: 'e' },
]

function getNode(id: string) { return NODES.find(n => n.id === id)! }

function nodeState(id: string): 'focus' | 'upstream' | 'downstream' | 'dimmed' | 'normal' {
  if (id === FOCUS) return 'focus'
  if (UPSTREAM.has(id)) return 'upstream'
  if (DOWNSTREAM.has(id)) return 'downstream'
  if (DIMMED.has(id)) return 'dimmed'
  return 'normal'
}

const RING: Record<string, { color: string; glow: string }> = {
  focus: { color: '#fbbf24', glow: 'rgba(251,191,36,0.3)' },
  upstream: { color: '#60a5fa', glow: 'rgba(96,165,250,0.2)' },
  downstream: { color: '#4ade80', glow: 'rgba(74,222,128,0.2)' },
}

function edgeColor(fromId: string, toId: string): string {
  const fs = nodeState(fromId), ts = nodeState(toId)
  if (fs === 'upstream' && (ts === 'focus' || ts === 'upstream')) return '#60a5fa'
  if ((fs === 'focus' || fs === 'downstream') && ts === 'downstream') return '#4ade80'
  return 'var(--nx-text-muted)'
}

function isEdgeDimmed(fromId: string, toId: string): boolean {
  return nodeState(fromId) === 'dimmed' || nodeState(toId) === 'dimmed'
}

function NodeCard({ n, delay }: { n: Node; delay: number }) {
  const state = nodeState(n.id)
  const ring = RING[state]
  const isDimmed = state === 'dimmed'

  return (
    <motion.g
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: isDimmed ? 0.3 : 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      style={{ filter: isDimmed ? 'grayscale(0.5)' : undefined }}
    >
      {/* Glow ring */}
      {ring && (
        <rect
          x={n.x - 2.5} y={n.y - 2.5} width={n.w + 5} height={n.h + 5}
          rx={10} fill="none" stroke={ring.color}
          strokeWidth={state === 'focus' ? 2.5 : 2} opacity={0.65}
        >
          {state === 'focus' && (
            <animate attributeName="opacity" values="0.5;0.9;0.5" dur="2.5s" repeatCount="indefinite" />
          )}
        </rect>
      )}
      {/* Shadow */}
      <rect x={n.x + 0.5} y={n.y + 1.5} width={n.w} height={n.h} rx={8} fill="black" opacity={0.05} />
      {/* Card */}
      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={8} fill="var(--nx-bg-elevated)" stroke={n.color} strokeWidth={1.2} />
      {/* Left accent */}
      <rect x={n.x} y={n.y + 6} width={2.5} height={n.h - 12} rx={1.25} fill={n.color} />
      {/* Icon bg */}
      <rect x={n.x + 8} y={n.y + 7} width={12} height={12} rx={3.5} fill={n.color} opacity={0.12} />
      <circle cx={n.x + 14} cy={n.y + 13} r={2} fill={n.color} />
      {/* Type label */}
      <text x={n.x + 25} y={n.y + 13} fontSize="4" fontWeight="600" fill={n.color} fontFamily="Inter, system-ui" letterSpacing="0.5">
        {n.type}
      </text>
      {/* Name */}
      <text x={n.x + 8} y={n.y + 26} fontSize="7" fontWeight="600" fill="var(--nx-text-primary)" fontFamily="Inter, system-ui">
        {n.label}
      </text>
      {/* Secondary */}
      {n.secondary && (
        <text x={n.x + 8} y={n.y + 34} fontSize="4.5" fill="var(--nx-text-muted)" fontFamily="JetBrains Mono, monospace">
          {n.secondary}
        </text>
      )}
      {/* Handles */}
      <circle cx={n.x} cy={n.y + n.h / 2} r={2.5} fill="var(--nx-bg-elevated)" stroke={n.color} strokeWidth={1} />
      <circle cx={n.x + n.w} cy={n.y + n.h / 2} r={2.5} fill="var(--nx-bg-elevated)" stroke={n.color} strokeWidth={1} />
    </motion.g>
  )
}

export function CanvasPreview() {
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div className="glass-panel rounded-2xl overflow-hidden max-w-[460px] mx-auto w-full" role="img" aria-label="Interactive lineage canvas showing trace from raw_events through dim_customers to Customer 360 dashboard">
      {/* ── Toolbar ───────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--nx-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-[#ff5f57]" />
            <div className="w-2 h-2 rounded-full bg-[#febc2e]" />
            <div className="w-2 h-2 rounded-full bg-[#28c840]" />
          </div>
          <div className="flex items-center gap-1 ml-1.5">
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--nx-accent-lineage)" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span className="text-2xs font-semibold text-ink">Pipeline Overview</span>
            <span className="text-2xs px-1 py-0.5 rounded bg-accent-lineage/10 text-accent-lineage font-medium">Graph</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-canvas">
            <span className="w-1 h-1 rounded-full bg-accent-business" />
            Overview
          </div>
          <div className="text-2xs text-ink-muted px-1 py-0.5 rounded bg-canvas">Table</div>
        </div>
      </div>

      {/* ── Canvas ─────────────────────────────────────────── */}
      <div className="relative">
        <svg viewBox="0 0 440 220" className="w-full h-auto">
          {/* Grid */}
          <defs>
            <pattern id="cv-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="8" cy="8" r="0.5" fill="var(--nx-text-muted)" opacity="0.12" />
            </pattern>
            <linearGradient id="cv-up" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.7" />
            </linearGradient>
            <linearGradient id="cv-down" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#4ade80" stopOpacity="0.3" />
            </linearGradient>
          </defs>
          <rect width="440" height="220" fill="var(--nx-bg-canvas)" />
          <rect width="440" height="220" fill="url(#cv-grid)" />

          {/* ── Edges ─────────────────────────────────────── */}
          {EDGES.map((e, i) => {
            const a = getNode(e.from), b = getNode(e.to)
            const ax = a.x + a.w, ay = a.y + a.h / 2
            const bx = b.x, by = b.y + b.h / 2
            const cpx = (ax + bx) / 2
            const path = `M ${ax} ${ay} C ${cpx} ${ay}, ${cpx} ${by}, ${bx} ${by}`
            const dimmed = isEdgeDimmed(e.from, e.to)
            const color = edgeColor(e.from, e.to)
            const key = `${e.from}-${e.to}`
            const isHov = hovered === key

            // Gradient for traced edges
            const fs = nodeState(e.from), ts = nodeState(e.to)
            const isUpTrace = fs === 'upstream' && (ts === 'focus' || ts === 'upstream')
            const isDownTrace = (fs === 'focus' || fs === 'downstream') && ts === 'downstream'
            let strokeColor: string = color
            if (isUpTrace) strokeColor = 'url(#cv-up)'
            else if (isDownTrace) strokeColor = 'url(#cv-down)'

            return (
              <g key={key} onMouseEnter={() => setHovered(key)} onMouseLeave={() => setHovered(null)}>
                {/* Base */}
                <path d={path} stroke="var(--nx-text-muted)" strokeWidth="1.2" fill="none" opacity={dimmed ? 0.06 : 0.12} />
                {/* Main */}
                <path d={path} stroke={strokeColor} strokeWidth={isHov ? 2.5 : dimmed ? 0.8 : 1.5} fill="none" opacity={dimmed ? 0.15 : 0.65} />
                {/* Flow particles */}
                {!dimmed && (
                  <motion.path
                    d={path} stroke={color} strokeWidth={1} fill="none"
                    strokeDasharray="2.5 7" opacity={0.45}
                    animate={{ strokeDashoffset: [10, 0] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'linear', delay: i * 0.15 }}
                  />
                )}
              </g>
            )
          })}

          {/* ── Nodes ─────────────────────────────────────── */}
          {NODES.map((n, i) => (
            <NodeCard key={n.id} n={n} delay={0.1 + i * 0.04} />
          ))}

          {/* ── Focus node toolbar ────────────────────────── */}
          <motion.g initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}>
            <rect x={172} y={0} width={86} height={12} rx={4} fill="var(--nx-bg-glass)" stroke="var(--nx-border-glass)" strokeWidth={0.4} />
            {/* Trace up */}
            <g transform="translate(178, 1.5) scale(0.35)">
              <path d="M7 17l9.2-9.2M17 17V7H7" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            {/* Trace down */}
            <g transform="translate(190, 1.5) scale(0.35)">
              <path d="M17 7L7.8 16.2M7 7v10h10" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            <line x1="204" y1="2" x2="204" y2="10" stroke="var(--nx-border-subtle)" strokeWidth="0.4" />
            {/* Expand */}
            <g transform="translate(210, 2) scale(0.32)">
              <path d="M6 9l6 6 6-6" fill="none" stroke="var(--nx-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            {/* Pin */}
            <g transform="translate(224, 2) scale(0.32)">
              <circle cx="12" cy="8" r="3" fill="none" stroke="var(--nx-text-muted)" strokeWidth="2.5" />
              <path d="M12 11v7" fill="none" stroke="var(--nx-text-muted)" strokeWidth="2.5" strokeLinecap="round" />
            </g>
            {/* More */}
            <g transform="translate(238, 2) scale(0.3)">
              <circle cx="5" cy="12" r="1.5" fill="var(--nx-text-muted)" />
              <circle cx="12" cy="12" r="1.5" fill="var(--nx-text-muted)" />
              <circle cx="19" cy="12" r="1.5" fill="var(--nx-text-muted)" />
            </g>
          </motion.g>

          {/* ── Trace legend (bottom-left) ─────────────────── */}
          <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }}>
            <rect x={8} y={186} width={90} height={26} rx={6} fill="var(--nx-bg-glass)" stroke="var(--nx-border-glass)" strokeWidth={0.4} />
            <circle cx={16} cy={195} r={2.5} fill="#fbbf24" />
            <text x={22} y={197} fontSize="4.5" fontWeight="500" fill="var(--nx-text-secondary)" fontFamily="Inter, system-ui">Focus: dim_customers</text>
            <circle cx={16} cy={205} r={1.5} fill="#60a5fa" />
            <text x={22} y={207} fontSize="4" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui">↑2 upstream · ↓2 downstream</text>
          </motion.g>

          {/* ── Cursor indicator ───────────────────────────── */}
          <motion.g
            animate={{ x: [0, 4, 0], y: [0, -2, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <g transform="translate(200, 52)">
              <path d="M0 0l5 12 2.5-4.5L12 10 8.5 7l-3 2.5z" fill="var(--nx-text-primary)" opacity="0.5" />
            </g>
          </motion.g>
        </svg>

        {/* ── Minimap ──────────────────────────────────────── */}
        <div className="absolute bottom-1.5 right-1.5 w-16 h-10 rounded-md glass-panel p-0.5 opacity-60">
          <svg viewBox="0 0 440 220" className="w-full h-full">
            {NODES.map(n => {
              const s = nodeState(n.id)
              return (
                <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx={3}
                  fill={n.color} opacity={s === 'dimmed' ? 0.1 : 0.35} />
              )
            })}
            <rect x={5} y={5} width={430} height={210} rx={3} fill="none" stroke="var(--nx-accent-lineage)" strokeWidth={5} opacity={0.3} />
          </svg>
        </div>
      </div>

      {/* ── Status bar ──────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-[var(--nx-border-subtle)] text-2xs text-ink-muted">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-0.5">
            <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            Left → Right
          </span>
          <span className="opacity-30">|</span>
          <span>overview · table</span>
        </div>
        <div className="flex items-center gap-2">
          <span>8 entities · 9 edges</span>
          <span className="opacity-30">|</span>
          <AnimatePresence mode="wait">
            <motion.span
              key="trace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-1"
            >
              <span className="text-[#60a5fa]">↑2</span> · <span className="text-[#4ade80]">↓2</span>
              <span className="opacity-30">|</span>
              <span className="w-1 h-1 rounded-full bg-[#fbbf24]" />
              Tracing
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
