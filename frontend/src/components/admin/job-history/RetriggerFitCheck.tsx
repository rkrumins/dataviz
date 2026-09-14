/**
 * The fit check in the re-trigger dialog: would this run fit, BEFORE it is
 * queued? Reads the source's shard once and re-decides on the client as the
 * operator changes Rollup storage, the reserve, bytes per edge or the ceiling
 * in the form below — the pipeline's own arithmetic, so the verdict here is
 * the verdict the run would reach.
 */
import { CheckCircle2, HelpCircle, Loader2, XCircle } from 'lucide-react'
import type { AggregationTuning } from '@/services/aggregationService'
import { compactBytes, compactEdges, fullDetailVerdict } from '../shared/aggregationKnobs'
import { useSourceCapacity } from '../shared/useAggregationCapacity'

export function RetriggerFitCheck({ dataSourceId, draftTuning, defaultFinePairs }: {
    dataSourceId: string
    draftTuning?: AggregationTuning | null
    defaultFinePairs?: 'auto' | 'true' | 'false'
}) {
    const q = useSourceCapacity(dataSourceId, true)
    const doc = q.data

    if (q.isLoading) {
        return (
            <div className="flex items-center gap-2 rounded-xl border border-glass-border px-3 py-2 text-[12px] text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Measuring this source’s shard…
            </div>
        )
    }
    if (q.isError || !doc) return null

    const rawMode = draftTuning?.materializeFinePairs
    const mode: 'auto' | 'true' | 'false' = rawMode == null
        ? (defaultFinePairs ?? (typeof doc.limits.rollupStorage.value === 'string' ? doc.limits.rollupStorage.value as 'auto' | 'true' | 'false' : 'true'))
        : rawMode === 'auto' ? 'auto' : rawMode ? 'true' : 'false'
    const reserve = typeof draftTuning?.shardReservePct === 'number'
        ? draftTuning.shardReservePct
        : typeof doc.limits.shardReservePct.value === 'number' ? doc.limits.shardReservePct.value : 20
    const bpe = typeof draftTuning?.bytesPerEdge === 'number' ? draftTuning.bytesPerEdge : doc.source.bytesPerEdge
    const ceiling = typeof draftTuning?.maxMaterializedEdges === 'number'
        ? draftTuning.maxMaterializedEdges
        : typeof doc.limits.maxMaterializedEdges.value === 'number' ? doc.limits.maxMaterializedEdges.value : null

    const full = fullDetailVerdict({
        shard: doc.shard, limits: doc.limits, edgeCount: doc.source.edgeCount,
        estimateEdges: doc.source.lastCubeEstimate, bytesPerEdge: bpe, reservePct: reserve, ceiling,
    })

    let Icon = HelpCircle
    let iconClass = 'text-ink-muted'
    let headline: string
    let detail: string
    if (mode === 'auto') {
        Icon = CheckCircle2; iconClass = 'text-emerald-500'
        headline = 'Auto: this run is never refused.'
        detail = full.verdict === 'fits'
            ? `Full detail would fit today (~${compactEdges(full.growthEdges)} new edges), so Auto would store it.`
            : full.verdict === 'short'
                ? 'Full detail would not fit today, so Auto stores the depth-diagonal and derives finer granularities on demand.'
                : 'No estimate yet: Auto stores full detail only once the estimate fits both its cube ceiling and the shard.'
    } else if (mode === 'false') {
        Icon = CheckCircle2; iconClass = 'text-emerald-500'
        headline = 'Depth-diagonal only: the smallest result this pipeline stores.'
        detail = doc.shard.measurable
            ? `${compactBytes(freeAt(doc, reserve))} free on ${doc.shard.endpoint} after a ${reserve}% reserve.`
            : 'The shard cannot be measured; the static cap governs.'
    } else if (full.verdict === 'fits') {
        Icon = CheckCircle2; iconClass = 'text-emerald-500'
        headline = 'Full detail: fits.'
        detail = `~${compactEdges(full.growthEdges)} new edges need ${compactBytes(full.neededBytes)}; ${compactBytes(full.freeBytes)} is free on ${doc.shard.endpoint} after a ${reserve}% reserve (${doc.limits.estimateMarginPct}% margin on the estimate).`
    } else if (full.verdict === 'short') {
        Icon = XCircle; iconClass = 'text-red-500'
        headline = full.blockedBy === 'ceiling'
            ? 'Full detail: over the edge ceiling.'
            : `Full detail: short by ${compactBytes(full.shortfallBytes)}.`
        detail = full.blockedBy === 'ceiling'
            ? `The last run estimated ~${compactEdges(doc.source.lastCubeEstimate)} edges, above the ceiling of ${compactEdges(ceiling)}. Raise or clear the ceiling, or choose Auto.`
            : `~${compactEdges(full.growthEdges)} new edges need ${compactBytes(full.neededBytes)}; only ${compactBytes(full.freeBytes)} is free on ${doc.shard.endpoint} after a ${reserve}% reserve. Choose Auto, free memory on that shard, or lower the reserve if the headroom is real.`
    } else {
        headline = 'Full detail: unknown until a first rebuild has estimated this graph.'
        detail = doc.shard.measurable
            ? `${compactBytes(freeAt(doc, reserve))} is free on ${doc.shard.endpoint} after a ${reserve}% reserve. Auto is the safe choice for a large graph.`
            : 'The shard cannot be measured; the static cap governs. Auto is the safe choice for a large graph.'
    }

    return (
        <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2.5" data-testid="fit-check">
            <p className="flex items-start gap-2 text-[12px] text-ink leading-snug">
                <Icon className={`w-4 h-4 mt-px shrink-0 ${iconClass}`} />
                <span>
                    <span className="font-semibold">{headline}</span>{' '}
                    <span className="text-ink-muted">{detail}</span>
                </span>
            </p>
        </div>
    )
}

function freeAt(doc: NonNullable<ReturnType<typeof useSourceCapacity>['data']>, reserve: number): number | null {
    if (!doc.shard.measurable || doc.shard.maxmemory == null || doc.shard.used == null) return null
    return Math.max(0, doc.shard.maxmemory - Math.floor(doc.shard.maxmemory * reserve / 100) - doc.shard.used)
}
