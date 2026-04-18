import { motion } from 'framer-motion'
import { Quote } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Card } from '@/components/ui/Card'

const TESTIMONIALS = [
  {
    quote: 'We went from "nobody knows where this KPI comes from" to full column-level traceability in a single sprint. The persona toggle is what sold our VP of Analytics.',
    author: 'Sarah Chen',
    role: 'Head of Data Engineering',
    company: 'Series B Fintech',
    color: '#6366f1',
  },
  {
    quote: 'We evaluated DataHub and Collibra. Neither could do interactive graph exploration at our scale — 3M edges. Nexus Lineage handles it without breaking a sweat.',
    author: 'Marcus Rivera',
    role: 'Staff Data Engineer',
    company: 'E-commerce Platform',
    color: '#10b981',
  },
  {
    quote: 'The workspace isolation model is exactly right. Each team owns their ontology and views without stepping on each other. Multi-tenancy done properly.',
    author: 'Priya Sharma',
    role: 'Platform Architect',
    company: 'Healthcare Analytics',
    color: '#8b5cf6',
  },
]

export function Testimonials() {
  return (
    <Section id="testimonials">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          What data teams{' '}
          <span className="gradient-text">are saying</span>
        </h2>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {TESTIMONIALS.map(({ quote, author, role, company, color }, i) => (
          <motion.div
            key={author}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.12 }}
          >
            <Card className="h-full flex flex-col" accentColor={color}>
              <Quote size={20} className="text-ink-muted/30 mb-3" />
              <p className="text-sm text-ink-secondary leading-relaxed flex-1 mb-6">
                "{quote}"
              </p>
              <div className="flex items-center gap-3 pt-4 border-t border-[var(--nx-border-subtle)]">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white font-display font-bold text-sm"
                  style={{ backgroundColor: color }}
                >
                  {author[0]}
                </div>
                <div>
                  <div className="text-sm font-semibold text-ink">{author}</div>
                  <div className="text-2xs text-ink-muted">{role}, {company}</div>
                </div>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </Section>
  )
}
