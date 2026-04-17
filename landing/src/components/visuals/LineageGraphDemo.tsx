import { motion } from 'framer-motion'

const NODES = [
  { id: 'src1', x: 60, y: 50, label: 'Users DB', color: '#6366f1', r: 22 },
  { id: 'src2', x: 60, y: 140, label: 'Events', color: '#6366f1', r: 22 },
  { id: 'src3', x: 60, y: 230, label: 'Payments', color: '#6366f1', r: 22 },
  { id: 'mid1', x: 240, y: 95, label: 'User Profile', color: '#8b5cf6', r: 20 },
  { id: 'mid2', x: 240, y: 185, label: 'Transactions', color: '#8b5cf6', r: 20 },
  { id: 'out1', x: 420, y: 95, label: 'Dashboard', color: '#10b981', r: 22 },
  { id: 'out2', x: 420, y: 185, label: 'ML Model', color: '#10b981', r: 22 },
  { id: 'out3', x: 420, y: 275, label: 'Reports', color: '#10b981', r: 20 },
]

const EDGES = [
  { from: 'src1', to: 'mid1' },
  { from: 'src2', to: 'mid1' },
  { from: 'src2', to: 'mid2' },
  { from: 'src3', to: 'mid2' },
  { from: 'mid1', to: 'out1' },
  { from: 'mid1', to: 'out2' },
  { from: 'mid2', to: 'out2' },
  { from: 'mid2', to: 'out3' },
]

function getNode(id: string) {
  return NODES.find(n => n.id === id)!
}

export function LineageGraphDemo() {
  return (
    <div className="relative w-full max-w-lg mx-auto">
      <div className="glass-panel rounded-2xl p-4 overflow-hidden">
        {/* Toolbar mockup */}
        <div className="flex items-center gap-2 mb-3 px-2">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
          </div>
          <div className="flex-1 flex justify-center">
            <div className="px-3 py-1 rounded-md bg-canvas text-2xs text-ink-muted font-mono">
              lineage-canvas
            </div>
          </div>
        </div>

        <svg viewBox="0 0 480 320" className="w-full h-auto">
          {/* Grid background */}
          <defs>
            <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="12" r="0.8" fill="var(--nx-text-muted)" opacity="0.2" />
            </pattern>
          </defs>
          <rect width="480" height="320" fill="url(#grid)" rx="8" />

          {/* Edges */}
          {EDGES.map(({ from, to }, i) => {
            const a = getNode(from)
            const b = getNode(to)
            const midX = (a.x + b.x) / 2
            return (
              <g key={`${from}-${to}`}>
                <path
                  d={`M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`}
                  stroke="var(--nx-text-muted)"
                  strokeWidth="1.5"
                  fill="none"
                  opacity="0.3"
                />
                <motion.path
                  d={`M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}`}
                  stroke="var(--nx-accent-lineage)"
                  strokeWidth="2"
                  fill="none"
                  strokeDasharray="6 6"
                  opacity="0.6"
                  animate={{ strokeDashoffset: [12, 0] }}
                  transition={{
                    duration: 1.5,
                    repeat: Infinity,
                    ease: 'linear',
                    delay: i * 0.15,
                  }}
                />
              </g>
            )
          })}

          {/* Nodes */}
          {NODES.map((node, i) => (
            <motion.g
              key={node.id}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.08 }}
            >
              {/* Glow */}
              <circle cx={node.x} cy={node.y} r={node.r + 6} fill={node.color} opacity="0.08">
                <animate
                  attributeName="opacity"
                  values="0.08;0.18;0.08"
                  dur="3s"
                  begin={`${i * 0.4}s`}
                  repeatCount="indefinite"
                />
              </circle>
              {/* Node circle */}
              <circle
                cx={node.x}
                cy={node.y}
                r={node.r}
                fill="var(--nx-bg-elevated)"
                stroke={node.color}
                strokeWidth="2"
              />
              {/* Label */}
              <text
                x={node.x}
                y={node.y + 1}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--nx-text-primary)"
                fontSize="8"
                fontFamily="Inter, system-ui, sans-serif"
                fontWeight="500"
              >
                {node.label}
              </text>
            </motion.g>
          ))}
        </svg>
      </div>
    </div>
  )
}
