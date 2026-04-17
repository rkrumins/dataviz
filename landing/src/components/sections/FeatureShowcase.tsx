import { motion } from 'framer-motion'
import { Layers, PanelTop, ToggleRight, Database } from 'lucide-react'
import { Section } from '@/components/layout/Section'
import { GranularityZoom } from '@/components/visuals/GranularityZoom'
import { PersonaToggleDemo } from '@/components/visuals/PersonaToggleDemo'

const FEATURES = [
  {
    icon: PanelTop,
    title: 'Figma for your data lineage',
    description:
      'Drag, pan, zoom, multi-select. Full-canvas exploration with real-time search, breadcrumb navigation, and keyboard shortcuts. Not another static diagram generator.',
    visual: (
      <div className="glass-panel rounded-2xl p-5 max-w-sm mx-auto">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full bg-red-400/60" />
            <div className="w-2 h-2 rounded-full bg-yellow-400/60" />
            <div className="w-2 h-2 rounded-full bg-green-400/60" />
          </div>
          <div className="flex-1 text-center text-2xs text-ink-muted font-mono">canvas</div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {['Users', 'Events', 'Profiles', 'Sessions', 'Orders', 'Reports'].map((n, i) => (
            <motion.div
              key={n}
              className="bg-canvas rounded-lg px-2 py-3 text-center text-xs font-medium text-ink-secondary border border-[var(--nx-border-subtle)]"
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06 }}
            >
              {n}
            </motion.div>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: Layers,
    title: 'Zoom from sky view to street view',
    description:
      'Domain-level overviews aggregate thousands of tables into navigable clusters. Click through to table relationships, then into individual column-level lineage. All pre-computed, all instant.',
    visual: <GranularityZoom />,
  },
  {
    icon: ToggleRight,
    title: 'One graph. Two realities.',
    description:
      'Business analysts see certified KPIs, data owners, and impact analysis in plain language. Engineers see SQL transformations, schema diffs, and pipeline dependencies. Toggle freely.',
    visual: <PersonaToggleDemo />,
  },
  {
    icon: Database,
    title: 'Your graph database. Your rules.',
    description:
      'Connect FalkorDB for speed, Neo4j for maturity, or ingest from DataHub. Switch providers without rewriting queries. No lock-in, ever.',
    visual: (
      <div className="glass-panel rounded-2xl p-6 max-w-sm mx-auto">
        <div className="flex items-center justify-center gap-6">
          {[
            { name: 'FalkorDB', color: '#6366f1' },
            { name: 'Neo4j', color: '#008CC1' },
            { name: 'DataHub', color: '#10b981' },
          ].map((db, i) => (
            <motion.div
              key={db.name}
              className="flex flex-col items-center gap-2"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-display font-bold text-sm"
                style={{ backgroundColor: db.color }}
              >
                {db.name[0]}
              </div>
              <span className="text-2xs text-ink-muted font-medium">{db.name}</span>
            </motion.div>
          ))}
        </div>
        <div className="flex items-center justify-center mt-5">
          <svg width="240" height="40" viewBox="0 0 240 40">
            {[40, 120, 200].map((x, i) => (
              <motion.line
                key={i}
                x1={x}
                y1="0"
                x2="120"
                y2="35"
                stroke="var(--nx-accent-lineage)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                opacity="0.4"
                animate={{ strokeDashoffset: [8, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'linear', delay: i * 0.2 }}
              />
            ))}
            <circle cx="120" cy="35" r="4" fill="var(--nx-accent-lineage)" />
          </svg>
        </div>
        <p className="text-center text-xs text-ink-muted mt-2 font-medium">
          One unified interface
        </p>
      </div>
    ),
  },
]

export function FeatureShowcase() {
  return (
    <Section id="showcase" alt>
      <div className="space-y-24">
        {FEATURES.map((feat, i) => {
          const Icon = feat.icon
          const reversed = i % 2 === 1
          return (
            <div
              key={feat.title}
              className={`grid lg:grid-cols-2 gap-12 lg:gap-16 items-center ${
                reversed ? 'lg:direction-rtl' : ''
              }`}
            >
              <div className={reversed ? 'lg:order-2' : ''}>
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                  style={{ backgroundColor: 'var(--nx-accent-lineage-soft)' }}
                >
                  <Icon size={20} className="text-accent-lineage" />
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
