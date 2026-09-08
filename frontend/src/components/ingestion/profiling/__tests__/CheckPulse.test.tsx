/**
 * The pulse has one job: tell "steady" apart from "unwatched".
 *
 * Those two produce the same flat counts series — capture is change-gated, and
 * a failed collection writes nothing — so every assertion here is really about
 * whether a reader can distinguish them.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { CheckEvent, ChecksPayload } from '@/types/profiling'
import { CheckPulse } from '../CheckPulse'

const FROM = '2026-09-07T00:00:00+00:00'
const TO = '2026-09-08T00:00:00+00:00'

function check(over: Partial<CheckEvent> = {}): CheckEvent {
    return {
        id: `chk_${Math.random().toString(16).slice(2)}`,
        checkedAt: '2026-09-07T12:00:00+00:00',
        lane: 'probe', outcome: 'ok', changed: false,
        detail: null, durationMs: null,
        ...over,
    }
}

function payload(over: Partial<ChecksPayload> = {}): ChecksPayload {
    const checks = over.checks ?? []
    return {
        id: 'ds_a', from: FROM, to: TO, window: '24h',
        checks,
        limit: 5000, truncated: false,
        summary: {
            total: checks.length,
            ok: checks.filter((c) => c.outcome === 'ok').length,
            error: checks.filter((c) => c.outcome === 'error').length,
            skipped: checks.filter((c) => c.outcome === 'skipped').length,
            first_at: checks[0]?.checkedAt ?? null,
            last_at: checks.at(-1)?.checkedAt ?? null,
            lanes: {},
            sample_secs: 300,
        },
        ...over,
    }
}

function draw(p: ChecksPayload | undefined, props = {}) {
    return render(
        <CheckPulse payload={p} windowLabel="24 hours" {...props} />,
    )
}

/** The window summary, scoped. The same numbers appear again per lane — the
 *  header is the claim about the period, the rows are the evidence — so an
 *  unscoped query is ambiguous by design rather than by accident. */
function header(container: HTMLElement) {
    const caption = container.querySelector('figcaption')
    if (!caption) throw new Error('no figcaption rendered')
    return within(caption as HTMLElement)
}

describe('CheckPulse', () => {
    it('states the count and the verdict for the window', () => {
        const { container } = draw(payload({
            checks: Array.from({ length: 96 }, (_, i) => check({
                checkedAt: new Date(
                    Date.parse(FROM) + i * 15 * 60_000,
                ).toISOString(),
            })),
        }))
        expect(header(container).getByText('96')).toBeInTheDocument()
        expect(header(container).getByText('all healthy')).toBeInTheDocument()
    })

    it('names failures rather than folding them into a total', () => {
        const { container } = draw(payload({
            checks: [
                check(),
                check({ outcome: 'error', detail: 'connect timeout' }),
            ],
        }))
        expect(header(container).getByText('1 failed')).toBeInTheDocument()
        expect(screen.queryByText('all healthy')).not.toBeInTheDocument()
    })

    it('draws one row per lane, busiest first', () => {
        draw(payload({
            checks: [
                check({ lane: 'poll' }),
                check({ lane: 'probe' }),
                check({ lane: 'probe' }),
                check({ lane: 'reconcile' }),
            ],
        }))
        // Merging the lanes would let the fastest one fill every gap the
        // others leave, which is the failure this card exists to prevent.
        const rows = screen.getAllByRole('img')
        expect(rows).toHaveLength(3)
        expect(rows[0]).toHaveAccessibleName(/Drift probe: 2 checks, all healthy/)
        expect(screen.getByText('Reconciliation')).toBeInTheDocument()
    })

    it('says nothing was RECORDED, not that nothing was checked', () => {
        draw(payload())
        expect(
            screen.getByText(/Nothing recorded in the last 24 hours/),
        ).toBeInTheDocument()
        expect(
            screen.getByText(/statement about the record, not about the source/),
        ).toBeInTheDocument()
    })

    it('explains what a gap means, so the strip does not overstate itself', () => {
        draw(payload({ checks: [check()] }))
        expect(
            screen.getByText(/a short gap is\s+not evidence that nothing ran/),
        ).toBeInTheDocument()
        expect(screen.getByText(/every 5 min/)).toBeInTheDocument()
    })

    it('distinguishes a failed READ from an absence of checks', () => {
        draw(undefined, { isError: true })
        expect(
            screen.getByText(/says nothing about\s+whether the source was checked/),
        ).toBeInTheDocument()
    })

    it('survives an unparseable window without rendering a broken strip', () => {
        draw(payload({ from: 'nonsense', checks: [check()] }))
        expect(screen.queryAllByRole('img')).toHaveLength(0)
    })
})
