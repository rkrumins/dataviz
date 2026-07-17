/**
 * SourceMappingSection — the ontology's source-vocabulary alias table.
 *
 * For every assigned data source, shows how the layer's DECLARED type ids map
 * to the spellings actually OBSERVED in that source's physical graph (the
 * alignment profile the read path maintains): exact matches in green,
 * case-drift/variants in amber, auto vs human-confirmed badges, and inline
 * Keep-merged / Split decisions for multi-variant collisions (reusing the
 * vocab-alignment confirm route, which also bumps the resolution cache).
 */
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Database, Loader2, Search, ChevronDown, ChevronRight, ChevronLeft, GitBranch, Box,
  CheckCircle2, AlertTriangle, User, Bot, SplitSquareHorizontal, Merge,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ontologyDefinitionService,
  type OntologySourceMappingRow,
  type SourceMappingEntry,
  type SourceMappingFilter,
} from '@/services/ontologyDefinitionService'
import { confirmVariant } from '@/components/admin/workspace/VocabAlignmentWarning'
import { useToast } from '@/components/ui/toast'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { formatDate } from '../../lib/ontology-parsers'
import { FacetChip } from './AdoptionMatchSection'

interface SourceMappingSectionProps {
  ontologyId: string
}

const PAGE_SIZE = 6

const FILTERS: { key: SourceMappingFilter; label: string; tone: 'neutral' | 'drift' | 'unmapped' | 'muted' }[] = [
  { key: 'all', label: 'All', tone: 'neutral' },
  { key: 'pending', label: 'Decision pending', tone: 'unmapped' },
  { key: 'drift', label: 'Drift', tone: 'drift' },
  { key: 'unprofiled', label: 'No profile yet', tone: 'muted' },
]

function observedList(entry: SourceMappingEntry): string[] {
  if (!entry.observed) return []
  return Array.isArray(entry.observed) ? entry.observed : [entry.observed]
}

export function SourceMappingSection({ ontologyId }: SourceMappingSectionProps) {
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 250)
  const [filter, setFilter] = useState<SourceMappingFilter>('all')
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [deciding, setDeciding] = useState<string | null>(null)

  // Any narrowing change resets to the first page.
  useEffect(() => { setOffset(0) }, [search, filter])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['ontology-source-mappings', ontologyId, { limit: PAGE_SIZE, offset, search, filter }],
    queryFn: () => ontologyDefinitionService.getSourceMappings(ontologyId, {
      limit: PAGE_SIZE, offset, search, filter,
    }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })

  function toggle(dsId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(dsId)) next.delete(dsId)
      else next.add(dsId)
      return next
    })
  }

  async function decide(row: OntologySourceMappingRow, declared: string, dimension: string, keep: boolean) {
    const key = `${row.dataSourceId}:${declared}`
    setDeciding(key)
    try {
      await confirmVariant(row.workspaceId, row.dataSourceId, declared, keep, dimension)
      await queryClient.invalidateQueries({ queryKey: ['ontology-source-mappings', ontologyId] })
      showToast('success', keep
        ? `Kept all spellings of ${declared} merged`
        : `Split ${declared} — only the exact spelling stays mapped`)
    } catch (err) {
      showToast('error', `Failed to record decision: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setDeciding(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading vocabulary mappings...</span>
      </div>
    )
  }

  if (!data || data.facets.all === 0) return null

  const from = data.total === 0 ? 0 : offset + 1
  const to = Math.min(offset + PAGE_SIZE, data.total)
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < data.total

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
          <Merge className="w-3.5 h-3.5" />
          Source Vocabulary Mappings
        </h3>
        <span className="px-2 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-bold text-ink-muted">
          {data.facets.all} source{data.facets.all !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="text-[11px] text-ink-muted mb-3">
        How this layer&rsquo;s declared type ids map to the spellings observed in each source&rsquo;s
        physical graph. Case-drift is aligned automatically; multi-variant collisions wait for your
        Keep/Split decision — explicit decisions are never overwritten by re-derivation.
      </p>

      {(data.facets.all > PAGE_SIZE || search || filter !== 'all') && (
        <div className="flex items-center flex-wrap gap-2 mb-3">
          <div className="relative max-w-xs flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search sources..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-colors"
            />
          </div>
          <div className="flex items-center flex-wrap gap-1.5">
            {FILTERS.map(f => (
              <FacetChip key={f.key} label={f.label} tone={f.tone} count={data.facets[f.key]}
                active={filter === f.key} onClick={() => setFilter(f.key)} />
            ))}
          </div>
        </div>
      )}

      {data.sources.length === 0 && (
        <div className="border border-dashed border-glass-border rounded-xl py-8 text-center">
          <Database className="w-5 h-5 mx-auto mb-2 text-ink-muted/40" />
          <p className="text-xs text-ink-muted">
            {search || filter !== 'all'
              ? 'No sources match these filters'
              : 'No alignment profiles yet — profiles appear after the first read of each assigned source.'}
          </p>
        </div>
      )}

      <div className={cn('space-y-2 transition-opacity', isFetching && 'opacity-60')}>
        {data.sources.map(row => {
          if (!row.hasProfile) {
            return (
              <div key={row.dataSourceId} className="rounded-xl border border-dashed border-glass-border px-4 py-3 flex items-center gap-3">
                <Database className="w-4 h-4 flex-shrink-0 text-ink-muted/50" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-ink truncate">{row.dataSourceLabel}</p>
                  <p className="text-[10px] text-ink-muted truncate">{row.workspaceName}</p>
                </div>
                <span className="text-[10px] text-ink-muted italic">no profile yet — appears after the first read</span>
              </div>
            )
          }
          const isOpen = expanded.has(row.dataSourceId) || row.hasDrift
          const pendingDecisions = row.driftDetails.filter(d => d.needsConfirmation)
          return (
            <div key={row.dataSourceId} className="rounded-xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
              <button
                onClick={() => toggle(row.dataSourceId)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
              >
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />}
                <Database className={cn('w-4 h-4 flex-shrink-0', row.hasDrift ? 'text-amber-500' : 'text-emerald-500')} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-ink truncate">{row.dataSourceLabel}</p>
                  <p className="text-[10px] text-ink-muted truncate">
                    {row.workspaceName}
                    {row.lastSeenAt && <> · profile updated {formatDate(row.lastSeenAt)}</>}
                  </p>
                </div>
                {pendingDecisions.length > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                    <AlertTriangle className="w-2.5 h-2.5" /> {pendingDecisions.length} decision{pendingDecisions.length !== 1 ? 's' : ''} pending
                  </span>
                )}
                {!row.hasDrift && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-2.5 h-2.5" /> aligned
                  </span>
                )}
              </button>

              {isOpen && (
                <div className="border-t border-glass-border/40 px-4 py-3 space-y-4">
                  <MappingDimension
                    title="Entity types"
                    icon={Box}
                    mappings={row.entityMappings}
                  />
                  <MappingDimension
                    title="Relationship types"
                    icon={GitBranch}
                    mappings={row.relationshipMappings}
                  />

                  {pendingDecisions.length > 0 && (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3 space-y-2">
                      <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                        This source spells the following types more than one way — keep them merged, or split?
                      </p>
                      {pendingDecisions.map(d => {
                        const key = `${row.dataSourceId}:${d.declared}`
                        const busy = deciding === key
                        return (
                          <div key={key} className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono font-semibold text-ink">{d.declared}</span>
                            <span className="text-[11px] text-ink-muted">← {d.observed.join(', ')}</span>
                            <div className="flex items-center gap-1 ml-auto">
                              <button
                                onClick={() => decide(row, d.declared, d.dimension, true)}
                                disabled={busy}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Merge className="w-3 h-3" />} Keep merged
                              </button>
                              <button
                                onClick={() => decide(row, d.declared, d.dimension, false)}
                                disabled={busy}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                              >
                                <SplitSquareHorizontal className="w-3 h-3" /> Split
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* pagination */}
      {data.total > 0 && (
        <div className="flex items-center justify-between mt-3 px-1">
          <span className="text-[11px] text-ink-muted tabular-nums">
            Showing <span className="text-ink font-medium">{from}–{to}</span> of {data.total}
            {data.total !== data.facets.all && <span className="text-ink-muted"> · {data.facets.all} total</span>}
          </span>
          {(canPrev || canNext) && (
            <div className="inline-flex items-center gap-1">
              <button disabled={!canPrev} onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-glass-border text-[11px] text-ink-muted hover:text-ink hover:border-glass-border/80 disabled:opacity-40 disabled:pointer-events-none transition-colors">
                <ChevronLeft className="w-3.5 h-3.5" />Prev
              </button>
              <button disabled={!canNext} onClick={() => setOffset(o => o + PAGE_SIZE)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-glass-border text-[11px] text-ink-muted hover:text-ink hover:border-glass-border/80 disabled:opacity-40 disabled:pointer-events-none transition-colors">
                Next<ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MappingDimension({ title, icon: Icon, mappings }: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  mappings: Record<string, SourceMappingEntry>
}) {
  const entries = Object.entries(mappings)
  if (entries.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5 flex items-center gap-1.5">
        <Icon className="w-3 h-3" /> {title}
      </p>
      <div className="space-y-1">
        {entries.map(([declared, entry]) => {
          const observed = observedList(entry)
          return (
            <div key={declared} className="flex items-center gap-2 flex-wrap py-1 px-2 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
              <span className="text-xs font-mono font-medium text-ink">{declared}</span>
              <span className="text-ink-muted/50 text-[10px]">←</span>
              {observed.length === 0 ? (
                <span className="text-[10px] italic text-ink-muted/60">not observed in this source</span>
              ) : observed.map(o => {
                const exact = o === declared
                return (
                  <span
                    key={o}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-mono border',
                      exact
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
                    )}
                    title={exact ? 'Exact spelling match' : 'Spelling differs — aligned to the declared id'}
                  >
                    {o}
                  </span>
                )
              })}
              <span
                className={cn(
                  'ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold border flex-shrink-0',
                  entry.auto === false
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
                    : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border',
                )}
                title={entry.auto === false
                  ? 'Human-confirmed — never overwritten by re-derivation'
                  : 'Auto-aligned from introspection'}
              >
                {entry.auto === false ? <User className="w-2.5 h-2.5" /> : <Bot className="w-2.5 h-2.5" />}
                {entry.auto === false ? 'confirmed' : 'auto'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
