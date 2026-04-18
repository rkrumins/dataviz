import { Zap, Shield, Building2, Plug2 } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Card } from '@/components/ui/Card'
import { ArchitectureDiagram } from '@/components/visuals/ArchitectureDiagram'

const STATS = [
  {
    icon: Zap,
    title: 'Pre-computed lineage',
    description: 'Aggregation materializes summary edges in advance so every zoom level responds in under 100ms — no live graph traversal at query time.',
    color: '#f59e0b',
  },
  {
    icon: Shield,
    title: 'Crash-recoverable workers',
    description: 'Processing checkpoints every 2 seconds. If a worker fails mid-job, another picks up exactly where it left off. No work is repeated.',
    color: '#10b981',
  },
  {
    icon: Plug2,
    title: 'Full REST API',
    description: 'Every capability exposed through the UI is also available via API — trigger aggregation, query lineage, manage workspaces, and integrate with CI/CD pipelines programmatically.',
    color: '#06b6d4',
  },
  {
    icon: Building2,
    title: 'Multi-tenant from day one',
    description: 'Workspace isolation is architectural, not bolted on. Each team gets its own context, ontology, and data source bindings without affecting others.',
    color: '#6366f1',
  },
]

export function Architecture() {
  return (
    <Section id="architecture" alt>
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Engineered for{' '}
          <span className="gradient-text">real-world scale</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          A decoupled architecture where every layer scales independently — and every
          capability is accessible through the UI or the API.
        </p>
      </div>

      <div className="mb-16">
        <ArchitectureDiagram />
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
        {STATS.map(({ icon: Icon, title, description, color }) => (
          <Card key={title} accentColor={color}>
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
              style={{ backgroundColor: `${color}15` }}
            >
              <Icon size={20} style={{ color }} />
            </div>
            <h3 className="text-sm font-display font-semibold mb-2">{title}</h3>
            <p className="text-xs text-ink-secondary leading-relaxed">{description}</p>
          </Card>
        ))}
      </div>
    </Section>
  )
}
