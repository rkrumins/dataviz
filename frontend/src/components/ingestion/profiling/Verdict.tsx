/**
 * One sentence stating what the window says.
 *
 * This is most of what separates a guided surface from a raw one. A board of
 * numbers asks the reader to do the reading; a sentence does it for them and
 * lets the numbers be the evidence. It is deliberately the FIRST thing on
 * every scope, and it is deliberately specific — "3 of 58 sources moved more
 * than usual" is a finding a person can act on, where "showing 58 sources" is
 * a status bar.
 *
 * Every claim here is derived from the same payload the chart draws, so the
 * sentence and the marks can never disagree.
 */
import { AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { BoardPayload, SeriesPayload } from '@/types/profiling'
import { metricNoun, signed } from './shared'

type Tone = 'calm' | 'attention' | 'new'

const TONE: Record<Tone, { wrap: string; icon: typeof CheckCircle2 }> = {
    calm: {
        wrap: 'border-glass-border bg-canvas-elevated text-ink-secondary',
        icon: CheckCircle2,
    },
    attention: {
        wrap: 'border-amber-500/30 bg-amber-500/[0.06] text-ink',
        icon: AlertTriangle,
    },
    new: {
        wrap: 'border-indigo-500/30 bg-indigo-500/[0.06] text-ink',
        icon: Sparkles,
    },
}

function Line({ tone, children }: { tone: Tone; children: React.ReactNode }) {
    const { wrap, icon: Icon } = TONE[tone]
    return (
        <p className={cn(
            'flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm leading-relaxed',
            wrap,
        )}>
            <Icon className="w-4 h-4 mt-0.5 shrink-0 opacity-80" aria-hidden />
            <span>{children}</span>
        </p>
    )
}

/** The board's verdict: how many sources moved unusually, and whether they
 *  share a provider — because several affected sources under one provider is
 *  a provider problem, and saying so turns a list into a lead. */
export function BoardVerdict({ board }: { board: BoardPayload }) {
    const unusual = board.rows.filter((r) => r.significance !== 'normal')
    const scope = board.platform_wide ? 'across the platform' : 'in your workspaces'

    if (!board.rows.length) {
        return (
            <Line tone="new">
                No source has reported counts in this window yet
                {board.unobserved > 0 && (
                    <> — {board.unobserved} {board.unobserved === 1 ? 'source is' : 'sources are'} waiting
                        for their first observation</>
                )}
                . Profiling records what it sees; give it a capture cycle.
            </Line>
        )
    }

    if (!unusual.length) {
        return (
            <Line tone="calm">
                Nothing moved unusually {scope} in this window.{' '}
                <strong className="font-semibold text-ink">{board.rows.length}</strong>{' '}
                {board.rows.length === 1 ? 'source' : 'sources'} reported
                {board.unobserved > 0 && (
                    <>, and {board.unobserved} {board.unobserved === 1 ? 'was' : 'were'} not
                        observed at all</>
                )}
                .
            </Line>
        )
    }

    const providers = new Set(unusual.map((r) => r.provider_name).filter(Boolean))
    const onlyProvider = providers.size === 1 ? [...providers][0] : null

    return (
        <Line tone="attention">
            <strong className="font-semibold">{unusual.length}</strong> of{' '}
            {board.rows.length} {board.rows.length === 1 ? 'source' : 'sources'} moved more
            than usual {scope}.
            {onlyProvider && unusual.length > 1 && (
                <> All of them are on <strong className="font-semibold">{onlyProvider}</strong>,
                    which usually means one cause rather than several.</>
            )}
            {board.unobserved > 0 && (
                <> A further {board.unobserved} reported nothing at all in this window.</>
            )}
        </Line>
    )
}

/** One source's verdict: what changed, by how much, and what it was measured
 *  against — because "unusual" is a claim a reader cannot check, and "12,400
 *  against a usual movement of 40" is an argument they can. */
export function SeriesVerdict({
    series, sourceName,
}: { series: SeriesPayload; sourceName?: string }) {
    const nodes = series.totals.nodes ?? []
    const edges = series.totals.edges ?? []
    const subject = sourceName ? <strong className="font-semibold">{sourceName}</strong> : 'This scope'

    if (!series.buckets.length) {
        return (
            <Line tone="new">
                Nothing recorded in this window yet. Counts are captured whenever they
                change, at every refresh run, and at least once an hour otherwise.
            </Line>
        )
    }

    if (series.buckets.length === 1) {
        return (
            <Line tone="new">
                {subject} has one observation so far —{' '}
                <strong className="font-semibold tabular-nums">
                    {(nodes.at(-1) ?? 0).toLocaleString()}
                </strong>{' '}
                {metricNoun('nodes', nodes.at(-1) ?? 0)} and{' '}
                <strong className="font-semibold tabular-nums">
                    {(edges.at(-1) ?? 0).toLocaleString()}
                </strong>{' '}
                {metricNoun('edges', edges.at(-1) ?? 0)}. This is the starting line, not a
                gap: the next capture gives it something to move against.
            </Line>
        )
    }

    const nodeMove = (nodes.at(-1) ?? 0) - (nodes[0] ?? 0)
    const edgeMove = (edges.at(-1) ?? 0) - (edges[0] ?? 0)
    const vanished = series.vanished_types ?? []

    if (vanished.length) {
        const names = vanished.slice(0, 3).map((v) => v.type).join(', ')
        return (
            <Line tone="attention">
                {vanished.length === 1 ? 'One type has' : `${vanished.length} types have`}{' '}
                disappeared from {sourceName ? <>{subject}</> : 'this scope'}: {names}
                {vanished.length > 3 && ` and ${vanished.length - 3} more`}. Nothing about
                the total size says so, which is why it is called out here.
            </Line>
        )
    }

    if (!nodeMove && !edgeMove) {
        return (
            <Line tone="calm">
                {subject} held steady across this window —{' '}
                <strong className="font-semibold tabular-nums">
                    {(nodes.at(-1) ?? 0).toLocaleString()}
                </strong>{' '}
                {metricNoun('nodes', nodes.at(-1) ?? 0)} throughout.
            </Line>
        )
    }

    return (
        <Line tone={nodeMove < 0 || edgeMove < 0 ? 'attention' : 'calm'}>
            {subject} moved{' '}
            <strong className="font-semibold tabular-nums">{signed(nodeMove)}</strong>{' '}
            {metricNoun('nodes', nodeMove)} and{' '}
            <strong className="font-semibold tabular-nums">{signed(edgeMove)}</strong>{' '}
            {metricNoun('edges', edgeMove)} across this window, ending at{' '}
            <strong className="font-semibold tabular-nums">
                {(nodes.at(-1) ?? 0).toLocaleString()}
            </strong>{' '}
            and{' '}
            <strong className="font-semibold tabular-nums">
                {(edges.at(-1) ?? 0).toLocaleString()}
            </strong>
            .
        </Line>
    )
}
