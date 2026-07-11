/**
 * DeclaredVsPhysical — the one canonical visual that teaches the core mental model:
 * an ontology is the DECLARED layer (what things mean); the graph store (FalkorDB) is
 * the PHYSICAL layer (how they're stored). Entity types become node labels, relationship
 * types become edge types — and crucially, *those declared names are exactly what appears
 * on the physical graph* when you build or project a versioned graph.
 *
 * Reused across the Schema, Health and Usage tabs and the blank-model build surface so the
 * concept is taught the same way everywhere. Pass the ontology's own first types as the
 * example so it reads as concrete, not abstract.
 */
import { ArrowRight, Box, GitBranch, Database, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DeclaredVsPhysicalProps {
  /** Declared entity type → node label example (defaults to a generic one). */
  entityExample?: string
  /** Declared relationship type → edge type example. */
  edgeExample?: string
  /** Show the "versioned graph" explanatory footer (default true). */
  footer?: boolean
  className?: string
}

/** Editor-created types carry opaque ids (``rel_lx3_a1b2c3d``); never show one in a
 * teaching example — fall back to a clean, illustrative default instead. */
function cleanOrDefault(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim()
  if (!v) return fallback
  if (/^(rel|ent|nx|node|edge)_[a-z0-9]+_[a-z0-9]{5,}$/i.test(v)) return fallback
  return v
}

export function DeclaredVsPhysical({
  entityExample,
  edgeExample,
  footer = true,
  className,
}: DeclaredVsPhysicalProps) {
  const ent = cleanOrDefault(entityExample, 'Customer')
  const edge = cleanOrDefault(edgeExample, 'FLOWS_TO')
  const rows = [
    { Icon: Box, tone: 'text-indigo-500', declared: ent, physical: `:${ent}`, kind: 'node label' },
    { Icon: GitBranch, tone: 'text-accent-lineage', declared: edge, physical: `[:${edge}]`, kind: 'edge type' },
  ]
  return (
    <div className={cn('rounded-lg border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] overflow-hidden', className)}>
      {/* column headers */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          <ScrollText className="w-3 h-3 flex-shrink-0" /><span className="truncate">Ontology · declared</span>
        </div>
        <span className="w-3.5" />
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
          <Database className="w-3 h-3 flex-shrink-0" /><span className="truncate">Physical graph</span>
        </div>
      </div>
      {/* mapping rows */}
      <div className="divide-y divide-glass-border/50">
        {rows.map(r => (
          <div key={r.kind} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2">
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <r.Icon className={cn('w-3.5 h-3.5 flex-shrink-0', r.tone)} />
              <span className="font-mono text-[11px] text-ink truncate" title={r.declared}>{r.declared}</span>
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-ink-muted/50 flex-shrink-0" />
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <code className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400 truncate" title={r.physical}>{r.physical}</code>
              <span className="text-[10px] text-ink-muted whitespace-nowrap hidden sm:inline">{r.kind}</span>
            </span>
          </div>
        ))}
      </div>
      {footer && (
        <p className="text-[11px] text-ink-muted leading-relaxed px-3 py-2.5 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          When you build or project a <span className="font-medium text-ink-secondary">versioned graph</span>, every node and edge is written with these
          types. FalkorDB is case-sensitive and indexes by them, so the platform normalizes your data to the ontology's exact spelling —
          keeping the graph, its indexes and this model in lock-step.
        </p>
      )}
    </div>
  )
}
