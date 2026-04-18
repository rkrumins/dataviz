import { motion } from 'framer-motion'

/*
 * Improved architecture diagram that matches the actual Synodic service topology.
 * Uses realistic service names, ports, and data flow arrows.
 */

interface Service {
  x: number; y: number; w: number; h: number
  label: string; sublabel: string; color: string; port?: string
}

const SERVICES: Service[] = [
  { x: 190, y: 12, w: 160, h: 42, label: 'React 19 Frontend', sublabel: 'Vite · Tailwind · React Flow', color: '#6366f1', port: '5173' },
  { x: 190, y: 90, w: 160, h: 42, label: 'viz-service', sublabel: 'FastAPI · Auth · Graph Queries', color: '#6366f1', port: '8000' },
  { x: 20, y: 178, w: 148, h: 42, label: 'Control Plane', sublabel: 'Job lifecycle · Scheduling', color: '#8b5cf6', port: '8091' },
  { x: 370, y: 178, w: 132, h: 42, label: 'Worker(s)', sublabel: 'Batch MERGE · Checkpoints', color: '#f59e0b', port: '8090' },
  { x: 20, y: 268, w: 120, h: 42, label: 'PostgreSQL', sublabel: 'Users · Jobs · Ontologies', color: '#336791', port: '5432' },
  { x: 200, y: 268, w: 120, h: 42, label: 'Redis', sublabel: 'Streams · Pub/Sub', color: '#DC382D', port: '6380' },
  { x: 370, y: 268, w: 132, h: 42, label: 'FalkorDB', sublabel: 'Graph · AGGREGATED edges', color: '#10b981', port: '6379' },
]

interface Connection {
  from: [number, number]; to: [number, number]; label?: string; dashed?: boolean
}

const CONNECTIONS: Connection[] = [
  { from: [270, 54], to: [270, 90], label: 'HTTP' },
  { from: [190, 111], to: [94, 178], label: 'Proxy' },
  { from: [94, 220], to: [80, 268], label: 'SQL' },
  { from: [94, 220], to: [260, 268], dashed: true },
  { from: [260, 288], to: [436, 220], label: 'XREADGROUP' },
  { from: [436, 220], to: [436, 268], label: 'Cypher' },
  { from: [350, 111], to: [436, 178], dashed: true },
]

function ServiceBox({ s, delay }: { s: Service; delay: number }) {
  return (
    <motion.g
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.4 }}
    >
      {/* Shadow */}
      <rect x={s.x + 1} y={s.y + 2} width={s.w} height={s.h} rx={10} fill="black" opacity={0.04} />
      {/* Body */}
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={10} fill="var(--nx-bg-elevated)" stroke={s.color} strokeWidth={1.5} />
      {/* Left accent */}
      <rect x={s.x} y={s.y + 8} width={3} height={s.h - 16} rx={1.5} fill={s.color} />
      {/* Label */}
      <text x={s.x + 14} y={s.y + 18} fontSize="8" fontWeight="700" fill="var(--nx-text-primary)" fontFamily="Inter, system-ui">
        {s.label}
      </text>
      {/* Sublabel */}
      <text x={s.x + 14} y={s.y + 30} fontSize="5.5" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui">
        {s.sublabel}
      </text>
      {/* Port badge */}
      {s.port && (
        <g>
          <rect x={s.x + s.w - 28} y={s.y + 4} width={24} height={10} rx={5} fill={s.color} opacity={0.1} />
          <text x={s.x + s.w - 16} y={s.y + 11} fontSize="5" fontWeight="600" fill={s.color} fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            :{s.port}
          </text>
        </g>
      )}
    </motion.g>
  )
}

export function ArchitectureDiagram() {
  return (
    <div className="glass-panel rounded-2xl p-5 overflow-x-auto" role="img" aria-label="System architecture diagram showing viz-service, control plane, workers, and databases">
      <svg viewBox="0 0 520 322" className="w-full max-w-2xl mx-auto h-auto">
        <title>Decoupled architecture: Frontend connects to viz-service, which proxies to Control Plane, dispatching jobs to Workers via Redis Streams</title>
        {/* Dot grid */}
        <defs>
          <pattern id="arch-dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="8" cy="8" r="0.5" fill="var(--nx-text-muted)" opacity="0.12" />
          </pattern>
        </defs>
        <rect width="520" height="322" fill="var(--nx-bg-canvas)" rx="8" />
        <rect width="520" height="322" fill="url(#arch-dots)" rx="8" />

        {/* Layer labels */}
        <text x="8" y="34" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 34)">PRESENTATION</text>
        <text x="8" y="112" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 112)">API</text>
        <text x="8" y="202" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 202)">COMPUTE</text>
        <text x="8" y="290" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 290)">DATA</text>

        {/* Connections */}
        {CONNECTIONS.map((c, i) => (
          <g key={i}>
            <line x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]} stroke="var(--nx-text-muted)" strokeWidth="1" opacity="0.15" />
            <motion.line
              x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]}
              stroke="var(--nx-accent-lineage)" strokeWidth={c.dashed ? 1 : 1.5}
              strokeDasharray={c.dashed ? '4 3' : '3 6'} opacity={0.45}
              animate={{ strokeDashoffset: [9, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear', delay: i * 0.25 }}
            />
            {c.label && (
              <text
                x={(c.from[0] + c.to[0]) / 2 + 5} y={(c.from[1] + c.to[1]) / 2 - 2}
                fontSize="5.5" fill="var(--nx-text-muted)" fontFamily="JetBrains Mono, monospace"
              >
                {c.label}
              </text>
            )}
          </g>
        ))}

        {/* Services */}
        {SERVICES.map((s, i) => (
          <ServiceBox key={s.label} s={s} delay={i * 0.06} />
        ))}
      </svg>
    </div>
  )
}
