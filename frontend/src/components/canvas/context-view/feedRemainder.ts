/**
 * How much of an open column's type feeds is still on the server: the part of
 * a layer's header total the column cannot see (LayerColumn's header totals).
 *
 * Each open type's server total (counted with its first page) less every
 * loaded entity of that type, wherever it is drawn. null when a feed that
 * still has more has no total (an older server, a draft with changes, a count
 * over its budget). Types fold case-insensitively, as feeds are matched to
 * layers.
 *
 * Extracted so the rule can be read and tested without mounting the canvas.
 */
import type { TypeFeedState } from '@/store/canvas'

export function feedRemainder(
    types: string[],
    typeFeeds: Record<string, TypeFeedState>,
    loadedByType: ReadonlyMap<string, number>,
): number | null {
    const open = types.filter(t => typeFeeds[t]?.hasMore)
    if (open.some(t => typeFeeds[t].total == null)) return null
    return open.reduce((acc, t) =>
        acc + Math.max(0, (typeFeeds[t].total ?? 0) - (loadedByType.get(t.toLowerCase()) ?? 0)), 0)
}
