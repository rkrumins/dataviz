import { MousePointerClick, ZoomIn, Users } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Section } from '@/components/layout/Section'

const PROPS = [
  {
    icon: MousePointerClick,
    title: 'Interactive, Not Static',
    description:
      'Explore lineage like a design tool. Pan, zoom, trace upstream, drill into column-level detail. Your graph responds to every click.',
    color: '#6366f1',
  },
  {
    icon: ZoomIn,
    title: 'Any Zoom Level',
    description:
      'Jump from a 10,000-foot domain view to individual column transformations. Pre-computed aggregation means zero wait, even at millions of edges.',
    color: '#8b5cf6',
  },
  {
    icon: Users,
    title: 'Speak Their Language',
    description:
      'Business users see domains and KPIs. Engineers see schemas and transformations. Same graph, same truth, different perspectives.',
    color: '#10b981',
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
