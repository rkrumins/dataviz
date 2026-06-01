import type { ContextModel } from '@/services/contextModelService'

/**
 * Picks the featured template by:
 *   1. is_pinned wins
 *   2. highest instantiation_count
 *   3. most-recent updatedAt fallback
 * Returns null if the list has fewer than 2 templates (no point featuring a solo card).
 */
export function pickFeaturedTemplate(templates: readonly ContextModel[]): ContextModel | null {
    if (templates.length < 2) return null
    let best: ContextModel | null = null
    for (const t of templates) {
        if (!best) { best = t; continue }
        if (t.isPinned !== best.isPinned) {
            if (t.isPinned) best = t
            continue
        }
        if (t.instantiationCount !== best.instantiationCount) {
            if (t.instantiationCount > best.instantiationCount) best = t
            continue
        }
        if (Date.parse(t.updatedAt) > Date.parse(best.updatedAt)) best = t
    }
    return best
}
