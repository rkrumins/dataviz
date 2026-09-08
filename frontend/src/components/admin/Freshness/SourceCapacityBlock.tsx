/**
 * This source on its shard: what its rollups cost today, what its shard has
 * left under the reserve, what the last run decided, and whether the next
 * one would fit — Full detail against the last run's estimate, Auto never
 * refused. The same reading the rebuild takes; "Re-measure" takes it again.
 */
import { useState } from 'react'
import { CheckCircle2, HelpCircle, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DocsLink } from '@/components/help/DocsLink'
import { compactBytes, compactEdges } from '../shared/aggregationKnobs'
import { useRemeasureCapacity, useSourceCapacity } from '../shared/useAggregationCapacity'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">{label}</dt>
            <dd className="mt-0.5 text-[12px] text-ink leading-snug tabular-nums">{children}</dd>
        </div>
    )
}

export function SourceCapacityBlock({ dsId }: { dsId: string }) {
    const q = useSourceCapacity(dsId, true)
    const remeasure = useRemeasureCapacity()
    const [busy, setBusy] = useState(false)
    const doc = q.data

    const onRemeasure = async () => {
        setBusy(true)
        try {
            await remeasure()
            await q.refetch()
        } catch { /* the query's error state says so */ } finally { setBusy(false) }
    }

    return (
        <section className="rounded-xl border border-glass-border p-3" aria-labelledby={`capacity-${dsId}`}>
            <div className="flex items-center justify-between gap-2">
                <h3 id={`capacity-${dsId}`} className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted flex items-center gap-2">
                    Capacity
                    <DocsLink slug="rollup-capacity" variant="icon" />
                </h3>
                <button
                    type="button"
                    onClick={onRemeasure}
                    disabled={busy}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} />
                    Re-measure
                </button>
            </div>

            {q.isLoading ? (
                <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-muted">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Measuring this source’s shard…
                </div>
            ) : q.isError || !doc ? (
                <p className="mt-2 text-[12px] text-ink-muted">Capacity could not be measured right now.</p>
            ) : (
                <>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
                        <Row label="Shard">
                            {doc.shard.measurable ? (
                                <>
                                    <span className="font-mono">{doc.shard.endpoint}</span>
                                    {' · '}{compactBytes(doc.shard.used)} of {compactBytes(doc.shard.maxmemory)} used
                                    {doc.shard.usedPct != null && ` (${Math.round(doc.shard.usedPct)}%)`}
                                </>
                            ) : (
                                <>
                                    <span className="font-mono">{doc.shard.endpoint}</span>
                                    {' · '}cannot be measured{doc.shard.whyNot ? `: ${doc.shard.whyNot}` : ''}. The static cap of {doc.shard.staticCap.toLocaleString()} edges governs.
                                </>
                            )}
                        </Row>
                        <Row label="Footprint">
                            {doc.source.edgeCount.toLocaleString()} rollup edges {' · '} ~{compactBytes(doc.source.footprintBytes)} at {doc.source.bytesPerEdge} B each
                            <span className="text-ink-muted"> ({doc.source.bytesPerEdgeSource === 'calibrated' ? 'measured by the last rebuild' : 'planning figure'})</span>
                        </Row>
                        <Row label="Headroom">
                            {doc.shard.measurable ? (
                                <>
                                    {compactBytes(doc.shard.availableBytes)} free after the {doc.shard.reservePct}% reserve
                                    {' → '}fits ~{compactEdges(doc.shard.allowedGrowthEdges)} more rollup edges
                                </>
                            ) : '—'}
                        </Row>
                        <Row label="Last decision">
                            {doc.source.lastRegime
                                ? (
                                    <>
                                        {doc.source.lastRegime === 'cube' ? 'Full detail stored' : 'Depth-diagonal stored'}
                                        {doc.source.lastCubeEstimate != null && ` · full detail estimated at ~${compactEdges(doc.source.lastCubeEstimate)} edges`}
                                    </>
                                )
                                : 'No completed rebuild yet'}
                        </Row>
                    </dl>

                    <div className="mt-3 space-y-1.5" data-testid="preflight">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Before the next rebuild</p>
                        <p className="flex items-start gap-1.5 text-[12px] text-ink leading-snug">
                            {doc.fullDetail.verdict === 'fits'
                                ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" />
                                : doc.fullDetail.verdict === 'short'
                                    ? <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-500" />
                                    : <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" />}
                            <span>
                                <span className="font-medium">Full detail: </span>
                                {doc.fullDetail.verdict === 'fits' && (
                                    <>fits {' — '}~{compactEdges(doc.fullDetail.growthEdges)} new edges need {compactBytes(doc.fullDetail.neededBytes)}, with a {doc.fullDetail.marginPct}% margin on the estimate.</>
                                )}
                                {doc.fullDetail.verdict === 'short' && (
                                    doc.fullDetail.blockedBy === 'ceiling'
                                        ? <>would exceed the explicit edge ceiling {' — '}~{compactEdges(doc.fullDetail.estimateEdges)} edges in total.</>
                                        : <>short by {compactBytes(doc.fullDetail.shortfallBytes)} {' — '}~{compactEdges(doc.fullDetail.growthEdges)} new edges need {compactBytes(doc.fullDetail.neededBytes)}.</>
                                )}
                                {doc.fullDetail.verdict === 'unknown' && (
                                    <>unknown until a first rebuild has estimated this graph. Auto is the safe choice for a large graph.</>
                                )}
                            </span>
                        </p>
                        <p className="flex items-start gap-1.5 text-[12px] text-ink leading-snug">
                            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" />
                            <span>
                                <span className="font-medium">Auto: </span>never refused{' — '}
                                {doc.auto.wouldStoreCube == null
                                    ? 'stores full detail while it fits both its cube ceiling and the shard, the depth-diagonal otherwise.'
                                    : doc.auto.wouldStoreCube
                                        ? 'would store full detail today.'
                                        : `would store the depth-diagonal today (full detail is over Auto’s ${compactEdges(doc.auto.cubeCeiling)}-edge ceiling or the shard).`}
                            </span>
                        </p>
                    </div>
                </>
            )}
        </section>
    )
}
