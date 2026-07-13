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
import type { MostViewedEntry, MyDraftEntry, RecentViewEntry, View } from '@/services/viewApiService'

export type WorkBadge = 'draft' | 'pinned' | 'recent' | 'popular'

/**
 * The badges that make something YOUR work. "Popular" deliberately isn't one:
 * a view the team opens constantly and you have never touched is a
 * recommendation, not something you left unfinished. It shows under its own
 * filter, and only joins the default list when you also have a reason to care.
 */
const PERSONAL: WorkBadge[] = ['draft', 'pinned', 'recent']

export const isPersonal = (item: WorkItem): boolean =>
    item.badges.some(b => PERSONAL.includes(b))

export interface WorkItem {
    viewId: string
    name: string
    viewType?: string
    /** The user's chosen icon (config.icon), when they set one. */
    icon?: string
    /** WHICH view this is. Names are not unique — this dev instance has two views
     *  called "Data Lineage" and two called "Domain Overview" — so the card must
     *  carry the workspace, or two cards are indistinguishable. Every source gives
     *  us the id; the name is resolved against the workspaces store. */
    workspaceId?: string
    workspaceName?: string
    badges: WorkBadge[]
    /** Present iff this view has an open draft — the card deep-links into it. */
    draftId?: string
    /** The draft's own name, when the user gave it one. Most are unnamed, and
     *  printing "Unnamed draft" on four cards told the reader nothing. */
    draftName?: string
    /** How many DISTINCT people have opened it (present iff `popular`). */
    viewers?: number
    /** How many times it has been opened in total (present iff `popular`). */
    opens?: number
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
    popular: MostViewedEntry[] = [],
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
            workspaceId: d.workspaceId,
            timestamp: d.updatedAt,
            timeVerb: 'Edited',
        })
        item.badges.push('draft')
        item.draftId = d.draftId
        item.draftName = d.name
    }

    for (const p of pinned) {
        const item = touch(p.id, {
            name: p.name,
            viewType: p.viewType,
            icon: p.config?.icon ?? undefined,
            workspaceId: p.workspaceId,
            workspaceName: p.workspaceName ?? undefined,
            timestamp: p.dataUpdatedAt ?? p.updatedAt,
            timeVerb: 'Updated',
        })
        item.badges.push('pinned')
        // A pinned view we already know as a draft keeps the draft's timestamp:
        // the edit is the live fact, the pin is just a preference. But fill in any
        // detail the draft source didn't have.
        if (!item.icon) item.icon = p.config?.icon ?? undefined
        if (!item.workspaceName) item.workspaceName = p.workspaceName ?? undefined
        if (!item.workspaceId) item.workspaceId = p.workspaceId
    }

    for (const r of recents) {
        const item = touch(r.viewId, {
            name: r.viewName,
            viewType: r.viewType,
            icon: r.icon,
            workspaceId: r.workspaceId,
            workspaceName: r.workspaceName,
            timestamp: r.visitedAt,
            timeVerb: 'Opened',
        })
        item.badges.push('recent')
        if (!item.icon) item.icon = r.icon
        if (!item.workspaceName) item.workspaceName = r.workspaceName
        if (!item.workspaceId) item.workspaceId = r.workspaceId
    }

    // Popularity is a property of a view, not a reason it's yours — so it can
    // decorate an item you already have, or stand alone under its own filter.
    for (const v of popular) {
        const item = touch(v.viewId, {
            name: v.name,
            viewType: v.viewType,
            icon: v.icon,
            workspaceId: v.workspaceId,
            timestamp: v.lastOpenedAt ?? '',
            timeVerb: 'Opened',
        })
        item.badges.push('popular')
        item.viewers = v.viewers
        item.opens = v.opens
        if (!item.icon) item.icon = v.icon
        if (!item.workspaceId) item.workspaceId = v.workspaceId
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

export type WorkFilter = 'all' | 'draft' | 'pinned' | 'recent' | 'popular'

export function filterWorkItems(items: WorkItem[], filter: WorkFilter): WorkItem[] {
    // "All" means all of YOUR work. A view you've never opened doesn't belong in
    // it just because other people like it.
    if (filter === 'all') return items.filter(isPersonal)

    const matching = items.filter(i => i.badges.includes(filter))

    // Popularity has its own order: the busiest first, not the most recent.
    if (filter === 'popular') {
        return [...matching].sort((a, b) =>
            (b.viewers ?? 0) - (a.viewers ?? 0) || (b.opens ?? 0) - (a.opens ?? 0))
    }
    return matching
}

export function countBadge(items: WorkItem[], badge: WorkBadge): number {
    return items.reduce((n, i) => n + (i.badges.includes(badge) ? 1 : 0), 0)
}
