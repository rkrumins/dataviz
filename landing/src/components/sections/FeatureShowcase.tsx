import { motion } from 'framer-motion'
import { PanelTop, Layers, ToggleRight, Globe, Eye, Plug } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { GranularityZoom } from '@/components/visuals/GranularityZoom'
import { PersonaToggleDemo } from '@/components/visuals/PersonaToggleDemo'
import { CanvasPreview } from '@/components/visuals/CanvasPreview'
import { Badge } from '@/components/ui/Badge'

/*
 * Unified feature showcase — merges the old FeatureShowcase + UniversalLineage
 * into one section with 6 features in alternating text/visual layout.
 * Each feature tells a unique part of the story without repeating.
 */

const CATALOGS = [
  { name: 'OpenMetadata', color: '#7147e8' },
  { name: 'Collibra', color: '#0055a4' },
  { name: 'Alation', color: '#00b4d8' },
  { name: 'Atlan', color: '#5046e4' },
  { name: 'Amundsen', color: '#3b82f6' },
  { name: 'Any Catalog', color: '#64748b' },
]

const FEATURES = [
  {
    icon: PanelTop,
    title: 'A canvas, not a diagram',
    description:
      'Drag, pan, zoom, multi-select, trace upstream and downstream. Keyboard shortcuts, breadcrumb navigation, and a command palette. Lineage exploration that feels like a design tool.',
    color: '#6366f1',
    visual: <CanvasPreview />,
  },
  {
    icon: Layers,
    title: 'Zoom from sky to street',
    description:
      'Domain-level overviews aggregate thousands of tables into navigable clusters. Click through to table relationships, then drill into column-level lineage. Pre-computed edges keep every zoom level instant.',
    color: '#8b5cf6',
    visual: <GranularityZoom />,
  },
  {
    icon: ToggleRight,
    title: 'One graph, two realities',
    description:
      'Business analysts see KPIs, data owners, and impact analysis. Engineers see schemas, SQL transforms, and pipeline dependencies. A toggle switches the lens — the underlying data stays the same.',
    color: '#10b981',
    visual: <PersonaToggleDemo />,
  },
  {
    icon: Globe,
    title: 'Any graph. Any backend.',
    description:
      'Connect FalkorDB for speed, Neo4j for enterprise compliance, or ingest from DataHub. The GraphDataProvider interface abstracts the connection so your views, ontologies, and workspaces are never tied to one vendor.',
    color: '#06b6d4',
    visual: (
      <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto">
        <div className="flex items-center justify-center gap-5 mb-4">
          {[
            { name: 'FalkorDB', color: '#6366f1' },
            { name: 'Neo4j', color: '#008CC1' },
            { name: 'DataHub', color: '#10b981' },
            { name: 'Custom', color: '#f59e0b' },
          ].map((db, i) => (
            <motion.div
              key={db.name}
              className="flex flex-col items-center gap-1.5"
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-display font-bold text-sm"
                style={{ backgroundColor: db.color }}
              >
                {db.name[0]}
              </div>
              <span className="text-2xs text-ink-muted">{db.name}</span>
            </motion.div>
          ))}
        </div>
        <div className="flex items-center justify-center">
          <svg width="200" height="36" viewBox="0 0 200 36">
            {[25, 75, 125, 175].map((x, i) => (
              <motion.line
                key={i} x1={x} y1="0" x2={100} y2="30"
                stroke={['#6366f1', '#008CC1', '#10b981', '#f59e0b'][i]}
                strokeWidth="1.5" strokeDasharray="4 4" opacity="0.4"
                animate={{ strokeDashoffset: [8, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'linear', delay: i * 0.15 }}
              />
            ))}
            <circle cx="100" cy="30" r="4" fill="var(--nx-accent-lineage)" />
          </svg>
        </div>
        <p className="text-center text-2xs text-ink-muted mt-1 font-medium">
          One interface · swap backends anytime
        </p>
      </div>
    ),
  },
  {
    icon: Eye,
    title: 'Thousands of views, zero copies',
    description:
      'Create hundreds of contextual views — each scoped to a team, domain, or use case — all reading from the same underlying graph. Views are projections, not duplicates. The source data stays exactly where it is.',
    color: '#f59e0b',
    visual: (
      <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto">
        <div className="text-xs font-semibold text-ink mb-3">Views from one data source</div>
        {[
          { name: 'Exec Overview', scope: 'Leadership', type: 'Domain', color: '#10b981' },
          { name: 'Pipeline Debug', scope: 'Data Engineering', type: 'Column', color: '#6366f1' },
          { name: 'Compliance Audit', scope: 'Legal', type: 'Table', color: '#ef4444' },
          { name: 'ML Feature Map', scope: 'Data Science', type: 'Column', color: '#f59e0b' },
        ].map((v, i) => (
          <motion.div
            key={v.name}
            className="flex items-center gap-3 px-3 py-2 rounded-xl bg-canvas mb-1.5"
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.06 }}
          >
            <div className="w-1.5 h-5 rounded-full" style={{ backgroundColor: v.color, opacity: 0.6 }} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-ink">{v.name}</div>
              <div className="text-2xs text-ink-muted">{v.scope}</div>
            </div>
            <span className="text-2xs font-mono text-ink-muted/60">{v.type}</span>
          </motion.div>
        ))}
        <div className="text-center text-2xs text-ink-muted mt-2">
          Same graph · different lens per team
        </div>
      </div>
    ),
  },
  {
    icon: Plug,
    title: 'Extensible to any catalog',
    description:
      'Build a connector to OpenMetadata, Collibra, Atlan, or any catalog where your metadata already lives. Nexus Lineage becomes the visualization layer — no data duplication required.',
    color: '#7147e8',
    comingSoon: true,
    visual: (
      <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto">
        <div className="flex items-center gap-2 mb-3">
          <Plug size={14} className="text-accent-lineage" />
          <span className="text-xs font-semibold text-ink">Catalog Connectors</span>
          <Badge variant="coming-soon">Roadmap</Badge>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {CATALOGS.map((c, i) => (
            <motion.div
              key={c.name}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-canvas text-xs font-medium"
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
            >
              <div className="w-4 h-4 rounded flex items-center justify-center text-white text-2xs font-bold" style={{ backgroundColor: c.color }}>
                {c.name[0]}
              </div>
              <span className="text-ink-secondary">{c.name}</span>
            </motion.div>
          ))}
        </div>
        <p className="text-2xs text-ink-muted leading-relaxed">
          Implement the GraphDataProvider interface (~200 lines) to read from any metadata source.
        </p>
      </div>
    ),
  },
]

export function FeatureShowcase() {
  return (
    <Section id="showcase" alt>
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          Built different,{' '}
          <span className="gradient-text">on purpose</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          Six capabilities that separate Nexus Lineage from static lineage diagrams and metadata catalogs.
        </p>
      </div>

      <div className="space-y-20 lg:space-y-28">
        {FEATURES.map((feat, i) => {
          const Icon = feat.icon
          const reversed = i % 2 === 1
          return (
            <div
              key={feat.title}
              className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center"
            >
              <div className={reversed ? 'lg:order-2' : ''}>
                <div className="flex items-center gap-2 mb-4">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: `${feat.color}12` }}
                  >
                    <Icon size={20} style={{ color: feat.color }} />
                  </div>
                  {feat.comingSoon && <Badge variant="coming-soon">Coming Soon</Badge>}
                </div>
                <h3 className="text-2xl md:text-3xl font-display font-bold tracking-tight mb-4">
                  {feat.title}
                </h3>
                <p className="text-base text-ink-secondary leading-relaxed">
                  {feat.description}
                </p>
              </div>
              <div className={reversed ? 'lg:order-1' : ''}>
                {feat.visual}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
