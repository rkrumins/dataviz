/**
 * viewLibraryStore — the open view's library as the server holds it: its
 * display rules (the published ones, or the open draft's own), its saved
 * queries, and whether the caller may change them.
 *
 * The rules themselves live in ``referenceModelStore.displayRules``, where
 * the canvas's rule engine and chips read them. This store loads them
 * there, and every change goes to the server one rule at a time: it shows
 * at once, and the server's answer — the view's rules as they now stand,
 * other people's edits included — replaces it. Writes are sent one after
 * another, so the last answer holds every change. A write the server
 * refuses is undone by reading the library again, and its reason is thrown
 * for the caller to show.
 */
import { create } from 'zustand'

import { generateId } from '@/lib/utils'
import {
    deleteViewQuery, deleteViewRule, getViewLibrary, orderViewRules, putViewQuery, putViewRule,
    type SavedViewQuery, type SavedViewQueryInput, type ViewLibrary,
} from '@/services/viewLibraryService'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'


export type ViewLibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ViewLibraryState {
    /** The view — and the draft branch open on it, if any — loaded. */
    viewId: string | null
    branchId: string | null
    status: ViewLibraryStatus
    /** Why the library couldn't be read. */
    error: string | null
    /** Whether the caller may change the library (the server's own check). */
    canEdit: boolean
    savedQueries: SavedViewQuery[]

    /** Read the library of ``viewId`` on ``branchId``. A different view
     *  starts empty, so one view's rules never show on another. */
    load: (viewId: string | null, branchId: string | null) => Promise<void>
    /** Read the loaded view's library again. */
    reload: () => Promise<void>
    /** Take a library the server answered with (an import's, say). */
    adopt: (library: ViewLibrary) => void
    /** Add a rule, or replace the one with its id where it stands. */
    saveRule: (rule: DisplayRuleConfig) => Promise<void>
    removeRule: (id: string) => Promise<void>
    toggleRule: (id: string) => Promise<void>
    /** Put the rules in the order ``ids`` names them. */
    reorderRules: (ids: string[]) => Promise<void>
    /** Save a query in the view's library — under a new id unless it has one. */
    saveQuery: (query: SavedViewQueryInput & { id?: string }) => Promise<SavedViewQuery>
    removeQuery: (id: string) => Promise<void>
}


const READ_ONLY = "You can't change this view's library — ask someone who can edit the view."

const currentRules = () => useReferenceModelStore.getState().displayRules
const showRules = (rules: DisplayRuleConfig[]) => useReferenceModelStore.getState().setDisplayRules(rules)

// The latest read, and the latest rule write: an answer to anything older
// is not shown.
let loadSeq = 0
let writeSeq = 0
// Writes go to the server one at a time, in the order they were made.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}


export const useViewLibraryStore = create<ViewLibraryState>()((set, get) => {
    const isLoaded = (viewId: string, branchId: string | null) =>
        get().viewId === viewId && get().branchId === branchId

    /** Show ``next`` now, send the change, show the server's answer. */
    async function writeRules(
        next: DisplayRuleConfig[],
        send: (viewId: string, branchId: string | null) => Promise<DisplayRuleConfig[]>,
    ): Promise<void> {
        const { viewId, branchId, canEdit } = get()
        if (!viewId || !canEdit) throw new Error(READ_ONLY)
        const seq = ++writeSeq
        showRules(next)
        try {
            const answer = await enqueue(() => send(viewId, branchId))
            if (seq === writeSeq && isLoaded(viewId, branchId)) showRules(answer)
        } catch (err) {
            if (isLoaded(viewId, branchId)) void enqueue(() => get().reload())
            throw err
        }
    }

    return {
        viewId: null,
        branchId: null,
        status: 'idle',
        error: null,
        canEdit: false,
        savedQueries: [],

        load: async (viewId, branchId) => {
            const seq = ++loadSeq
            if (!(get().viewId === viewId && get().branchId === branchId)) {
                if (get().viewId !== viewId) showRules([])
                set({
                    viewId, branchId, status: viewId ? 'loading' : 'idle', error: null,
                    ...(get().viewId !== viewId ? { canEdit: false, savedQueries: [] } : {}),
                })
            }
            if (!viewId) return
            try {
                const library = await getViewLibrary(viewId, branchId)
                if (seq === loadSeq) get().adopt(library)
            } catch (err) {
                if (seq === loadSeq) set({ status: 'error', error: message(err) })
            }
        },

        reload: () => {
            const { viewId, branchId } = get()
            return get().load(viewId, branchId)
        },

        adopt: (library) => {
            if (library.viewId !== get().viewId) return
            showRules(library.displayRules ?? [])
            set({
                status: 'ready', error: null, canEdit: library.canEdit,
                savedQueries: library.savedQueries ?? [],
            })
        },

        saveRule: (rule) => {
            const rules = currentRules()
            const next = rules.some((r) => r.id === rule.id)
                ? rules.map((r) => (r.id === rule.id ? rule : r))
                : [...rules, rule]
            return writeRules(next, (viewId, branchId) => putViewRule(viewId, rule, branchId))
        },

        removeRule: (id) => writeRules(
            currentRules().filter((r) => r.id !== id),
            (viewId, branchId) => deleteViewRule(viewId, id, branchId),
        ),

        toggleRule: (id) => {
            const rule = currentRules().find((r) => r.id === id)
            if (!rule) return Promise.resolve()
            return get().saveRule({ ...rule, enabled: !rule.enabled })
        },

        reorderRules: (ids) => {
            const rank = new Map(ids.map((id, i) => [id, i]))
            const next = [...currentRules()].sort(
                (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
            )
            return writeRules(next, (viewId, branchId) => orderViewRules(viewId, ids, branchId))
        },

        saveQuery: async ({ id, ...body }) => {
            const { viewId, canEdit } = get()
            if (!viewId || !canEdit) throw new Error(READ_ONLY)
            const saved = await putViewQuery(viewId, id ?? generateId('query'), body)
            if (get().viewId === viewId) {
                set((s) => ({
                    savedQueries: s.savedQueries.some((q) => q.id === saved.id)
                        ? s.savedQueries.map((q) => (q.id === saved.id ? saved : q))
                        : [...s.savedQueries, saved],
                }))
            }
            return saved
        },

        removeQuery: async (id) => {
            const { viewId, canEdit } = get()
            if (!viewId || !canEdit) throw new Error(READ_ONLY)
            set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.id !== id) }))
            try {
                await deleteViewQuery(viewId, id)
            } catch (err) {
                if (get().viewId === viewId) void get().reload()
                throw err
            }
        },
    }
})


export const useLibraryCanEdit = () => useViewLibraryStore((s) => s.canEdit)
export const useSavedViewQueries = () => useViewLibraryStore((s) => s.savedQueries)
