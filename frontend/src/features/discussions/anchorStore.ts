/**
 * Questions per node, for the view open on the canvas: what each row's question mark counts.
 *
 * Written from the view's ETag'd summary (`useViewQuestionAnchors`), read row by row through
 * `useAnchorCount`: each row subscribes to its own entry, so a new question re-renders the rows
 * it is about and no others — and a view with no questions costs each row one map lookup.
 */
import { create } from 'zustand'

export interface AnchorCount {
    open: number
    total: number
}

interface AnchorState {
    /** The view these counts are for. */
    viewId: string | null
    byEntity: Readonly<Record<string, AnchorCount>>
    set: (viewId: string, byEntity: Readonly<Record<string, AnchorCount>>) => void
    /** Forget the counts of `viewId` (it is no longer on screen). */
    clear: (viewId: string) => void
}

const EMPTY: Readonly<Record<string, AnchorCount>> = Object.freeze({})

export const useAnchorStore = create<AnchorState>((set, get) => ({
    viewId: null,
    byEntity: EMPTY,
    set: (viewId, byEntity) => set({ viewId, byEntity }),
    clear: (viewId) => { if (get().viewId === viewId) set({ viewId: null, byEntity: EMPTY }) },
}))

/** The questions about `urn` on the open view, or null when there are none. */
export function useAnchorCount(urn: string | null | undefined): AnchorCount | null {
    return useAnchorStore((s) => (urn ? s.byEntity[urn] ?? null : null))
}
