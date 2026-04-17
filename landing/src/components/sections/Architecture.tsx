import { Zap, Shield, Building2 } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Card } from '@/components/ui/Card'
import { ArchitectureDiagram } from '@/components/visuals/ArchitectureDiagram'

const STATS = [
  {
    icon: Zap,
    title: 'Pre-computed edges',
    description: 'Query any zoom level in under 100ms. Aggregation materializes summary edges so the UI never waits on live graph traversal.',
    color: '#f59e0b',
  },
  {
    icon: Shield,
    title: 'Crash-recoverable',
    description: 'Workers checkpoint progress every 2 seconds. If one dies mid-job, another resumes from exactly where it left off.',
    color: '#10b981',
  },
  {
    icon: Building2,
    title: 'Multi-tenant from day one',
    description: 'Workspace isolation is architectural, not bolted on. Each team gets its own context, ontology, and data source bindings.',
    color: '#6366f1',
  },
]

export function Architecture() {
  return (
    <Section id="architecture">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Engineered for{' '}
          <span className="gradient-text">real-world scale</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          A decoupled, service-oriented architecture where every component scales independently.
        </p>
      </div>

      <div className="mb-16">
        <ArchitectureDiagram />
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {STATS.map(({ icon: Icon, title, description, color }) => (
          <Card key={title} accentColor={color}>
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
              style={{ backgroundColor: `${color}15` }}
            >
              <Icon size={20} style={{ color }} />
            </div>
            <h3 className="text-base font-display font-semibold mb-2">{title}</h3>
            <p className="text-sm text-ink-secondary leading-relaxed">{description}</p>
          </Card>
        ))}
      </div>
    </Section>
  )
}
