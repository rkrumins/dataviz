import { motion } from 'framer-motion'
import { Database, ArrowRightLeft, Globe, Layers, ShieldCheck, Unplug, Plug, Eye } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const PROVIDERS = [
  { name: 'FalkorDB', desc: 'Redis-protocol graph engine', color: '#6366f1', port: '6379' },
  { name: 'Neo4j', desc: 'Enterprise graph database', color: '#008CC1', port: '7687' },
  { name: 'DataHub', desc: 'Metadata catalog ingestion', color: '#10b981', port: 'REST' },
  { name: 'Custom', desc: 'Your own GraphDataProvider', color: '#f59e0b', port: '...' },
]

const CATALOGS = [
  { name: 'OpenMetadata', color: '#7147e8' },
  { name: 'Collibra', color: '#0055a4' },
  { name: 'Alation', color: '#00b4d8' },
  { name: 'Atlan', color: '#5046e4' },
  { name: 'Amundsen', color: '#3b82f6' },
  { name: 'Any Catalog', color: '#64748b' },
]

const BENEFITS = [
  {
    icon: Unplug,
    title: 'No migration required',
    description: 'Point at your existing graph database and start visualizing. Nexus Lineage reads your data in place — it never copies, moves, or modifies your source.',
    color: '#6366f1',
  },
  {
    icon: ArrowRightLeft,
    title: 'Swap backends without code changes',
    description: 'Start with FalkorDB for speed, move to Neo4j for compliance, or ingest from DataHub. The GraphDataProvider interface abstracts the connection — your views, ontologies, and workspaces stay intact.',
    color: '#10b981',
  },
  {
    icon: Plug,
    title: 'Connect to any existing catalog',
    description: 'Build a connector to OpenMetadata, Collibra, Alation, or any catalog where your metadata already lives. Nexus Lineage becomes the visualization layer on top — no need to re-ingest or duplicate data into yet another store.',
    color: '#7147e8',
  },
  {
    icon: Eye,
    title: 'Hundreds of contextual views, zero data changes',
    description: 'Create hundreds or thousands of views — each scoped to a team, domain, or use case — all reading from the same underlying graph. Views are projections, not copies. The source data stays exactly where it is, untouched.',
    color: '#06b6d4',
  },
  {
    icon: Layers,
    title: 'One semantic layer across all sources',
    description: 'Define your ontology once. Whether your lineage lives in FalkorDB, Neo4j, or a catalog connector, the same entity types, relationship classifications, and visual properties apply everywhere.',
    color: '#8b5cf6',
  },
  {
    icon: Globe,
    title: 'Multi-provider workspaces',
    description: 'A single workspace can bind multiple data sources from different providers. Compare lineage across your Snowflake pipeline graph in Neo4j and your Kafka topology in FalkorDB — side by side.',
    color: '#10b981',
  },
  {
    icon: ShieldCheck,
    title: 'Credentials encrypted at rest',
    description: 'Provider connection strings are Fernet-encrypted in PostgreSQL. Decrypted only at the moment of connection — never stored in memory longer than needed.',
    color: '#f59e0b',
  },
  {
    icon: Database,
    title: 'Build your own adapter',
    description: 'The GraphDataProvider protocol is a clean Python interface. Implement it to connect any property graph, RDF store, metadata catalog, or custom API — zero framework lock-in.',
    color: '#ef4444',
  },
]

export function UniversalLineage() {
  return (
    <Section id="universal-lineage">
      <div className="grid lg:grid-cols-2 gap-16 items-start">
        {/* Left — narrative + provider cards */}
        <div>
          <motion.div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel text-xs font-medium text-accent-lineage mb-6"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Globe size={12} />
            Backend-Agnostic Architecture
          </motion.div>

          <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
            Your data lives everywhere.{' '}
            <span className="gradient-text">So does your lineage.</span>
          </h2>

          <p className="text-base text-ink-secondary leading-relaxed mb-6">
            Most lineage tools lock you into one graph database, one metadata format, one vendor's
            ecosystem. Nexus Lineage flips that model. It connects to <em>your</em> graph — wherever
            it is, however it's stored — and materializes interactive lineage on top.
          </p>

          <p className="text-base text-ink-secondary leading-relaxed mb-4">
            The <span className="font-mono text-xs bg-canvas-elevated px-1.5 py-0.5 rounded text-ink">GraphDataProvider</span> interface
            decouples visualization from storage. Switch providers without rewriting a single query.
            No ETL pipelines. No data duplication. No lock-in.
          </p>

          <p className="text-base text-ink-secondary leading-relaxed mb-8">
            Already using a metadata catalog? Build a connector and Nexus Lineage becomes the
            interactive visualization layer on top of the data you already have. Create hundreds
            of contextual views — each scoped to a team, domain, or use case — without
            touching the underlying data.
          </p>

          {/* Provider cards */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            {PROVIDERS.map((p, i) => (
              <motion.div
                key={p.name}
                className="glass-panel rounded-xl p-3 flex items-center gap-3"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-display font-bold text-sm flex-shrink-0"
                  style={{ backgroundColor: p.color }}
                >
                  {p.name[0]}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">{p.name}</div>
                  <div className="text-2xs text-ink-muted truncate">{p.desc}</div>
                </div>
                <span className="ml-auto text-2xs font-mono text-ink-muted/50">{p.port}</span>
              </motion.div>
            ))}
          </div>

          {/* Catalog connector teaser */}
          <motion.div
            className="glass-panel rounded-2xl p-5"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Plug size={14} className="text-accent-lineage" />
              <span className="text-xs font-semibold text-ink">Extensible to any catalog</span>
              <Badge variant="coming-soon">Connectors Coming Soon</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {CATALOGS.map((c, i) => (
                <motion.div
                  key={c.name}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-canvas text-xs font-medium"
                  initial={{ opacity: 0, scale: 0.9 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.3 + i * 0.06 }}
                >
                  <div className="w-4 h-4 rounded flex items-center justify-center text-white text-2xs font-bold" style={{ backgroundColor: c.color }}>
                    {c.name[0]}
                  </div>
                  <span className="text-ink-secondary">{c.name}</span>
                </motion.div>
              ))}
            </div>
            <p className="text-2xs text-ink-muted mt-3 leading-relaxed">
              Build a connector to any catalog where your metadata lives. Nexus Lineage reads it, visualizes it, and lets you create unlimited views — without moving a single byte of data.
            </p>
          </motion.div>
        </div>

        {/* Right — benefit cards */}
        <div className="space-y-3">
          {BENEFITS.map(({ icon: Icon, title, description, color }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.06 }}
            >
              <Card hover={false} className="flex gap-4 items-start">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ backgroundColor: `${color}12` }}
                >
                  <Icon size={18} style={{ color }} />
                </div>
                <div>
                  <h3 className="text-sm font-display font-semibold mb-1">{title}</h3>
                  <p className="text-xs text-ink-secondary leading-relaxed">{description}</p>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </Section>
  )
}
