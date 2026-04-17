import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const BUSINESS_VIEW = [
  { label: 'Customer 360', tag: 'Certified KPI', tagColor: '#10b981' },
  { label: 'Revenue Pipeline', tag: 'Data Owner: Finance', tagColor: '#10b981' },
  { label: 'Churn Risk Score', tag: 'Impact: High', tagColor: '#f59e0b' },
]

const TECHNICAL_VIEW = [
  { label: 'public.dim_customers', tag: 'dbt model v2.3', tagColor: '#6366f1' },
  { label: 'analytics.fct_revenue', tag: 'SQL transform', tagColor: '#6366f1' },
  { label: 'ml.churn_prediction', tag: 'Airflow DAG', tagColor: '#8b5cf6' },
]

export function PersonaToggleDemo() {
  const [isBusiness, setIsBusiness] = useState(true)
  const items = isBusiness ? BUSINESS_VIEW : TECHNICAL_VIEW

  return (
    <div className="glass-panel rounded-2xl p-6 max-w-sm mx-auto">
      {/* Toggle */}
      <div className="flex items-center justify-center gap-3 mb-5">
        <button
          onClick={() => setIsBusiness(true)}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
            isBusiness
              ? 'bg-accent-business/15 text-accent-business'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          Business
        </button>
        <div
          className="w-10 h-5 rounded-full bg-canvas relative cursor-pointer"
          onClick={() => setIsBusiness(!isBusiness)}
        >
          <motion.div
            className="w-4 h-4 rounded-full absolute top-0.5"
            style={{ backgroundColor: isBusiness ? '#10b981' : '#6366f1' }}
            animate={{ left: isBusiness ? 2 : 22 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          />
        </div>
        <button
          onClick={() => setIsBusiness(false)}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
            !isBusiness
              ? 'bg-accent-lineage/15 text-accent-lineage'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          Technical
        </button>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={isBusiness ? 'biz' : 'tech'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className="space-y-2.5"
        >
          {items.map((item, i) => (
            <motion.div
              key={item.label}
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-canvas"
              initial={{ opacity: 0, x: isBusiness ? -10 : 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.06 }}
            >
              <span className="text-sm font-medium text-ink truncate">{item.label}</span>
              <span
                className="text-2xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
                style={{
                  backgroundColor: `${item.tagColor}15`,
                  color: item.tagColor,
                }}
              >
                {item.tag}
              </span>
            </motion.div>
          ))}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
