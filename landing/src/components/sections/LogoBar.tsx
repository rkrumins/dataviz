import { motion } from 'framer-motion'

const CATEGORIES = [
  'Enterprise Finance',
  'Global Retail',
  'Healthcare Analytics',
  'SaaS Platform',
  'Insurance Group',
  'Telecom',
]

export function LogoBar() {
  return (
    <section className="py-16 border-y border-[var(--nx-border-subtle)]">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-muted text-center mb-8">
          Trusted by data teams at
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-8 items-center">
          {CATEGORIES.map((name, i) => (
            <motion.div
              key={name}
              className="flex items-center justify-center h-12 px-4 rounded-lg text-sm font-medium text-ink-muted/50 hover:text-ink-muted transition-colors select-none"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
            >
              {name}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
