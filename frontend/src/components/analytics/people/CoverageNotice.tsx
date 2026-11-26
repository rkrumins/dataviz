/**
 * What the figures on a people page can and cannot see, said in a sentence.
 *
 * Each source starts counting on a day of its own, and a chart that reaches
 * back past that day draws zeros that read as "nobody did anything". These
 * notices say which it is, and only when it applies to the window on screen.
 */
import { DatabaseZap, Info, Loader2 } from 'lucide-react'

import { shortDate } from '@/lib/formatMetric'
import type { PeopleCoverage, PeopleLens, PeopleWindow } from '@/services/peopleActivityService'

export function CoverageNotice({ coverage, window, lens }: {
    coverage: PeopleCoverage
    window: PeopleWindow
    lens: PeopleLens
}) {
    const notes: { key: string; icon: typeof Info; text: React.ReactNode }[] = []
    const { index } = coverage
    const windowStart = window.buckets[0]

    if (!index.freshAt) {
        notes.push({
            key: 'index-off', icon: DatabaseZap,
            text: <>These figures come from the activity index, which the scheduler role keeps. It has not run on this deployment yet, so there is nothing to show.</>,
        })
    } else if (!index.running) {
        notes.push({
            key: 'index-stale', icon: DatabaseZap,
            text: <>Figures were last brought up to date <strong className="font-semibold text-ink">{shortDate(index.freshAt, true)}</strong>: the activity index is not being kept current right now.</>,
        })
    }
    if (index.backfilling && index.completeFrom && windowStart < index.completeFrom) {
        notes.push({
            key: 'index', icon: Loader2,
            text: <>
                Indexing history{index.progress != null && <> — {Math.round(index.progress * 100)}% done</>}.
                {' '}Days before <strong className="font-semibold text-ink">{shortDate(index.completeFrom, true)}</strong> fill in as it goes; everything after is complete.
            </>,
        })
    }
    if (lens === 'full' && coverage.ledgerThrough === null) {
        notes.push({
            key: 'ledger', icon: DatabaseZap,
            text: <>No sign-ins or data operations are shown because the activity ledger is empty on this deployment. View opens, traces, searches and edits are counted as usual.</>,
        })
    }
    if (!notes.length) return null
    return (
        <div className="space-y-1.5">
            {notes.map(({ key, icon: Icon, text }) => (
                <p key={key} className="flex items-start gap-2 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-3.5 py-2 text-xs text-ink-secondary">
                    <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted ${key === 'index' ? 'motion-safe:animate-spin' : ''}`} />
                    <span>{text}</span>
                </p>
            ))}
        </div>
    )
}
