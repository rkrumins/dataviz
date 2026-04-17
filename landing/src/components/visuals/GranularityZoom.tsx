import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const LEVELS = [
  {
    id: 'domain',
    label: 'Domain',
    items: ['Customer Platform', 'Analytics Engine', 'Data Warehouse'],
    color: '#10b981',
  },
  {
    id: 'table',
    label: 'Table',
    items: ['users', 'events', 'orders', 'sessions', 'products'],
    color: '#8b5cf6',
  },
  {
    id: 'column',
    label: 'Column',
    items: ['user_id', 'email', 'created_at', 'event_type', 'amount', 'status', 'product_id'],
    color: '#6366f1',
  },
]

export function GranularityZoom() {
  const [active, setActive] = useState(0)
  const level = LEVELS[active]

  return (
    <div className="glass-panel rounded-2xl p-6 max-w-sm mx-auto">
      {/* Zoom level selector */}
      <div className="flex gap-1 mb-5 bg-canvas rounded-lg p-1">
        {LEVELS.map((l, i) => (
          <button
            key={l.id}
            onClick={() => setActive(i)}
            className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${
              i === active
                ? 'bg-canvas-elevated text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* Items */}
      <AnimatePresence mode="wait">
        <motion.div
          key={level.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className="space-y-2"
        >
          {level.items.map((item, i) => (
            <motion.div
              key={item}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-canvas"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: level.color }}
              />
              <span className="text-sm font-mono text-ink">{item}</span>
            </motion.div>
          ))}
        </motion.div>
      </AnimatePresence>

      <p className="text-2xs text-ink-muted mt-4 text-center">
        Click to zoom between granularity levels
      </p>
    </div>
  )
}
