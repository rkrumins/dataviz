/**
 * The one-line description under a view in a leaderboard.
 *
 * Exists because the same row was being described two different ways on two
 * tabs — Overview printed the raw enum ("reference · enterprise") while Content
 * printed the human label ("Context View · Everyone") — and because the
 * redacted case printed neither usefully.
 *
 * A view the reader may not see comes back with its type and visibility both
 * replaced by the sentinel "restricted", so the row read "Restricted view /
 * Restricted · Restricted": the same word three times, saying nothing anybody
 * can act on. What a reader actually needs to know about such a row is WHY it
 * is anonymous and that its count is still real, so that is what it says.
 */
import { viewTypeLabel, visibilityLabel } from '@/lib/domainLabels'
import type { TopView } from '@/services/analyticsService'

export function viewMeta(v: Pick<TopView, 'viewType' | 'visibility' | 'redacted'>): string {
    if (v.redacted) return 'In a workspace you are not a member of'
    return `${viewTypeLabel(v.viewType)} · ${visibilityLabel(v.visibility)}`
}
