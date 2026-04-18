import { motion } from 'framer-motion'
import { ArrowRight, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { LineageGraphDemo } from '@/components/visuals/LineageGraphDemo'

export function Hero() {
  return (
    <section id="hero" className="relative min-h-screen flex items-center overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 hero-grid-bg opacity-60" />
      <div className="absolute top-0 left-0 w-[300px] h-[300px] md:w-[600px] md:h-[600px] bg-accent-lineage/8 rounded-full blur-[80px] md:blur-[120px] -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 right-0 w-[250px] h-[250px] md:w-[500px] md:h-[500px] bg-accent-business/6 rounded-full blur-[60px] md:blur-[100px] translate-x-1/3 translate-y-1/3" />

      <div className="relative max-w-7xl mx-auto px-6 lg:px-8 pt-24 pb-16 w-full">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Text */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <motion.div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel text-xs font-medium text-accent-lineage mb-6"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent-business animate-pulse" />
              Open Source Data Lineage Platform
            </motion.div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold tracking-tight leading-[1.1] mb-6">
              See where your data{' '}
              <span className="gradient-text">actually comes from</span>
            </h1>

            <p className="text-lg md:text-xl text-ink-secondary leading-relaxed mb-8 max-w-xl">
              Interactive lineage visualization that scales from a single column to your
              entire data platform. Explore, trace, and understand — not just view.
            </p>

            <div className="flex flex-wrap gap-4">
              <Button href="#contact" icon={<ArrowRight size={16} />}>
                Request a Demo
              </Button>
              <Button variant="secondary" href="#faq" icon={<BookOpen size={16} />}>
                Learn More
              </Button>
            </div>

            {/* Quick stats */}
            <motion.div
              className="flex gap-8 mt-10 pt-8 border-t border-[var(--nx-border-subtle)]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
            >
              {[
                { value: '< 100ms', label: 'Query latency' },
                { value: '5M+', label: 'Edges supported' },
                { value: '3', label: 'Graph backends' },
              ].map(({ value, label }) => (
                <div key={label}>
                  <div className="text-xl font-display font-bold text-ink">{value}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{label}</div>
                </div>
              ))}
            </motion.div>
          </motion.div>

          {/* Visual */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.3 }}
            className="hidden lg:block"
          >
            <LineageGraphDemo />
          </motion.div>
        </div>
      </div>
    </section>
  )
}
