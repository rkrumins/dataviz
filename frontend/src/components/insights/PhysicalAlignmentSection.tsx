/**
 * PhysicalAlignmentSection — the per-data-source "Physical Alignment & Query
 * Performance" report inside the DataSourceProfile.
 *
 * Reads GET /{ws}/graph/alignment-analysis — assembled server-side entirely
 * from CACHED profiling data (no live graph queries): how this source's
 * physical graph aligns with its assigned schema, which labels are backed by
 * FalkorDB indexes, and PREDICTIVE slow-query findings (case-drifted or
 * unmapped types bypass the declared-spelling label indexes and fall back to
 * label scans on raw reads; a READY aggregation canonicalizes spellings and
 * restores index-backed reads).
 *
 * Self-contained (own fetch + render), mounted in the profile's
 * workspace-context block when an ontology is assigned.
 */
import { useQuery } from '@tanstack/react-query'
import {
  Activity, AlertTriangle, AlertOctagon, Info, CheckCircle2, Gauge, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import type { AdoptionDimension } from '@/services/ontologyDefinitionService'
import { DimBreakdown } from '@/features/ontology/components/panels/AdoptionMatchSection'
import { PropertyStorageFinding } from './PropertyStorageFinding'

export interface AlignmentFinding {
  severity: 'critical' | 'warning' | 'info'
  code: string
  message: string
  instances?: number
}

export interface AlignmentAnalysis {
  profiled: boolean
  schemaUpdatedAt: string | null
  ontology: { id: string; name: string; version: number } | null
  adoption: {
    nodes: AdoptionDimension | null
    edges: AdoptionDimension | null
    matchWeighted: number
    matchByType: number
  } | null
  indexCoverage: {
    indexedLabels: string[]
    indexedProps: string[]
    unindexedPhysical: { label: string; declared: string | null; instances: number; reason: 'case_drift' | 'unmapped' }[]
  } | null
  aggregation: { status: string; lastAggregatedAt: string | null; canonicalized: boolean }
  grade: 'A' | 'B' | 'C' | 'D' | null
  findings: AlignmentFinding[]
}

async function fetchAlignmentAnalysis(wsId: string, dataSourceId: string): Promise<AlignmentAnalysis | null> {
  const res = await fetchWithTimeout(
    `/api/v1/${wsId}/graph/alignment-analysis?dataSourceId=${encodeURIComponent(dataSourceId)}`,
  )
  if (!res.ok) return null
  return (await res.json()) as AlignmentAnalysis
}

const GRADE_STYLE: Record<string, { ring: string; text: string; label: string }> = {
  A: { ring: 'text-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Fully index-aligned' },
  B: { ring: 'text-emerald-400', text: 'text-emerald-600 dark:text-emerald-400', label: 'Well aligned' },
  C: { ring: 'text-amber-500', text: 'text-amber-600 dark:text-amber-400', label: 'Partially aligned' },
  D: { ring: 'text-red-500', text: 'text-red-600 dark:text-red-400', label: 'Poorly aligned' },
}

const SEVERITY = {
  critical: { Icon: AlertOctagon, cls: 'text-red-500' },
  warning: { Icon: AlertTriangle, cls: 'text-amber-500' },
  info: { Icon: Info, cls: 'text-ink-muted' },
} as const

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function PhysicalAlignmentSection({ wsId, dataSourceId, onOpenMapping }: {
  wsId: string
  dataSourceId: string
  /** Switch the host drawer to its Mapping tab. When absent the finding
   *  still renders, just without an action — this section is also mounted
   *  outside that drawer. */
  onOpenMapping?: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['alignment-analysis', wsId, dataSourceId],
    queryFn: () => fetchAlignmentAnalysis(wsId, dataSourceId),
    enabled: Boolean(wsId && dataSourceId),
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-glass-border text-xs text-ink-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing physical alignment…
      </div>
    )
  }
  if (!data) return null

  const grade = data.grade ? GRADE_STYLE[data.grade] : null
  const pct = data.adoption ? Math.round(data.adoption.matchWeighted) : null

  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
      <div className="px-4 pt-3.5 pb-1 flex items-center gap-2">
        <Gauge className="w-4 h-4 text-indigo-500" />
        <h3 className="text-xs font-bold text-ink">Physical Alignment & Query Performance</h3>
        <span className="ml-auto text-[10px] text-ink-muted">
          from cached profile · {timeAgo(data.schemaUpdatedAt)}
        </span>
      </div>

      {!data.profiled ? (
        <p className="px-4 pb-4 pt-1 text-xs text-ink-muted">
          Not profiled yet — the analysis appears after the insights service scans this source's graph.
        </p>
      ) : (
        <div className="px-4 pb-4 space-y-3.5">
          {/* Grade hero */}
          <div className="flex items-center gap-4 pt-1.5">
            <div className="relative w-16 h-16 flex-shrink-0">
              <svg className="w-16 h-16 -rotate-90" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4"
                  className="text-black/5 dark:text-white/5" stroke="currentColor" />
                <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${Math.round((pct ?? 0) * 1.005)} 101`}
                  className={grade?.ring ?? 'text-ink-muted'} stroke="currentColor" />
              </svg>
              <span className={cn('absolute inset-0 flex items-center justify-center text-xl font-black', grade?.text)}>
                {data.grade}
              </span>
            </div>
            <div className="min-w-0">
              <p className={cn('text-sm font-bold', grade?.text)}>{grade?.label}</p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                <span className="font-semibold text-ink">{pct}%</span> of this source's data
                ({data.adoption!.matchWeighted >= 100 ? 'all' : 'exact-spelling'} instances) hits the
                schema's FalkorDB label indexes
                {data.ontology && <> · schema <span className="font-medium">{data.ontology.name}</span> v{data.ontology.version}</>}
                {data.aggregation.canonicalized && (
                  <> · <span className="text-emerald-600 dark:text-emerald-400 font-medium">reads canonicalized via aggregation</span></>
                )}
              </p>
            </div>
          </div>

          {/* Findings */}
          {data.findings.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> Every physical type is index-backed — no predicted slow queries.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.findings.map((f, i) => {
                const { Icon, cls } = SEVERITY[f.severity]
                return (
                  <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-[11px] text-ink-secondary leading-relaxed">
                    <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', cls)} />
                    <span>
                      {f.message}
                      {/* Fetched all along, never rendered — and it's the
                          number that tells you whether a finding is a footnote
                          or the whole problem. */}
                      {f.instances != null && f.instances > 0 && (
                        <span className="ml-1 text-ink-muted tabular-nums">
                          ({f.instances.toLocaleString()} instances)
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Property storage — the same problem on the sibling axis. This
              panel grades LABEL alignment (is the type index-backed?); a
              property nested inside a container is unqueryable for exactly the
              same reason, and was missing from the picture entirely. */}
          <PropertyStorageFinding
            wsId={wsId} dataSourceId={dataSourceId} onFix={onOpenMapping}
          />

          {/* Per-dimension chips — same semantics as the ontology Health tab */}
          {data.adoption && (
            <div className="space-y-2.5 pt-1 border-t border-glass-border/40">
              <div className="flex items-center gap-1.5 pt-2">
                <Activity className="w-3 h-3 text-ink-muted" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Type-by-type</span>
              </div>
              <DimBreakdown title="Entity types" dim={data.adoption.nodes} />
              <DimBreakdown title="Relationship types" dim={data.adoption.edges} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
