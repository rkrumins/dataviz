import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Globe, Table2, Columns3 } from 'lucide-react'

const LEVELS = [
  {
    id: 'domain',
    label: 'Domain',
    icon: Globe,
    items: [
      { name: 'Customer Platform', meta: '24 tables', badge: 'Certified' },
      { name: 'Analytics Engine', meta: '18 tables', badge: null },
      { name: 'Data Warehouse', meta: '42 tables', badge: 'Certified' },
    ],
    color: '#10b981',
    description: 'High-level business domains',
  },
  {
    id: 'table',
    label: 'Table',
    icon: Table2,
    items: [
      { name: 'dim_customers', meta: '12 columns', badge: null },
      { name: 'fct_orders', meta: '8 columns', badge: null },
      { name: 'dim_products', meta: '15 columns', badge: null },
      { name: 'stg_events', meta: '6 columns', badge: 'dbt' },
      { name: 'fct_revenue', meta: '9 columns', badge: null },
    ],
    color: '#8b5cf6',
    description: 'Individual tables and models',
  },
  {
    id: 'column',
    label: 'Column',
    icon: Columns3,
    items: [
      { name: 'user_id', meta: 'INT PRIMARY KEY', badge: 'PK' },
      { name: 'email', meta: 'VARCHAR(255)', badge: 'PII' },
      { name: 'created_at', meta: 'TIMESTAMP', badge: null },
      { name: 'lifetime_value', meta: 'DECIMAL(10,2)', badge: null },
      { name: 'churn_score', meta: 'FLOAT', badge: 'ML' },
      { name: 'segment', meta: 'VARCHAR(50)', badge: null },
      { name: 'last_login', meta: 'TIMESTAMP', badge: null },
    ],
    color: '#6366f1',
    description: 'Individual column definitions',
  },
]

const badgeColors: Record<string, string> = {
  Certified: '#10b981',
  dbt: '#ff694a',
  PK: '#6366f1',
  PII: '#ef4444',
  ML: '#f59e0b',
}

export function GranularityZoom() {
  const [active, setActive] = useState(0)
  const level = LEVELS[active]
  const Icon = level.icon

  return (
    <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto" role="group" aria-label="Granularity zoom level demo">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${level.color}15` }}>
          <Icon size={14} style={{ color: level.color }} />
        </div>
        <div>
          <div className="text-xs font-semibold text-ink">{level.label} View</div>
          <div className="text-2xs text-ink-muted">{level.description}</div>
        </div>
      </div>

      {/* Zoom level selector */}
      <div className="flex gap-1 mb-4 bg-canvas rounded-lg p-1">
        {LEVELS.map((l, i) => {
          const LIcon = l.icon
          return (
            <button
              key={l.id}
              onClick={() => setActive(i)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-md transition-all ${
                i === active
                  ? 'bg-canvas-elevated text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink'
              }`}
              aria-pressed={i === active}
            >
              <LIcon size={12} />
              {l.label}
            </button>
          )
        })}
      </div>

      {/* Items */}
      <AnimatePresence mode="wait">
        <motion.div
          key={level.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className="space-y-1.5"
        >
          {level.items.map((item, i) => (
            <motion.div
              key={item.name}
              className="flex items-center gap-3 px-3 py-2 rounded-xl bg-canvas group hover:bg-canvas-elevated transition-colors"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
            >
              {/* Color accent */}
              <div className="w-1.5 h-6 rounded-full" style={{ backgroundColor: level.color, opacity: 0.5 }} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono font-medium text-ink truncate">{item.name}</div>
                <div className="text-2xs text-ink-muted">{item.meta}</div>
              </div>
              {item.badge && (
                <span
                  className="text-2xs font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: `${badgeColors[item.badge] ?? level.color}12`,
                    color: badgeColors[item.badge] ?? level.color,
                  }}
                >
                  {item.badge}
                </span>
              )}
            </motion.div>
          ))}
        </motion.div>
      </AnimatePresence>

      {/* Zoom indicator */}
      <div className="flex items-center justify-center gap-2 mt-4">
        {LEVELS.map((_, i) => (
          <div
            key={i}
            className="h-1 rounded-full transition-all duration-300"
            style={{
              width: i === active ? 20 : 8,
              backgroundColor: i === active ? level.color : 'var(--nx-text-muted)',
              opacity: i === active ? 1 : 0.2,
            }}
          />
        ))}
      </div>
    </div>
  )
}
