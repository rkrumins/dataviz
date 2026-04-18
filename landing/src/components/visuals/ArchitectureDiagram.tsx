import { motion } from 'framer-motion'

/*
 * Customer-facing architecture diagram.
 * Uses generic, product-oriented labels (not internal service names).
 * Includes the REST API layer for external connectivity.
 */

interface Service {
  x: number; y: number; w: number; h: number
  label: string; sublabel: string; color: string
}

const SERVICES: Service[] = [
  // Presentation
  { x: 180, y: 12, w: 170, h: 42, label: 'Interactive UI', sublabel: 'Canvas · Views · Dashboards', color: '#6366f1' },
  // API
  { x: 30, y: 90, w: 150, h: 42, label: 'REST API', sublabel: 'Programmatic access · Webhooks', color: '#06b6d4' },
  { x: 210, y: 90, w: 150, h: 42, label: 'Unified Backend', sublabel: 'Auth · Queries · Ontology · Views', color: '#6366f1' },
  // Compute
  { x: 30, y: 178, w: 148, h: 42, label: 'Job Orchestrator', sublabel: 'Scheduling · Lifecycle · Recovery', color: '#8b5cf6' },
  { x: 360, y: 178, w: 142, h: 42, label: 'Aggregation Workers', sublabel: 'Batch processing · Checkpoints', color: '#f59e0b' },
  // Data
  { x: 30, y: 268, w: 120, h: 42, label: 'Management DB', sublabel: 'Users · Jobs · Ontologies', color: '#336791' },
  { x: 195, y: 268, w: 120, h: 42, label: 'Message Broker', sublabel: 'Job dispatch · Events', color: '#DC382D' },
  { x: 360, y: 268, w: 142, h: 42, label: 'Graph Database', sublabel: 'Nodes · Edges · Lineage', color: '#10b981' },
]

interface Connection {
  from: [number, number]; to: [number, number]; label?: string; dashed?: boolean
}

const CONNECTIONS: Connection[] = [
  // UI → Unified Backend
  { from: [265, 54], to: [285, 90] },
  // REST API → Unified Backend
  { from: [180, 111], to: [210, 111], label: 'API' },
  // Unified Backend → Job Orchestrator
  { from: [210, 111], to: [104, 178], label: 'Proxy' },
  // Job Orchestrator → Management DB
  { from: [104, 220], to: [90, 268] },
  // Job Orchestrator → Message Broker
  { from: [104, 220], to: [255, 268], dashed: true },
  // Message Broker → Workers
  { from: [255, 288], to: [431, 220], label: 'Job stream' },
  // Workers → Graph Database
  { from: [431, 220], to: [431, 268] },
  // Unified Backend → Graph Database (queries)
  { from: [360, 111], to: [431, 178], dashed: true },
  // External systems → REST API
  { from: [10, 111], to: [30, 111] },
]

function ServiceBox({ s, delay }: { s: Service; delay: number }) {
  return (
    <motion.g
      initial={{ opacity: 0, y: 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.4 }}
    >
      <rect x={s.x + 1} y={s.y + 2} width={s.w} height={s.h} rx={10} fill="black" opacity={0.04} />
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={10} fill="var(--nx-bg-elevated)" stroke={s.color} strokeWidth={1.5} />
      <rect x={s.x} y={s.y + 8} width={3} height={s.h - 16} rx={1.5} fill={s.color} />
      <text x={s.x + 14} y={s.y + 18} fontSize="8" fontWeight="700" fill="var(--nx-text-primary)" fontFamily="Inter, system-ui">
        {s.label}
      </text>
      <text x={s.x + 14} y={s.y + 30} fontSize="5.5" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui">
        {s.sublabel}
      </text>
    </motion.g>
  )
}

export function ArchitectureDiagram() {
  return (
    <div className="glass-panel rounded-2xl p-5 overflow-x-auto" role="img" aria-label="System architecture diagram showing the Interactive UI, Unified Backend, REST API, Aggregation Workers, and data stores">
      <svg viewBox="0 0 520 322" className="w-full max-w-2xl mx-auto h-auto">
        <title>Decoupled architecture: Interactive UI and REST API connect to the Unified Backend, which orchestrates aggregation workers and queries graph databases</title>
        <defs>
          <pattern id="arch-dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="8" cy="8" r="0.5" fill="var(--nx-text-muted)" opacity="0.12" />
          </pattern>
        </defs>
        <rect width="520" height="322" fill="var(--nx-bg-canvas)" rx="8" />
        <rect width="520" height="322" fill="url(#arch-dots)" rx="8" />

        {/* Layer labels */}
        <text x="8" y="34" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 34)">INTERFACE</text>
        <text x="8" y="112" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 112)">SERVICES</text>
        <text x="8" y="202" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 202)">COMPUTE</text>
        <text x="8" y="290" fontSize="6" fontWeight="600" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" opacity="0.5" transform="rotate(-90, 8, 290)">DATA</text>

        {/* External system indicator (left of REST API) */}
        <motion.g
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5 }}
        >
          <rect x={-60} y={94} width={66} height={30} rx={6} fill="none" stroke="var(--nx-text-muted)" strokeWidth={1} strokeDasharray="3 3" opacity={0.3} />
          <text x={-27} y={108} fontSize="5.5" fontWeight="500" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" textAnchor="middle" opacity={0.5}>Your systems</text>
          <text x={-27} y={117} fontSize="4.5" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" textAnchor="middle" opacity={0.35}>CI/CD · Scripts · Apps</text>
        </motion.g>

        {/* Connections */}
        {CONNECTIONS.map((c, i) => (
          <g key={i}>
            <line x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]} stroke="var(--nx-text-muted)" strokeWidth="1" opacity="0.15" />
            <motion.line
              x1={c.from[0]} y1={c.from[1]} x2={c.to[0]} y2={c.to[1]}
              stroke="var(--nx-accent-lineage)" strokeWidth={c.dashed ? 1 : 1.5}
              strokeDasharray={c.dashed ? '4 3' : '3 6'} opacity={0.45}
              animate={{ strokeDashoffset: [9, 0] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear', delay: i * 0.2 }}
            />
            {c.label && (
              <text
                x={(c.from[0] + c.to[0]) / 2 + 5} y={(c.from[1] + c.to[1]) / 2 - 3}
                fontSize="5" fill="var(--nx-text-muted)" fontFamily="Inter, system-ui" fontWeight="500"
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
