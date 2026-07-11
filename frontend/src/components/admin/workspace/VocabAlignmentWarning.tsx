/**
 * VocabAlignmentWarning — per-source vocabulary-alignment drift banner (Task E).
 *
 * Self-contained (own hook + fetch + render) so it slots into DataSourceDetailPanel with
 * a single line and never collides with the provenance chips Task D adds to the same
 * header. Reads GET /graph/vocab-alignment: when the source spells relationship/entity
 * types differently than the ontology declares (has → HAS), those are aligned
 * automatically and this says so in plain language — non-blocking. A same-source
 * multi-variant (one type spelled several ways) is decision-bearing: Keep the merge or
 * Split into distinct types.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

interface DriftDetail {
  dimension: 'relationship' | 'entity'
  declared: string
  observed: string[]
  kind: 'case_variant' | 'multi_variant' | 'missing_observed' | 'identity'
  needsConfirmation?: boolean
}

interface VocabAlignment {
  hasDrift: boolean
  driftDetails: DriftDetail[]
}

async function fetchVocabAlignment(wsId: string, dataSourceId: string): Promise<VocabAlignment> {
  const res = await fetchWithTimeout(
    `/api/v1/${wsId}/graph/vocab-alignment?dataSourceId=${encodeURIComponent(dataSourceId)}`,
  )
  if (!res.ok) return { hasDrift: false, driftDetails: [] }
  return (await res.json()) as VocabAlignment
}

async function confirmVariant(
  wsId: string, dataSourceId: string, declared: string, keepMerged: boolean, dimension: string,
): Promise<void> {
  const params = new URLSearchParams({
    dataSourceId, declared, keepMerged: String(keepMerged), dimension,
  })
  await fetchWithTimeout(`/api/v1/${wsId}/graph/vocab-alignment/confirm?${params}`, { method: 'POST' })
}

export function VocabAlignmentWarning({ wsId, dataSourceId, className = 'mx-6 mb-3' }: {
  wsId: string; dataSourceId: string
  /** Container layout — override when embedding outside DataSourceDetailPanel (e.g. Health). */
  className?: string
}) {
  const { data, refetch } = useQuery({
    queryKey: ['vocab-alignment', wsId, dataSourceId],
    queryFn: () => fetchVocabAlignment(wsId, dataSourceId),
    enabled: Boolean(wsId && dataSourceId),
    staleTime: 60_000,
  })

  if (!data?.hasDrift) return null

  const variants = data.driftDetails.filter(d => d.kind === 'case_variant' && d.observed.length)
  const multi = data.driftDetails.filter(d => d.needsConfirmation)
  const missing = data.driftDetails.filter(d => d.kind === 'missing_observed')

  const onDecide = async (d: DriftDetail, keep: boolean) => {
    await confirmVariant(wsId, dataSourceId, d.declared, keep, d.dimension)
    await refetch()
  }

  return (
    <div className={`rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-700 dark:text-amber-300 ${className}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div className="space-y-1.5">
          {variants.length > 0 && (
            <p>
              {variants.length} {variants.length === 1 ? 'type is' : 'types are'} spelled differently
              in this graph than in the ontology ({variants.map(v => `${v.declared} → ${v.observed[0]}`).join(', ')}).
              {' '}Aligned automatically.
            </p>
          )}
          {missing.length > 0 && (
            <p className="text-amber-600/80 dark:text-amber-400/80">
              {missing.map(m => m.declared).join(', ')}{' '}
              {missing.length === 1 ? 'is' : 'are'} defined in the ontology but not present in this graph.
            </p>
          )}
          {multi.map(d => (
            <div key={`${d.dimension}:${d.declared}`} className="flex flex-wrap items-center gap-2">
              <span>
                This graph spells <span className="font-semibold">{d.declared}</span> {d.observed.length} ways
                ({d.observed.join(', ')}) — treated as one type.
              </span>
              <button
                onClick={() => onDecide(d, true)}
                className="px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/20 transition-colors"
              >
                Keep
              </button>
              <button
                onClick={() => onDecide(d, false)}
                className="px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/20 transition-colors"
              >
                Split into distinct types
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
