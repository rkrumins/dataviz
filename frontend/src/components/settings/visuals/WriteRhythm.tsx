/**
 * WriteRhythm — how a node's time is shared while a graph updates: each write (a bar) is followed
 * by a pause (a gap readers get), the pause a multiple of the write. Normally the pause is the
 * "pause after a write"; while readers on the node are waiting it grows to the "pause while reads
 * wait". The figure on the right is the share of time reads get.
 *
 * Staged values draw a thin accent strip under each row, with the new share beside the old.
 */
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatMs, formatNumber } from '@/lib/units'
import { useCalmMotion } from './motion'
import { LegendKey, VisualFrame } from './VisualFrame'

export interface Rhythm {
    statementTargetMs: number
    pacingRatio: number
    readPressureRatio: number
}

const W = 600
/** A round window that fits about three cycles of the slower rhythm. */
function windowMs(cycle: number): number {
    const target = Math.max(1000, cycle * 3.2)
    const mag = 10 ** Math.floor(Math.log10(target))
    return [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= target) ?? target
}

const share = (ratio: number) => (ratio <= 0 ? 0 : ratio / (1 + ratio))
const pct = (s: number) => `${Math.round(s * 100)}%`

function Strip({ write, ratio, span, height, accent = false }: { write: number; ratio: number; span: number; height: number; accent?: boolean }) {
    const { transition } = useCalmMotion()
    const pause = write * ratio
    const cycle = write + pause
    const bars: Array<{ x: number; w: number }> = []
    for (let t = 0; t < span && bars.length < 400; t += Math.max(cycle, 1)) {
        bars.push({ x: (t / span) * W, w: (Math.min(write, span - t) / span) * W })
    }
    return (
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden className="block w-full" style={{ height }}>
            <rect x={0} y={0} width={W} height={height} rx={height / 2.5} className={accent ? 'fill-accent-lineage/[0.07]' : 'fill-emerald-500/[0.12]'} />
            {bars.map((b, i) => (
                <motion.rect key={i} initial={false} animate={{ x: b.x, width: Math.max(0, b.w - 1.5) }} transition={transition}
                    y={0} height={height} rx={Math.min(4, height / 2.5)} className={accent ? 'fill-accent-lineage/80' : 'fill-ink-secondary/75'} />
            ))}
        </svg>
    )
}

export function WriteRhythm({ statementTargetMs, pacingRatio, readPressureRatio, next, className }: Rhythm & {
    /** The rhythm with staged changes applied. */
    next?: Rhythm
    className?: string
}) {
    const changed = next !== undefined && (next.statementTargetMs !== statementTargetMs || next.pacingRatio !== pacingRatio || next.readPressureRatio !== readPressureRatio)
    const slowest = Math.max(
        statementTargetMs * (1 + readPressureRatio),
        changed && next ? next.statementTargetMs * (1 + next.readPressureRatio) : 0,
    )
    const span = windowMs(slowest)
    const rows = [
        { label: 'Normally', ratio: pacingRatio, nextRatio: next?.pacingRatio },
        { label: 'While reads wait', ratio: readPressureRatio, nextRatio: next?.readPressureRatio },
    ]
    const say = (r: Rhythm) => `Each write of ${formatMs(r.statementTargetMs)} is followed by a pause of ${formatMs(Math.round(r.statementTargetMs * r.pacingRatio))} (×${formatNumber(r.pacingRatio)}), so reads get ${pct(share(r.pacingRatio))} of the node’s time. While reads wait, the pause grows to ${formatMs(Math.round(r.statementTargetMs * r.readPressureRatio))} (×${formatNumber(r.readPressureRatio)}): reads get ${pct(share(r.readPressureRatio))}.`

    return (
        <VisualFrame
            title="How a node shares its time while a graph updates"
            className={className}
            legend={(
                <>
                    <LegendKey className="bg-ink-secondary/75">Writing</LegendKey>
                    <LegendKey className="bg-emerald-500/30">Reads get the node</LegendKey>
                    {changed && <LegendKey className="bg-accent-lineage/80">With your changes</LegendKey>}
                </>
            )}
            caption={(
                <>
                    <span className="block">{say({ statementTargetMs, pacingRatio, readPressureRatio })}</span>
                    {changed && next && <>{' '}<span className="block font-medium text-accent-lineage">With your changes: {say(next)}</span></>}
                </>
            )}
        >
            <div className="space-y-4">
                {rows.map((row) => {
                    const nextShare = changed && next ? share(row.nextRatio ?? row.ratio) : null
                    return (
                        <div key={row.label} className="grid items-center gap-x-4 gap-y-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_6.5rem]">
                            <span className="text-xs font-semibold text-ink">{row.label}</span>
                            <div className="space-y-1">
                                <Strip write={statementTargetMs} ratio={row.ratio} span={span} height={18} />
                                {changed && next && <Strip write={next.statementTargetMs} ratio={row.nextRatio ?? row.ratio} span={span} height={6} accent />}
                            </div>
                            <span className="text-right sm:text-left">
                                <span className="text-lg font-semibold text-ink">{pct(share(row.ratio))}</span>
                                {nextShare !== null && Math.round(nextShare * 100) !== Math.round(share(row.ratio) * 100) && (
                                    <span className="ml-1.5 text-sm font-semibold text-accent-lineage">→ {pct(nextShare)}</span>
                                )}
                                <span className="block text-[10.5px] text-ink-muted">for reads</span>
                            </span>
                        </div>
                    )
                })}
                <div aria-hidden className={cn('flex justify-between text-[10px] tabular-nums text-ink-muted sm:ml-[8.5rem] sm:mr-[7.5rem]')}>
                    <span>0</span><span>{formatMs(span / 2)}</span><span>{formatMs(span)}</span>
                </div>
            </div>
        </VisualFrame>
    )
}
