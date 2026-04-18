import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { Section } from '@/components/layout/Section'

const ITEMS = [
  {
    q: 'What graph databases does Nexus Lineage support?',
    a: 'Out of the box: FalkorDB (Redis-protocol, optimized for speed), Neo4j (enterprise graph), and DataHub (metadata catalog ingestion). The pluggable GraphDataProvider interface means you can add custom backends without forking the core.',
  },
  {
    q: 'How does it differ from DataHub or Apache Atlas?',
    a: 'DataHub and Atlas are metadata catalogs — they store metadata and show static lineage diagrams. Nexus Lineage is a lineage-first visualization platform with an interactive canvas (pan, zoom, trace), multi-granularity zoom (column → table → domain), and pre-computed aggregated edges for instant traversal at any scale.',
  },
  {
    q: 'Can it handle millions of edges?',
    a: 'Yes. The aggregation engine materializes summary (AGGREGATED) edges in batch using cursor-based iteration — O(n), not O(n²). Workers checkpoint progress to Postgres every 2 seconds, so jobs survive crashes and resume without repeating work. Horizontal scaling is built in: add more workers with --scale.',
  },
  {
    q: 'Is it really open source?',
    a: 'Fully. Apache 2.0 license. You can self-host, modify, and distribute without restriction. No "open core" bait-and-switch — every feature on this page is in the open repository.',
  },
  {
    q: 'What does the persona toggle do?',
    a: 'It switches between Business and Technical views of the same graph. Business users see domain names, KPIs, data owners, and plain-language descriptions. Engineers see schema URNs, SQL transformations, and pipeline dependencies. Same data, different lens.',
  },
  {
    q: 'How long does setup take?',
    a: 'About 5 minutes with Docker Compose. One command starts the full platform: PostgreSQL, FalkorDB, Redis, backend services, and frontend. A demo data seeder is included so you can explore immediately.',
  },
  {
    q: 'What about authentication and multi-tenancy?',
    a: 'JWT-based authentication with Argon2id password hashing, CSRF protection, and session cookies. Workspace isolation is architectural — each team gets its own data sources, ontologies, and views. No data leaks between tenants.',
  },
  {
    q: 'Do I need to migrate my data?',
    a: 'No. Nexus Lineage connects to your existing graph database. It reads your data in place and writes only AGGREGATED summary edges. Your source data is never modified.',
  },
  {
    q: 'Can I connect it to my existing metadata catalog (OpenMetadata, Collibra, etc.)?',
    a: 'The connector architecture is designed to be extensible. Today you can connect to FalkorDB, Neo4j, and DataHub out of the box. Connectors for catalogs like OpenMetadata, Collibra, Alation, and Atlan are on the roadmap. In the meantime, you can build your own by implementing the GraphDataProvider interface — it\'s a clean Python protocol, typically under 200 lines of code for a read-only connector.',
  },
  {
    q: 'How many views can I create from one data source?',
    a: 'Unlimited. Views are projections — they define which entities, relationships, and layout to show, but they don\'t copy data. You can create hundreds of contextual views scoped to different teams, domains, or use cases, all reading from the same underlying graph. Adding a view has zero impact on the source data or on other views.',
  },
  {
    q: 'What is the AI assistant and when will it be available?',
    a: 'The embedded AI assistant (coming soon) will let you interact with your lineage views using natural language. Ask questions like "What feeds into this dashboard?" or "What breaks if I change this column?" and the AI translates your question into a Cypher query against the underlying graph, interprets the results, and responds in context. It sees the same view you\'re looking at, so it understands your current scope and filters.',
  },
]

function AccordionItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-[var(--nx-border-subtle)] last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 py-5 text-left group"
        aria-expanded={open}
      >
        <span className="text-base font-medium text-ink group-hover:text-accent-lineage transition-colors">
          {q}
        </span>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 text-ink-muted"
        >
          <ChevronDown size={18} />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm text-ink-secondary leading-relaxed max-w-3xl">
              {a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function FAQ() {
  return (
    <Section id="faq" alt>
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
            Frequently asked questions
          </h2>
          <p className="text-lg text-ink-secondary">
            Everything you need to know about Nexus Lineage.
          </p>
        </div>
        <div className="glass-panel rounded-2xl px-6 md:px-8">
          {ITEMS.map(({ q, a }) => (
            <AccordionItem key={q} q={q} a={a} />
          ))}
        </div>
      </div>
    </Section>
  )
}
