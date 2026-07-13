/**
 * The dashboard used to render three sections — unfinished drafts, pinned views,
 * recently visited — that all answer the SAME question: "which view do I open?"
 * They also overlapped heavily: one view could appear as a draft, as a pin, and
 * as a recent, so ~8 distinct views were drawn ~15 times down the page, pushing
 * the activity feed (the only section answering a DIFFERENT question) off screen.
 *
 * This merges them into one list, keyed by view. A view appears ONCE and carries
 * every badge that applies to it, so nothing is lost: a draft that is also pinned
 * says so on a single card, and the filters still narrow to each subset.
 */
import type { MyDraftEntry, RecentViewEntry, View } from '@/services/viewApiService'

export type WorkBadge = 'draft' | 'pinned' | 'recent'

export interface WorkItem {
    viewId: string
    name: string
    viewType?: string
    /** The user's chosen icon (config.icon), when they set one. */
    icon?: string
    subtitle?: string
    badges: WorkBadge[]
    /** Present iff this view has an open draft — the card deep-links into it. */
    draftId?: string
    /** Sort key: the most recent thing that happened to this item, for the user. */
    timestamp: string
    /** What that timestamp MEANS. A draft's "edited" and a visit's "opened" are
     *  different facts, and a card that says "Edited 5d ago" when it means "you
     *  looked at it 5d ago" is a lie, however small. */
    timeVerb: 'Edited' | 'Opened' | 'Updated'
}

const DAY_MS = 24 * 60 * 60 * 1000
export const STALE_AFTER_DAYS = 7

export function isStale(updatedAt: string, now: number = Date.now()): boolean {
    const t = new Date(updatedAt).getTime()
    if (Number.isNaN(t)) return false
    return now - t > STALE_AFTER_DAYS * DAY_MS
}

/** A draft is stale only if it IS a draft — a pin you haven't touched is fine. */
export function isStaleDraft(item: WorkItem, now: number = Date.now()): boolean {
    return item.badges.includes('draft') && isStale(item.timestamp, now)
}

function time(iso: string | undefined): number {
    if (!iso) return 0
    const t = new Date(iso).getTime()
    return Number.isNaN(t) ? 0 : t
}

/**
 * Merge the three sources into one deduplicated, ordered list.
 *
 * Order: anything with unfinished work comes first (a half-written draft outranks
 * a page you happened to look at), then by recency within each group.
 */
export function mergeWorkItems(
    drafts: MyDraftEntry[],
    pinned: View[],
    recents: RecentViewEntry[],
): WorkItem[] {
    const byView = new Map<string, WorkItem>()

    const touch = (viewId: string, seed: Omit<WorkItem, 'badges' | 'viewId'>): WorkItem => {
        const existing = byView.get(viewId)
        if (existing) return existing
        const created: WorkItem = { viewId, badges: [], ...seed }
        byView.set(viewId, created)
        return created
    }

    // Drafts first: they own the card's timestamp, because "you were editing this"
    // is the most actionable fact we have about a view.
    for (const d of drafts) {
        const item = touch(d.viewId, {
            name: d.viewName,
            viewType: d.viewType,
            subtitle: d.name ?? 'Unnamed draft',
            timestamp: d.updatedAt,
            timeVerb: 'Edited',
        })
        item.badges.push('draft')
        item.draftId = d.draftId
    }

    for (const p of pinned) {
        const item = touch(p.id, {
            name: p.name,
            viewType: p.viewType,
            icon: p.config?.icon ?? undefined,
            subtitle: p.workspaceName ?? undefined,
            timestamp: p.dataUpdatedAt ?? p.updatedAt,
            timeVerb: 'Updated',
        })
        item.badges.push('pinned')
        // A pinned view we already know as a draft keeps the draft's timestamp:
        // the edit is the live fact, the pin is just a preference.
        if (!item.icon) item.icon = p.config?.icon ?? undefined
        if (!item.subtitle) item.subtitle = p.workspaceName ?? undefined
    }

    for (const r of recents) {
        const item = touch(r.viewId, {
            name: r.viewName,
            viewType: r.viewType,
            icon: r.icon,
            subtitle: r.workspaceName ?? undefined,
            timestamp: r.visitedAt,
            timeVerb: 'Opened',
        })
        item.badges.push('recent')
        if (!item.icon) item.icon = r.icon
        if (!item.subtitle) item.subtitle = r.workspaceName ?? undefined
    }

    const items = [...byView.values()]

    items.sort((a, b) => {
        const aDraft = a.badges.includes('draft') ? 1 : 0
        const bDraft = b.badges.includes('draft') ? 1 : 0
        if (aDraft !== bDraft) return bDraft - aDraft
        return time(b.timestamp) - time(a.timestamp)
    })

    return items
}

export type WorkFilter = 'all' | 'draft' | 'pinned' | 'recent'

export function filterWorkItems(items: WorkItem[], filter: WorkFilter): WorkItem[] {
    if (filter === 'all') return items
    return items.filter(i => i.badges.includes(filter))
}

export function countBadge(items: WorkItem[], badge: WorkBadge): number {
    return items.reduce((n, i) => n + (i.badges.includes(badge) ? 1 : 0), 0)
}
