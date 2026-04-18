import { useState } from 'react'
import { motion } from 'framer-motion'

/*
 * Realistic product canvas preview.
 * Matches the actual GenericNode, LineageEdge, and toolbar designs
 * from the Synodic React Flow canvas — with real entity types, colors,
 * trace states, bezier edges, and a toolbar/stats bar mockup.
 */

// ── Real entity types matching the product ontology ────────────────
interface CanvasNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  label: string
  type: string
  typeLabel: string
  color: string
  icon: string      // Lucide icon name (rendered as SVG path)
  secondary?: string
  state: 'focus' | 'upstream' | 'downstream' | 'dimmed' | 'normal'
  children?: number
}

const NODES: CanvasNode[] = [
  // Upstream sources
  { id: 'db1', x: 16, y: 36, w: 140, h: 58, label: 'customer_db', type: 'database', typeLabel: 'DATABASE', color: '#3b82f6', icon: 'database', secondary: 'postgres://prod:5432', state: 'upstream' },
  { id: 'db2', x: 16, y: 118, w: 140, h: 58, label: 'events_stream', type: 'pipeline', typeLabel: 'PIPELINE', color: '#10b981', icon: 'workflow', secondary: 'kafka://events-v3', state: 'upstream' },
  { id: 'db3', x: 16, y: 200, w: 140, h: 58, label: 'payments_api', type: 'application', typeLabel: 'APPLICATION', color: '#06b6d4', icon: 'server', secondary: 'stripe-webhook', state: 'dimmed' },
  // Transform layer
  { id: 'tr1', x: 210, y: 56, w: 146, h: 68, label: 'dim_customers', type: 'table', typeLabel: 'TABLE', color: '#3b82f6', icon: 'table', secondary: 'analytics.dim_customers', state: 'focus', children: 12 },
  { id: 'tr2', x: 210, y: 156, w: 146, h: 58, label: 'fct_transactions', type: 'table', typeLabel: 'TABLE', color: '#3b82f6', icon: 'table', secondary: 'analytics.fct_transactions', state: 'downstream' },
  // Output
  { id: 'out1', x: 412, y: 36, w: 140, h: 58, label: 'Customer 360', type: 'dashboard', typeLabel: 'DASHBOARD', color: '#06b6d4', icon: 'layout', secondary: 'Looker › Exec Board', state: 'downstream' },
  { id: 'out2', x: 412, y: 118, w: 140, h: 58, label: 'churn_model_v2', type: 'dataset', typeLabel: 'DATASET', color: '#f59e0b', icon: 'package', secondary: 'ml.churn_prediction', state: 'downstream' },
  { id: 'out3', x: 412, y: 200, w: 140, h: 58, label: 'revenue_report', type: 'dataset', typeLabel: 'DATASET', color: '#f59e0b', icon: 'package', secondary: 'finance.monthly_rev', state: 'dimmed' },
]

interface Edge { from: string; to: string; type: 'lineage' | 'aggregated'; confidence?: number }

const EDGES: Edge[] = [
  { from: 'db1', to: 'tr1', type: 'lineage', confidence: 0.95 },
  { from: 'db2', to: 'tr1', type: 'lineage', confidence: 0.88 },
  { from: 'db2', to: 'tr2', type: 'lineage', confidence: 0.82 },
  { from: 'db3', to: 'tr2', type: 'lineage', confidence: 0.6 },
  { from: 'tr1', to: 'out1', type: 'lineage', confidence: 0.95 },
  { from: 'tr1', to: 'out2', type: 'lineage', confidence: 0.9 },
  { from: 'tr2', to: 'out2', type: 'aggregated', confidence: 0.75 },
  { from: 'tr2', to: 'out3', type: 'aggregated', confidence: 0.6 },
]

function getNode(id: string) { return NODES.find(n => n.id === id)! }

// ── Simplified Lucide-style SVG icon paths ─────────────────────────
const ICON_PATHS: Record<string, string> = {
  database: 'M2 6c0-1.1 3.6-2 8-2s8 .9 8 2v12c0 1.1-3.6 2-8 2s-8-.9-8-2V6Z M2 6c0 1.1 3.6 2 8 2s8-.9 8-2 M2 12c0 1.1 3.6 2 8 2s8-.9 8-2',
  workflow: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4h3 M14 14h-4v-4',
  server: 'M3 5h18v5H3zM3 14h18v5H3zM7 7.5h.01M7 16.5h.01',
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
  layout: 'M3 3h18v18H3zM3 9h18M9 3v18',
  package: 'M12 3l9 4.5v9L12 21l-9-4.5v-9L12 3Z M12 12l9-4.5 M12 12v9 M12 12L3 7.5',
}

// ── State ring/glow styles ─────────────────────────────────────────
function stateStyle(state: CanvasNode['state']) {
  switch (state) {
    case 'focus': return { ring: '#fbbf24', glow: 'rgba(251,191,36,0.35)', ringW: 3, opacity: 1 }
    case 'upstream': return { ring: '#60a5fa', glow: 'rgba(96,165,250,0.25)', ringW: 2, opacity: 1 }
    case 'downstream': return { ring: '#4ade80', glow: 'rgba(74,222,128,0.25)', ringW: 2, opacity: 1 }
    case 'dimmed': return { ring: 'none', glow: 'none', ringW: 0, opacity: 0.35 }
    default: return { ring: 'none', glow: 'none', ringW: 0, opacity: 1 }
  }
}

// ── Edge color by confidence ───────────────────────────────────────
function edgeColor(confidence: number) {
  if (confidence >= 0.8) return '#6366f1'
  if (confidence >= 0.5) return '#f59e0b'
  return '#ef4444'
}

function NodeCard({ node, delay }: { node: CanvasNode; delay: number }) {
  const s = stateStyle(node.state)
  const iconPath = ICON_PATHS[node.icon] ?? ICON_PATHS.package

  return (
    <motion.g
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: s.opacity, y: 0 }}
      transition={{ duration: 0.5, delay }}
      style={{ filter: node.state === 'dimmed' ? 'grayscale(0.5) blur(0.3px)' : undefined }}
    >
      {/* Glow ring */}
      {s.glow !== 'none' && (
        <rect
          x={node.x - 3} y={node.y - 3}
          width={node.w + 6} height={node.h + 6}
          rx={14} fill="none" stroke={s.ring} strokeWidth={s.ringW}
          opacity={0.6}
        >
          {node.state === 'focus' && (
            <animate attributeName="opacity" values="0.6;1;0.6" dur="2.5s" repeatCount="indefinite" />
          )}
        </rect>
      )}
      {/* Shadow under card */}
      <rect
        x={node.x + 1} y={node.y + 2}
        width={node.w} height={node.h}
        rx={11} fill="black" opacity={0.06}
      />
      {/* Card body */}
      <rect
        x={node.x} y={node.y}
        width={node.w} height={node.h}
        rx={11} fill="var(--nx-bg-elevated)"
        stroke={node.color} strokeWidth={1.5}
      />
      {/* Left accent border */}
      <rect
        x={node.x} y={node.y + 8}
        width={3} height={node.h - 16}
        rx={1.5} fill={node.color}
      />

      {/* Icon bg */}
      <rect
        x={node.x + 10} y={node.y + 10}
        width={18} height={18} rx={5}
        fill={node.color} opacity={0.12}
      />
      {/* Icon */}
      <g transform={`translate(${node.x + 13}, ${node.y + 13}) scale(0.5)`}>
        <path d={iconPath} fill="none" stroke={node.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Type badge */}
      <text
        x={node.x + 34} y={node.y + 18}
        fontSize="5" fontWeight="600" fill={node.color}
        fontFamily="Inter, system-ui" letterSpacing="0.8"
      >
        {node.typeLabel}
      </text>
      {/* Primary label */}
      <text
        x={node.x + 34} y={node.y + 29}
        fontSize="8.5" fontWeight="600" fill="var(--nx-text-primary)"
        fontFamily="Inter, system-ui"
      >
        {node.label}
      </text>
      {/* Secondary / URN */}
      {node.secondary && (
        <text
          x={node.x + 34} y={node.y + 39}
          fontSize="5.5" fill="var(--nx-text-muted)"
          fontFamily="JetBrains Mono, monospace"
        >
          {node.secondary}
        </text>
      )}

      {/* Children count badge */}
      {node.children && (
        <g>
          <rect
            x={node.x + node.w - 30} y={node.y + node.h - 14}
            width={24} height={10} rx={5}
            fill={node.color} opacity={0.1}
          />
          <text
            x={node.x + node.w - 18} y={node.y + node.h - 7}
            fontSize="5.5" fontWeight="600" fill={node.color}
            fontFamily="Inter, system-ui" textAnchor="middle"
          >
            +{node.children} cols
          </text>
        </g>
      )}

      {/* Connection handles */}
      <circle cx={node.x} cy={node.y + node.h / 2} r={3} fill="var(--nx-bg-elevated)" stroke={node.color} strokeWidth={1.5} />
      <circle cx={node.x + node.w} cy={node.y + node.h / 2} r={3} fill="var(--nx-bg-elevated)" stroke={node.color} strokeWidth={1.5} />
    </motion.g>
  )
}

export function LineageGraphDemo() {
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)

  return (
    <div className="relative w-full max-w-[580px] mx-auto" role="img" aria-label="Interactive lineage canvas preview showing data flowing from sources through transformations to outputs">
      <div className="glass-panel rounded-2xl overflow-hidden">
        {/* ── Toolbar mockup ─────────────────────────────────── */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--nx-border-subtle)]">
          <div className="flex items-center gap-2">
            {/* Window controls */}
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            </div>
            {/* View name */}
            <div className="flex items-center gap-1.5 ml-2">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--nx-accent-lineage)" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <span className="text-2xs font-semibold text-ink">Customer Pipeline</span>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-lineage/10 text-accent-lineage font-medium">Graph</span>
            </div>
          </div>

          {/* Right toolbar */}
          <div className="flex items-center gap-1">
            <div className="flex items-center gap-0.5 text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-canvas">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-business" />
              <span>Overview</span>
            </div>
            <div className="text-2xs text-ink-muted px-1.5 py-0.5 rounded bg-canvas">Table</div>
          </div>
        </div>

        {/* ── Canvas ─────────────────────────────────────────── */}
        <div className="relative">
          <svg viewBox="0 0 568 280" className="w-full h-auto">
            <title>Lineage graph showing data flowing from customer_db and events_stream through dim_customers to Customer 360 dashboard and churn_model</title>
            {/* Dot grid background */}
            <defs>
              <pattern id="canvas-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="10" cy="10" r="0.6" fill="var(--nx-text-muted)" opacity="0.15" />
              </pattern>
              {/* Gradient for traced edges */}
              <linearGradient id="edge-grad-upstream" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.3" />
                <stop offset="50%" stopColor="#60a5fa" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="edge-grad-downstream" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#4ade80" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#4ade80" stopOpacity="0.3" />
              </linearGradient>
            </defs>
            <rect width="568" height="280" fill="var(--nx-bg-canvas)" />
            <rect width="568" height="280" fill="url(#canvas-grid)" />

            {/* ── Edges (rendered below nodes) ────────────────── */}
            {EDGES.map((edge, i) => {
              const a = getNode(edge.from)
              const b = getNode(edge.to)
              const ax = a.x + a.w
              const ay = a.y + a.h / 2
              const bx = b.x
              const by = b.y + b.h / 2
              const cpx = (ax + bx) / 2
              const path = `M ${ax} ${ay} C ${cpx} ${ay}, ${cpx} ${by}, ${bx} ${by}`
              const color = edgeColor(edge.confidence ?? 0.8)
              const isDashed = edge.type === 'aggregated'
              const key = `${edge.from}-${edge.to}`
              const isHovered = hoveredEdge === key
              const isUpstream = a.state === 'upstream' && (b.state === 'focus' || b.state === 'upstream')
              const isDownstream = (a.state === 'focus' || a.state === 'downstream') && b.state === 'downstream'
              const isDimmed = a.state === 'dimmed' || b.state === 'dimmed'

              let gradientId: string | undefined
              if (isUpstream) gradientId = 'edge-grad-upstream'
              else if (isDownstream) gradientId = 'edge-grad-downstream'

              return (
                <g key={key} onMouseEnter={() => setHoveredEdge(key)} onMouseLeave={() => setHoveredEdge(null)}>
                  {/* Shadow path */}
                  <path d={path} stroke="var(--nx-text-muted)" strokeWidth="1.5" fill="none" opacity={isDimmed ? 0.08 : 0.15} />
                  {/* Main path */}
                  <motion.path
                    d={path}
                    stroke={gradientId ? `url(#${gradientId})` : color}
                    strokeWidth={isHovered ? 2.5 : isDimmed ? 1 : 1.8}
                    fill="none"
                    strokeDasharray={isDashed ? '6 4' : 'none'}
                    opacity={isDimmed ? 0.2 : 0.7}
                  />
                  {/* Animated flow particles */}
                  {!isDimmed && (
                    <motion.path
                      d={path}
                      stroke={color}
                      strokeWidth={1.5}
                      fill="none"
                      strokeDasharray="3 9"
                      opacity={0.5}
                      animate={{ strokeDashoffset: [12, 0] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'linear', delay: i * 0.2 }}
                    />
                  )}
                  {/* Hover label */}
                  {isHovered && (
                    <g>
                      <rect
                        x={(ax + bx) / 2 - 22} y={(ay + by) / 2 - 8}
                        width={44} height={14} rx={4}
                        fill="var(--nx-bg-glass)" stroke="var(--nx-border-glass)" strokeWidth={0.5}
                      />
                      <text
                        x={(ax + bx) / 2} y={(ay + by) / 2 + 1}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize="5.5" fontWeight="500" fill="var(--nx-text-secondary)"
                        fontFamily="Inter, system-ui"
                      >
                        {edge.type === 'aggregated' ? `AGG ×${Math.floor(Math.random() * 8 + 3)}` : `${Math.round((edge.confidence ?? 0.8) * 100)}% conf`}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

            {/* ── Nodes ───────────────────────────────────────── */}
            {NODES.map((node, i) => (
              <NodeCard key={node.id} node={node} delay={0.15 + i * 0.06} />
            ))}

            {/* ── Focus node toolbar (above dim_customers) ───── */}
            <motion.g
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.9 }}
            >
              <rect x={230} y={36} width={106} height={16} rx={5} fill="var(--nx-bg-glass)" stroke="var(--nx-border-glass)" strokeWidth={0.5} />
              {/* Trace up icon */}
              <g transform="translate(238, 39) scale(0.42)">
                <path d="M7 17l9.2-9.2M17 17V7H7" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </g>
              {/* Trace down icon */}
              <g transform="translate(252, 39) scale(0.42)">
                <path d="M17 7L7.8 16.2M7 7v10h10" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </g>
              {/* Separator */}
              <line x1="268" y1="39" x2="268" y2="49" stroke="var(--nx-border-subtle)" strokeWidth="0.5" />
              {/* Pin icon */}
              <g transform="translate(274, 40) scale(0.38)">
                <path d="M12 2v10l3 3v1H9v-1l3-3V2M9 22h6" fill="none" stroke="var(--nx-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </g>
              {/* More icon */}
              <g transform="translate(288, 40) scale(0.38)">
                <circle cx="5" cy="12" r="1" fill="var(--nx-text-muted)" />
                <circle cx="12" cy="12" r="1" fill="var(--nx-text-muted)" />
                <circle cx="19" cy="12" r="1" fill="var(--nx-text-muted)" />
              </g>
            </motion.g>
          </svg>

          {/* ── Minimap (bottom-right overlay) ─────────────── */}
          <div className="absolute bottom-2 right-2 w-20 h-14 rounded-lg glass-panel p-1 opacity-70">
            <svg viewBox="0 0 568 280" className="w-full h-full">
              {NODES.map(n => (
                <rect
                  key={n.id}
                  x={n.x} y={n.y} width={n.w} height={n.h}
                  rx={4} fill={n.color}
                  opacity={n.state === 'dimmed' ? 0.15 : 0.4}
                />
              ))}
              <rect x={150} y={20} width={260} height={200} rx={4} fill="none" stroke="var(--nx-accent-lineage)" strokeWidth={4} opacity={0.4} />
            </svg>
          </div>
        </div>

        {/* ── Bottom stats bar ───────────────────────────────── */}
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--nx-border-subtle)] text-2xs text-ink-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              Left → Right
            </span>
            <span className="text-ink-muted/40">|</span>
            <span>overview · table</span>
          </div>
          <div className="flex items-center gap-3">
            <span>8 entities · 8 relationships</span>
            <span className="text-ink-muted/40">|</span>
            <span className="flex items-center gap-1">
              <span className="text-[#60a5fa]">↑2</span> upstream · <span className="text-[#4ade80]">↓4</span> downstream
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-soft" />
              2 aggregated
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
