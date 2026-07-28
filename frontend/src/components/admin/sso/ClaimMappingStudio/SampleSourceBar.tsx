/**
 * Where the sample came from — because it changes what the preview proves.
 *
 * The old editor offered three equal-weight buttons: "Load last assertion",
 * "Read from my browser", "Preview". Nothing on screen afterwards said which
 * one had been pressed, so a vendor's worked example and a real captured
 * assertion looked identical — and a mapping validated against the example
 * can be confidently wrong about the IdP in front of you.
 *
 * So the current source is stated, ranked, and the strongest available one
 * is offered as the next step.
 */
import { Beaker, Check, Globe, Loader2, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SampleSource = 'example' | 'browser' | 'assertion' | 'pasted'

const RANK: Record<SampleSource, {
    label: string
    icon: typeof Radio
    tone: string
    weight: number
}> = {
    // Ordered by how much a passing preview against it is worth.
    assertion: {
        label: 'Real assertion', icon: Radio, weight: 3,
        tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    },
    browser: {
        label: 'From your browser', icon: Globe, weight: 2,
        tone: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
    },
    pasted: {
        label: 'Pasted by you', icon: Check, weight: 1,
        tone: 'bg-black/[0.06] dark:bg-white/[0.08] text-ink-muted',
    },
    example: {
        label: 'Example payload', icon: Beaker, weight: 0,
        tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
}

export function SampleSourceBar({
    source, capturedAt, canLoadAssertion, canReadBrowser,
    onLoadAssertion, onReadBrowser, loading, note,
}: {
    source: SampleSource
    /** ISO timestamp of a captured assertion, when that is the source. */
    capturedAt?: string | null
    canLoadAssertion?: boolean
    canReadBrowser?: boolean
    onLoadAssertion?: () => void
    onReadBrowser?: () => void
    loading?: boolean
    /** A failed load — "no assertion captured yet", "nothing at that key". */
    note?: string | null
}) {
    const meta = RANK[source]
    const Icon = meta.icon
    // Only suggest an upgrade. Offering "load the example" next to a real
    // assertion would invite trading evidence for a placeholder.
    const offerAssertion = canLoadAssertion && RANK.assertion.weight > meta.weight
    const offerBrowser = canReadBrowser && RANK.browser.weight > meta.weight

    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
                'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium',
                meta.tone,
            )}>
                {loading
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Icon className="w-3 h-3" />}
                {meta.label}
                {source === 'assertion' && capturedAt && (
                    <span className="opacity-70 font-normal">· {ago(capturedAt)}</span>
                )}
            </span>

            {source === 'example' && (
                <span className="text-[10px] text-ink-muted">
                    Not from your IdP — a mapping that works here can still be
                    wrong about yours.
                </span>
            )}

            <span className="flex-1" />

            {offerAssertion && (
                <button
                    type="button"
                    onClick={onLoadAssertion}
                    title="The claims this provider actually sent on its last successful sign-in"
                    className="px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                    Use last real assertion
                </button>
            )}
            {offerBrowser && (
                <button
                    type="button"
                    onClick={onReadBrowser}
                    className="px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                    Read from my browser
                </button>
            )}

            {note && (
                <p className="w-full text-[11px] text-amber-600 dark:text-amber-400">
                    {note}
                </p>
            )}
        </div>
    )
}

function ago(iso: string): string {
    const then = Date.parse(iso)
    if (Number.isNaN(then)) return 'captured'
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
}
