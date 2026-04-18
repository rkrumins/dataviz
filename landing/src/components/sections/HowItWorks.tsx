import { motion } from 'framer-motion'
import { Download, Link, Eye, GitBranch, Share2 } from 'lucide-react'
import { Section } from '@/components/layout/Section'

const STEPS = [
  {
    icon: Download,
    step: '01',
    title: 'Deploy in minutes',
    description: 'Docker Compose up. One command spins up the full platform — backend, graph database, message broker, and frontend.',
    accent: '#6366f1',
  },
  {
    icon: Link,
    step: '02',
    title: 'Connect your graph',
    description: 'Point at FalkorDB, Neo4j, or DataHub. The connectivity wizard tests credentials and discovers your schema automatically.',
    accent: '#3b82f6',
  },
  {
    icon: Eye,
    step: '03',
    title: 'Define your ontology',
    description: 'Classify edges as containment (structural) or lineage (functional). The system auto-fills gaps with sensible defaults.',
    accent: '#8b5cf6',
  },
  {
    icon: GitBranch,
    step: '04',
    title: 'Run aggregation',
    description: 'One click materializes summary edges across every zoom level. Workers batch-process in the background — crash-recoverable, checkpoint-based.',
    accent: '#10b981',
  },
  {
    icon: Share2,
    step: '05',
    title: 'Explore & share',
    description: 'Create views, trace lineage, toggle personas, and share interactive canvases with your team. No more static diagrams.',
    accent: '#f59e0b',
  },
]

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          From zero to lineage in{' '}
          <span className="gradient-text">five steps</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          No complex setup. No data migration. Connect your existing graph and start exploring.
        </p>
      </div>

      <div className="relative max-w-3xl mx-auto">
        {/* Vertical timeline line */}
        <div className="absolute left-6 md:left-8 top-0 bottom-0 w-px bg-[var(--nx-border-subtle)]" />

        <div className="space-y-10">
          {STEPS.map(({ icon: Icon, step, title, description, accent }, i) => (
            <motion.div
              key={step}
              className="relative flex gap-6 md:gap-8"
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
            >
              {/* Step number circle */}
              <div
                className="relative z-10 flex-shrink-0 w-12 h-12 md:w-16 md:h-16 rounded-2xl flex items-center justify-center"
                style={{ backgroundColor: `${accent}12` }}
              >
                <Icon size={22} style={{ color: accent }} />
              </div>

              {/* Content */}
              <div className="pt-1">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-2xs font-bold uppercase tracking-widest" style={{ color: accent }}>
                    Step {step}
                  </span>
                </div>
                <h3 className="text-lg font-display font-semibold mb-1.5">{title}</h3>
                <p className="text-sm text-ink-secondary leading-relaxed max-w-lg">{description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </Section>
  )
}
