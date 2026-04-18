import { Compass, RefreshCcw, Lock } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Section } from '@/components/layout/Section'

/*
 * Three high-level value propositions — the "why" before the "how."
 * Each maps to a user pain point, not a product feature.
 * Features are covered in FeatureShowcase; this section sells the outcome.
 */

const PROPS = [
  {
    icon: Compass,
    title: 'Clarity across your data stack',
    description:
      'See how data flows from source to dashboard in one interactive view. No more chasing dependencies across wikis, Slack threads, and stale documentation.',
    color: '#6366f1',
  },
  {
    icon: RefreshCcw,
    title: 'Adapt without rebuilding',
    description:
      'Change graph backends, evolve your ontology, or restructure teams — your views and lineage survive. The architecture is designed to absorb change, not fight it.',
    color: '#10b981',
  },
  {
    icon: Lock,
    title: 'Govern without gatekeeping',
    description:
      'Each team gets isolated workspaces with their own views and ontologies. Platform-wide lineage stays consistent, but nobody steps on each other\'s context.',
    color: '#8b5cf6',
  },
]

export function ValueProps() {
  return (
    <Section id="features">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Why teams choose{' '}
          <span className="gradient-text">Nexus Lineage</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          Built for the complexity that other tools pretend doesn't exist.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {PROPS.map(({ icon: Icon, title, description, color }) => (
          <Card key={title} accentColor={color}>
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
              style={{ backgroundColor: `${color}15` }}
            >
              <Icon size={20} style={{ color }} />
            </div>
            <h3 className="text-lg font-display font-semibold mb-2">{title}</h3>
            <p className="text-sm text-ink-secondary leading-relaxed">{description}</p>
          </Card>
        ))}
      </div>
    </Section>
  )
}
