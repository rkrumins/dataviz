import { Section } from '@/components/layout/Section'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const INTEGRATIONS = [
  { name: 'FalkorDB', category: 'Graph Database', status: 'active', initial: 'F', color: '#6366f1' },
  { name: 'Neo4j', category: 'Graph Database', status: 'active', initial: 'N', color: '#008CC1' },
  { name: 'DataHub', category: 'Metadata Catalog', status: 'active', initial: 'D', color: '#10b981' },
  { name: 'PostgreSQL', category: 'Management DB', status: 'active', initial: 'P', color: '#336791' },
  { name: 'Redis', category: 'Message Broker', status: 'active', initial: 'R', color: '#DC382D' },
  { name: 'Apache Airflow', category: 'Orchestrator', status: 'coming-soon', initial: 'A', color: '#017CEE' },
  { name: 'dbt', category: 'Transformation', status: 'coming-soon', initial: 'd', color: '#FF694A' },
  { name: 'Snowflake', category: 'Data Warehouse', status: 'coming-soon', initial: 'S', color: '#29B5E8' },
]

export function Integrations() {
  return (
    <Section id="integrations">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Connects to what you{' '}
          <span className="gradient-text">already use</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          Plug into your existing data infrastructure. No rip-and-replace required.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {INTEGRATIONS.map(({ name, category, status, initial, color }) => (
          <Card key={name} hover className="text-center relative">
            {status === 'coming-soon' && (
              <div className="absolute top-3 right-3">
                <Badge variant="coming-soon">Soon</Badge>
              </div>
            )}
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3 text-white font-display font-bold"
              style={{ backgroundColor: color, opacity: status === 'coming-soon' ? 0.5 : 1 }}
            >
              {initial}
            </div>
            <h4 className={`text-sm font-semibold mb-1 ${status === 'coming-soon' ? 'text-ink-muted' : 'text-ink'}`}>
              {name}
            </h4>
            <p className="text-2xs text-ink-muted">{category}</p>
          </Card>
        ))}
      </div>
    </Section>
  )
}
