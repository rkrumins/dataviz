/**
 * The activity summary — pure, so it can be tested without booting the app.
 *
 * "Busiest views" listed "Impact Analysis" and "Data Lineage" TWICE each. Those
 * are different views that happen to share a name (honest data), but two rows
 * with the same label and different counts read as a counting bug.
 *
 * The rule below: suffix a row with its workspace ONLY when another row in the
 * list shares its name. Suffixing every row would be noise; suffixing none leaves
 * indistinguishable twins.
 */
import type { ViewActivityEntry } from '@/services/viewApiService'

/** The data channel. Everything else is a person changing something. */
const DATA_ACTIONS = new Set(['data_changed'])

export const isDataEvent = (e: ViewActivityEntry) => DATA_ACTIONS.has(e.action)

export type Channel = 'all' | 'people' | 'data'

export interface BusiestView {
    viewId: string
    viewName: string
    /** Only set when it's needed to tell two same-named views apart. */
    workspaceName?: string
    count: number
}

export interface Summary {
    total: number
    dataUpdates: number
    peopleChanges: number
    /** Views touched most in this window, busiest first. */
    busiest: BusiestView[]
    /** Oldest event loaded — bounds what the summary can honestly claim. */
    oldestAt: string | null
}

/**
 * `workspaceNameFor` resolves an id against the workspaces the client already
 * holds. It is applied ONLY where a name is ambiguous: labelling every row with
 * its workspace would be noise, but leaving two rows both reading "Data Lineage"
 * is worse — it looks like a bug in the counting.
 */
export function summarise(
    entries: ViewActivityEntry[],
    workspaceNameFor: (id?: string | null) => string | undefined,
): Summary {
    const byView = new Map<string, BusiestView & { workspaceId?: string | null }>()
    let dataUpdates = 0
    let peopleChanges = 0

    for (const e of entries) {
        if (isDataEvent(e)) dataUpdates += 1
        else peopleChanges += 1

        if (!e.viewName) continue
        const seen = byView.get(e.viewId)
        if (seen) seen.count += 1
        else byView.set(e.viewId, {
            viewId: e.viewId,
            viewName: e.viewName,
            workspaceId: e.workspaceId,
            count: 1,
        })
    }

    const views = [...byView.values()]

    // Which names collide? Only those get a workspace suffix.
    const nameCounts = new Map<string, number>()
    for (const v of views) nameCounts.set(v.viewName, (nameCounts.get(v.viewName) ?? 0) + 1)

    const busiest = views
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map(v => ({
            viewId: v.viewId,
            viewName: v.viewName,
            count: v.count,
            workspaceName: (nameCounts.get(v.viewName) ?? 0) > 1
                ? workspaceNameFor(v.workspaceId)
                : undefined,
        }))

    return {
        total: entries.length,
        dataUpdates,
        peopleChanges,
        busiest,
        // Entries arrive newest-first.
        oldestAt: entries.length > 0 ? entries[entries.length - 1].createdAt : null,
    }
}
