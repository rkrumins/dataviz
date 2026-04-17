import { motion } from 'framer-motion'

const SERVICES = [
  { x: 200, y: 30, w: 120, h: 36, label: 'React 19 Frontend', color: '#6366f1' },
  { x: 200, y: 110, w: 120, h: 36, label: 'viz-service', color: '#6366f1' },
  { x: 60, y: 200, w: 110, h: 36, label: 'Control Plane', color: '#8b5cf6' },
  { x: 340, y: 200, w: 100, h: 36, label: 'Worker(s)', color: '#f59e0b' },
  { x: 60, y: 290, w: 100, h: 36, label: 'PostgreSQL', color: '#10b981' },
  { x: 200, y: 290, w: 100, h: 36, label: 'Redis', color: '#ef4444' },
  { x: 340, y: 290, w: 100, h: 36, label: 'FalkorDB', color: '#10b981' },
]

const CONNECTIONS = [
  { from: [260, 66], to: [260, 110], label: 'HTTP' },
  { from: [200, 128], to: [115, 200], label: 'Proxy' },
  { from: [115, 236], to: [115, 290], label: 'SQL' },
  { from: [115, 236], to: [250, 290], label: '' },
  { from: [250, 306], to: [390, 236], label: 'Streams' },
  { from: [390, 236], to: [390, 290], label: 'Cypher' },
  { from: [320, 128], to: [390, 200], label: '' },
]

export function ArchitectureDiagram() {
  return (
    <div className="glass-panel rounded-2xl p-6 overflow-x-auto">
      <svg viewBox="0 0 500 340" className="w-full max-w-lg mx-auto h-auto">
        <defs>
          <pattern id="arch-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="10" cy="10" r="0.5" fill="var(--nx-text-muted)" opacity="0.15" />
          </pattern>
        </defs>
        <rect width="500" height="340" fill="url(#arch-grid)" rx="8" />

        {/* Connections */}
        {CONNECTIONS.map((c, i) => (
          <g key={i}>
            <line
              x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]}
              stroke="var(--nx-text-muted)" strokeWidth="1" opacity="0.3"
            />
            <motion.line
              x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]}
              stroke="var(--nx-accent-lineage)" strokeWidth="1.5"
              strokeDasharray="4 4" opacity="0.5"
              animate={{ strokeDashoffset: [8, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear', delay: i * 0.2 }}
            />
            {c.label && (
              <text
                x={(c.from[0] + c.to[0]) / 2 + 6}
                y={(c.from[1] + c.to[1]) / 2}
                fontSize="7" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui"
              >
                {c.label}
              </text>
            )}
          </g>
        ))}

        {/* Service boxes */}
        {SERVICES.map((s, i) => (
          <motion.g
            key={s.label}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.08 }}
          >
            <rect
              x={s.x} y={s.y} width={s.w} height={s.h}
              rx="8" fill="var(--nx-bg-elevated)"
              stroke={s.color} strokeWidth="1.5"
            />
            <text
              x={s.x + s.w / 2} y={s.y + s.h / 2 + 1}
              textAnchor="middle" dominantBaseline="central"
              fontSize="8" fontWeight="600" fill="var(--nx-text-primary)"
              fontFamily="Inter, system-ui"
            >
              {s.label}
            </text>
          </motion.g>
        ))}
      </svg>
    </div>
  )
}
