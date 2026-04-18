import { Check, X, Minus } from 'lucide-react'
import { Section } from '@/components/layout/Section'

type Status = 'yes' | 'no' | 'partial'

interface Row {
  feature: string
  nexus: Status
  openmetadata: Status
  datahub: Status
  atlas: Status
  marquez: Status
}

const ROWS: Row[] = [
  { feature: 'Interactive canvas (pan, zoom, trace, drag)', nexus: 'yes', openmetadata: 'no', datahub: 'no', atlas: 'no', marquez: 'no' },
  { feature: 'Multi-granularity zoom (domain → table → column)', nexus: 'yes', openmetadata: 'partial', datahub: 'partial', atlas: 'no', marquez: 'no' },
  { feature: 'Business & technical persona toggle', nexus: 'yes', openmetadata: 'no', datahub: 'no', atlas: 'no', marquez: 'no' },
  { feature: 'Pluggable graph backends (bring your own DB)', nexus: 'yes', openmetadata: 'no', datahub: 'no', atlas: 'no', marquez: 'no' },
  { feature: 'Lineage without data ingestion / ETL', nexus: 'yes', openmetadata: 'no', datahub: 'no', atlas: 'no', marquez: 'no' },
  { feature: 'Versioned ontology with evolution policies', nexus: 'yes', openmetadata: 'partial', datahub: 'no', atlas: 'partial', marquez: 'no' },
  { feature: 'Pre-computed aggregated edges', nexus: 'yes', openmetadata: 'no', datahub: 'no', atlas: 'no', marquez: 'no' },
  { feature: 'Workspace isolation (multi-tenant)', nexus: 'yes', openmetadata: 'partial', datahub: 'partial', atlas: 'no', marquez: 'no' },
  { feature: 'Crash-recoverable batch workers', nexus: 'yes', openmetadata: 'no', datahub: 'partial', atlas: 'no', marquez: 'no' },
  { feature: 'Column-level lineage', nexus: 'yes', openmetadata: 'yes', datahub: 'yes', atlas: 'partial', marquez: 'yes' },
  { feature: 'Data quality & profiling', nexus: 'no', openmetadata: 'yes', datahub: 'partial', atlas: 'no', marquez: 'no' },
  { feature: 'Built-in metadata ingestion (connectors)', nexus: 'no', openmetadata: 'yes', datahub: 'yes', atlas: 'partial', marquez: 'partial' },
  { feature: 'Open source (no open-core paywall)', nexus: 'yes', openmetadata: 'yes', datahub: 'partial', atlas: 'yes', marquez: 'yes' },
]

const COMPETITORS = [
  { key: 'nexus' as const, label: 'Nexus', highlight: true, icon: true },
  { key: 'openmetadata' as const, label: 'OpenMetadata', highlight: false },
  { key: 'datahub' as const, label: 'DataHub', highlight: false },
  { key: 'atlas' as const, label: 'Atlas', highlight: false },
  { key: 'marquez' as const, label: 'Marquez', highlight: false },
]

function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case 'yes': return <Check size={16} className="text-accent-business" />
    case 'no': return <X size={16} className="text-ink-muted/40" />
    case 'partial': return <Minus size={16} className="text-accent-technical" />
  }
}

export function Comparison() {
  return (
    <Section id="comparison">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-4xl font-display font-bold tracking-tight mb-4">
          How Nexus Lineage{' '}
          <span className="gradient-text">compares</span>
        </h2>
        <p className="text-lg text-ink-secondary max-w-2xl mx-auto">
          Purpose-built for interactive lineage visualization — not a metadata catalog with lineage bolted on.
        </p>
      </div>

      {/* Scroll hint for mobile */}
      <div className="flex items-center justify-center gap-1.5 mb-4 md:hidden text-2xs text-ink-muted">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4h6v6M10 20H4v-6M20 4L4 20" />
        </svg>
        Swipe to compare all tools
      </div>
      <div className="overflow-x-auto -mx-6 px-6 scrollbar-thin" role="region" aria-label="Feature comparison table — scroll horizontally to see all tools" tabIndex={0}>
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-[var(--nx-border-subtle)]">
              <th className="text-left py-4 pr-4 font-display font-semibold text-ink-secondary text-xs uppercase tracking-wider w-[240px]">Feature</th>
              {COMPETITORS.map((c) => (
                <th key={c.key} className="text-center py-4 px-3">
                  {c.icon ? (
                    <div className="flex flex-col items-center gap-1">
                      <img src="/nexus-icon.svg" alt="Nexus Lineage" className="w-6 h-6" />
                      <span className="font-display font-bold text-accent-lineage text-xs">{c.label}</span>
                    </div>
                  ) : (
                    <span className="font-display font-semibold text-ink-muted text-xs">{c.label}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.feature} className="border-b border-[var(--nx-border-subtle)] last:border-0">
                <td className="py-3 pr-4 text-ink-secondary">{row.feature}</td>
                {COMPETITORS.map((c) => (
                  <td key={c.key} className={`py-3 px-3 text-center ${c.highlight ? 'bg-accent-lineage/[0.03]' : ''}`}>
                    <div className="flex justify-center">
                      <StatusIcon status={row[c.key]} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-6 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5"><Check size={14} className="text-accent-business" /> Full support</span>
        <span className="flex items-center gap-1.5"><Minus size={14} className="text-accent-technical" /> Partial / limited</span>
        <span className="flex items-center gap-1.5"><X size={14} className="text-ink-muted/40" /> Not available</span>
      </div>

      {/* Callout */}
      <div className="mt-10 glass-panel rounded-2xl p-6 max-w-2xl mx-auto text-center">
        <p className="text-sm text-ink-secondary leading-relaxed">
          <strong className="text-ink">Different tools, different strengths.</strong> OpenMetadata and DataHub
          excel at metadata ingestion with 100+ connectors. Nexus Lineage excels at <em>visualizing and
          exploring</em> lineage interactively — connecting directly to your graph without requiring you
          to re-ingest data into yet another store.
        </p>
      </div>
    </Section>
  )
}
