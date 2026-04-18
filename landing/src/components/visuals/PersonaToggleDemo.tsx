import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Briefcase, Code } from 'lucide-react'

const BUSINESS_VIEW = [
  { label: 'Customer 360', type: 'KPI', tag: 'Certified', tagColor: '#10b981', meta: 'Owner: Analytics Team' },
  { label: 'Revenue Pipeline', type: 'Dataset', tag: 'High Impact', tagColor: '#f59e0b', meta: 'Owner: Finance Dept' },
  { label: 'Churn Risk Score', type: 'Metric', tag: 'Active', tagColor: '#10b981', meta: 'Updated: 2h ago' },
]

const TECHNICAL_VIEW = [
  { label: 'analytics.dim_customers', type: 'Table', tag: 'dbt v2.3', tagColor: '#6366f1', meta: '12 cols · 2.4M rows' },
  { label: 'ml.churn_prediction', type: 'Model', tag: 'Airflow DAG', tagColor: '#8b5cf6', meta: 'Last run: 14:32 UTC' },
  { label: 'raw.stripe_events', type: 'Source', tag: 'Kafka', tagColor: '#06b6d4', meta: 'Lag: 340ms' },
]

export function PersonaToggleDemo() {
  const [isBusiness, setIsBusiness] = useState(true)
  const items = isBusiness ? BUSINESS_VIEW : TECHNICAL_VIEW

  return (
    <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto" role="group" aria-label="Persona toggle demo">
      {/* Toggle header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs font-semibold text-ink">Viewing as</div>
        <div className="flex items-center gap-0.5 bg-canvas rounded-lg p-0.5">
          <button
            onClick={() => setIsBusiness(true)}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-all ${
              isBusiness
                ? 'bg-canvas-elevated text-accent-business shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
            aria-pressed={isBusiness}
          >
            <Briefcase size={12} />
            Business
          </button>
          <button
            onClick={() => setIsBusiness(false)}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-all ${
              !isBusiness
                ? 'bg-canvas-elevated text-accent-lineage shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
            aria-pressed={!isBusiness}
          >
            <Code size={12} />
            Technical
          </button>
        </div>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={isBusiness ? 'biz' : 'tech'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className="space-y-2"
        >
          {items.map((item, i) => (
            <motion.div
              key={item.label}
              className="rounded-xl bg-canvas p-3 hover:bg-canvas-elevated transition-colors"
              initial={{ opacity: 0, x: isBusiness ? -10 : 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.06 }}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-medium text-ink truncate">{item.label}</span>
                <span
                  className="text-2xs font-semibold px-1.5 py-0.5 rounded whitespace-nowrap"
                  style={{
                    backgroundColor: `${item.tagColor}12`,
                    color: item.tagColor,
                  }}
                >
                  {item.tag}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xs text-ink-muted uppercase tracking-wide font-medium">{item.type}</span>
                <span className="text-2xs text-ink-muted/50">·</span>
                <span className="text-2xs text-ink-muted">{item.meta}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </AnimatePresence>

      {/* Indicator */}
      <div className="flex items-center justify-center gap-2 mt-4 text-2xs text-ink-muted">
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: isBusiness ? '#10b981' : '#6366f1' }} />
        Same data, different lens
      </div>
    </div>
  )
}
