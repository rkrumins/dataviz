/**
 * The hero's welcome: who you are, what changed while you were away, and what to
 * do next.
 *
 * The badge used to read "System · Super Admin · 25 business areas" — three facts
 * about the ACCOUNT, none of which the person can act on, and none of which they
 * didn't already know. A landing page's job is to get someone moving: greet them,
 * tell them what's new, and offer the two or three things they're actually here
 * to do.
 *
 * Everything here is derived from data we already load. The "what's new" line is
 * bounded by the feed window we actually fetched, and says so when it hits the
 * cap ("24+") rather than implying we counted everything.
 */
import { Plus, Compass, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewActivityEntry } from '@/services/viewApiService'

/**
 * Time-of-day salutation. Local clock — this is a pleasantry, not a timestamp.
 *
 * Returned WITHOUT the name so the hero can render the name as its own element:
 * the greeting is the headline now, and the person's name is the part that
 * should catch the eye.
 */
export function salutationFor(hour: number): string {
    if (hour < 5) return 'Working late'
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
}

/** Initials for the welcome avatar. "System Admin" → "SA". */
export function initialsOf(first?: string, last?: string): string {
    const f = (first ?? '').trim()
    const l = (last ?? '').trim()
    if (f && l) return (f[0] + l[0]).toUpperCase()
    if (f) return f.slice(0, 2).toUpperCase()
    return '?'
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * "What changed while you were away", computed from the activity window we
 * loaded. `windowSize` is the number of events requested: if the count reaches
 * it, we genuinely don't know the true total, so we say "24+" instead of
 * pretending 24 is the answer.
 */
export function whatsNewLine(
    entries: ViewActivityEntry[],
    windowSize: number,
    now: number = Date.now(),
): string | null {
    if (entries.length === 0) return null

    const since = now - DAY_MS
    const recent = entries.filter(e => {
        const t = new Date(e.createdAt).getTime()
        return !Number.isNaN(t) && t >= since
    })

    if (recent.length === 0) return null

    const views = new Set(recent.map(e => e.viewId)).size
    const capped = recent.length >= windowSize
    const count = `${recent.length}${capped ? '+' : ''}`

    return `${count} update${recent.length === 1 && !capped ? '' : 's'} across ${views} view${views === 1 ? '' : 's'} in the last 24 hours.`
}

// ── CTAs ───────────────────────────────────────────────────────────────────

const PRIMARY = cn(
    'group inline-flex items-center gap-2.5 rounded-2xl px-6 py-3.5 text-[15px] font-bold',
    'bg-gradient-to-r from-accent-lineage to-violet-600 text-white',
    'shadow-xl shadow-accent-lineage/25 hover:shadow-2xl hover:shadow-accent-lineage/30 hover:-translate-y-0.5',
    'transition-all duration-200',
)

const SECONDARY = cn(
    'group inline-flex items-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-semibold',
    'glass-panel border border-glass-border text-ink',
    'hover:border-accent-business/40 hover:-translate-y-0.5 transition-all duration-200',
)

export function HeroActions({ onCreateView, onResume, resumeLabel, onBrowse }: {
    onCreateView: () => void
    /** Only rendered when the user actually has somewhere to resume. */
    onResume?: () => void
    resumeLabel?: string
    onBrowse: () => void
}) {
    return (
        <>
            <button type="button" onClick={onCreateView} className={PRIMARY}>
                <Plus className="w-[18px] h-[18px] transition-transform group-hover:rotate-90 duration-200" />
                Build a new view
            </button>

            {onResume && resumeLabel && (
                <button type="button" onClick={onResume} className={SECONDARY}>
                    <span className="text-ink-muted font-medium">Pick up</span>
                    <span className="max-w-[14rem] truncate">{resumeLabel}</span>
                    <ArrowRight className="w-4 h-4 text-ink-muted transition-transform group-hover:translate-x-0.5" />
                </button>
            )}

            <button type="button" onClick={onBrowse} className={SECONDARY}>
                <Compass className="w-[18px] h-[18px] text-ink-muted" />
                Browse all views
            </button>
        </>
    )
}
