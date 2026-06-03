/**
 * propertyDraftStore — in-session (non-persisted) staging for property
 * lifecycle operations authored in the Property Manager's Properties tab.
 *
 * There is no backend node-property write yet (provider ``update_node``
 * is unimplemented; EntityDrawer's apply hook is a TODO no-op), so bulk
 * create / update / remove operations are recorded here, surfaced
 * optimistically over the discovered catalogue, and reviewed by the user —
 * but NOT written to the graph. The ``PropertyOp`` shape is deliberately
 * close to a future bulk-update request so wiring real persistence later
 * is a drop-in (replace the no-op "apply" with a batch call).
 *
 * Mirrors the lightweight style of ``displayRuleMatchStore`` — a plain
 * zustand store with small selector hooks.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import type { Predicate } from '@/types/search'


export type PropertyOpKind = 'set' | 'fillEmpty' | 'rename' | 'remove'
export type PropertyValueType = 'string' | 'number' | 'boolean'


export interface PropertyOp {
    id: string
    kind: PropertyOpKind
    /** The property key the op targets. */
    key: string
    /** New key name — ``rename`` only. */
    newKey?: string
    /** Value to write — ``set`` / ``fillEmpty`` only. */
    value?: string | number | boolean
    valueType?: PropertyValueType
    /** The criteria selecting which entities the op applies to. */
    predicate: Predicate
    /** Matched-entity count captured at author time (for the review list). */
    targetCount: number
    createdAt: string
}


interface PropertyDraftState {
    pendingOps: PropertyOp[]
    addOp: (op: PropertyOp) => void
    removeOp: (id: string) => void
    clearOps: () => void
}


const EMPTY_OPS: PropertyOp[] = []


export const usePropertyDraftStore = create<PropertyDraftState>((set) => ({
    pendingOps: EMPTY_OPS,
    addOp: (op) => set((s) => ({ pendingOps: [...s.pendingOps, op] })),
    removeOp: (id) => set((s) => ({ pendingOps: s.pendingOps.filter((o) => o.id !== id) })),
    clearOps: () => set({ pendingOps: EMPTY_OPS }),
}))


/** All staged property operations, newest last. */
export function usePropertyOps(): PropertyOp[] {
    return usePropertyDraftStore((s) => s.pendingOps)
}


/** Per-key overlay status derived from the staged ops. */
export interface CatalogOverlayEntry {
    kinds: Set<PropertyOpKind>
    /** Target key for a rename (the new name). */
    renameTo?: string
    /** How many ops touch this key. */
    count: number
}


/**
 * Build a ``key → overlay`` map from the staged ops so the catalogue can
 * annotate rows (pending update / remove / rename) and surface staged-new
 * keys the discovery endpoint hasn't seen yet. The consuming component
 * decides "pending-new" by checking which overlay keys are absent from
 * the discovered ``allKeys``.
 */
export function usePropertyCatalogOverlay(): ReadonlyMap<string, CatalogOverlayEntry> {
    const pendingOps = usePropertyDraftStore((s) => s.pendingOps)
    return useMemo(() => {
        const map = new Map<string, CatalogOverlayEntry>()
        for (const op of pendingOps) {
            const entry = map.get(op.key) ?? { kinds: new Set<PropertyOpKind>(), count: 0 }
            entry.kinds.add(op.kind)
            entry.count += 1
            if (op.kind === 'rename' && op.newKey) entry.renameTo = op.newKey
            map.set(op.key, entry)
        }
        return map
    }, [pendingOps])
}
