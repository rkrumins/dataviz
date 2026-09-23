/**
 * useWizardEntityIndex — shared entity identity/children resolution for the
 * wizard's assignment surfaces.
 *
 * THE bug this exists to fix: the left "Layers & Groups" panel used to resolve
 * assigned-entity names from `useCanvasStore` — which is EMPTY inside the
 * wizard — so assigned rows rendered as truncated URN fragments and could
 * never expand their children. The correct names live in the entity browser's
 * own cache (`useEntityBrowser`). This hook unifies the two worlds:
 *
 *   resolve(urn)  →  browser snapshot directory  ∪  on-demand getNode() cache
 *   childrenOf / loadChildren  →  provider-backed lazy children (cached)
 *
 * Edit mode: a view's persisted assignments reference URNs the browser hasn't
 * paged in yet. Those are resolved in batches (`provider.getNodes`, a hundred
 * URNs a request, a few requests at a time: an imported view can place tens of
 * thousands). A URN asked for and not returned writes a TOMBSTONE (fetched
 * exactly once) whose identity falls back to a prettified URN fragment with
 * `missing: true`, so the UI can hint "not found in graph" without ever
 * re-fetching. A batch that FAILED proves nothing: its URNs are named from
 * their fragments, never marked missing, and not asked again this session.
 */

import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { mapWithConcurrency } from '@/lib/concurrency'
import type { LayerAssignmentEntry } from '@/types/schema'
import type { BrowserSnapshot } from './WizardAssignmentTree'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EntityIdentity {
    name: string
    type: string
    childCount: number
    /** True when the graph no longer knows this URN (tombstoned lookup). */
    missing?: boolean
}

export interface WizardEntityIndex {
    /** Identity for a URN, or undefined while a lookup is still in flight. */
    resolve: (urn: string) => EntityIdentity | undefined
    /** Loaded child URNs (empty until loadChildren has run). */
    childrenOf: (urn: string) => string[]
    /** Lazy-load one level of children via the provider (cached, one-shot). */
    loadChildren: (urn: string) => Promise<void>
    /** Append the NEXT page of `urn`'s children to what is already cached. */
    loadMoreChildren: (urn: string) => Promise<void>
    isLoading: (urn: string) => boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Last-resort display name — the URN fragment the old panel showed. */
export function fallbackNameFromUrn(urn: string): string {
    return urn.split(',').pop()?.replace(')', '') ?? urn
}

/**
 * Identities the wizard already knows before the index looks anything up. The Import journey
 * provides the entities its reconcile found MISSING here, named as the exporting environment
 * named them: their rows read "orders_v2 — not found here" instead of a URN fragment, and no
 * getNode() is spent confirming what the reconcile already established.
 */
export const WizardEntitySeedContext = createContext<ReadonlyMap<string, EntityIdentity> | null>(null)

const RESOLVE_BATCH = 100
const RESOLVE_CONCURRENCY = 4
const CHILDREN_PAGE_SIZE = 50

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useWizardEntityIndex(opts: {
    provider: GraphDataProvider
    containmentEdgeTypes: string[]
    /** The wizard's canonical assignment buffer — its keys drive batch resolution. */
    assignments: Record<string, LayerAssignmentEntry>
    /** Live directory published by WizardAssignmentTree (null until first publish). */
    snapshot: BrowserSnapshot | null
    /** Identities already known (see WizardEntitySeedContext). */
    seed?: ReadonlyMap<string, EntityIdentity> | null
}): WizardEntityIndex {
    const { provider, containmentEdgeTypes, assignments, snapshot, seed } = opts

    // Caches are refs (no re-render churn per entry); `tick` bumps once per
    // settled batch/children-load so consumers re-render with fresh data.
    const resolvedRef = useRef<Map<string, EntityIdentity | null>>(new Map())
    const childrenRef = useRef<Map<string, string[]>>(new Map())
    const loadingRef = useRef<Set<string>>(new Set())
    const inFlightRef = useRef<Set<string>>(new Set())
    const [tick, setTick] = useState(0)

    // Reset caches when the provider (workspace/data-source scope) changes —
    // same lifecycle rule as useEntityBrowser's reset.
    const providerRef = useRef(provider)
    if (providerRef.current !== provider) {
        providerRef.current = provider
        resolvedRef.current = new Map()
        childrenRef.current = new Map()
        loadingRef.current = new Set()
        inFlightRef.current = new Set()
    }

    const snapshotRef = useRef(snapshot)
    snapshotRef.current = snapshot

    // ── Batch-resolve assigned URNs the browser hasn't seen (edit mode) ──
    useEffect(() => {
        if (seed) {
            for (const [urn, identity] of seed) {
                if (!resolvedRef.current.has(urn)) resolvedRef.current.set(urn, identity)
            }
        }
        const missing = Object.keys(assignments).filter(urn =>
            !snapshot?.directory.has(urn)
            && !resolvedRef.current.has(urn)
            && !inFlightRef.current.has(urn))
        if (missing.length === 0) return

        let cancelled = false
        const batches: string[][] = []
        for (let i = 0; i < missing.length; i += RESOLVE_BATCH) batches.push(missing.slice(i, i + RESOLVE_BATCH))
        void mapWithConcurrency(batches, RESOLVE_CONCURRENCY, async batch => {
            // A newer run owns whatever this one hasn't started.
            if (cancelled) return
            batch.forEach(urn => inFlightRef.current.add(urn))
            try {
                const nodes = await provider.getNodes({ urns: batch, limit: batch.length })
                const found = new Map(nodes.map(n => [n.urn, n]))
                for (const urn of batch) {
                    const node = found.get(urn)
                    // Not returned: not in the graph. Tombstone — resolved once, never re-fetched.
                    resolvedRef.current.set(urn, node
                        ? { name: node.displayName, type: node.entityType, childCount: node.childCount ?? 0 }
                        : null)
                }
            } catch {
                for (const urn of batch) {
                    resolvedRef.current.set(urn, { name: fallbackNameFromUrn(urn), type: 'unknown', childCount: 0 })
                }
            } finally {
                batch.forEach(urn => inFlightRef.current.delete(urn))
            }
            if (!cancelled) setTick(t => t + 1)
        })
        return () => { cancelled = true }
    }, [assignments, snapshot, provider, seed])

    // ── Public surface ──

    const resolve = useCallback((urn: string): EntityIdentity | undefined => {
        const fromSnapshot = snapshotRef.current?.directory.get(urn)
        if (fromSnapshot) return fromSnapshot
        const cached = resolvedRef.current.get(urn)
        if (cached) return cached
        if (cached === null) {
            return { name: fallbackNameFromUrn(urn), type: 'unknown', childCount: 0, missing: true }
        }
        return undefined
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick, snapshot])

    const childrenOf = useCallback((urn: string): string[] => {
        return childrenRef.current.get(urn) ?? []
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick])

    /**
     * One page of `urn`'s children, appended to whatever is cached. `offset` is
     * the cached length, so repeated calls walk the container a page at a time —
     * an anchored column shows a first page and pulls the rest on demand rather
     * than dragging 5000 rows into the wizard.
     */
    const fetchChildPage = useCallback(async (urn: string, offset: number) => {
        if (loadingRef.current.has(urn)) return
        loadingRef.current.add(urn)
        setTick(t => t + 1)
        try {
            const result = await provider.getChildrenWithEdges(urn, {
                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                limit: CHILDREN_PAGE_SIZE,
                offset,
                includeLineageEdges: false,
            })
            const known = childrenRef.current.get(urn) ?? []
            const seen = new Set(known)
            childrenRef.current.set(urn, [
                ...known,
                ...result.children.map(c => c.urn).filter(u => !seen.has(u)),
            ])
            // Children arrive with full identity — seed the cache so their rows
            // render names without another round-trip.
            for (const child of result.children) {
                if (!resolvedRef.current.get(child.urn) && !snapshotRef.current?.directory.has(child.urn)) {
                    resolvedRef.current.set(child.urn, {
                        name: child.displayName,
                        type: child.entityType,
                        childCount: child.childCount ?? 0,
                    })
                }
            }
        } catch (err) {
            // Do NOT cache "no children" here. It reads as a completed empty
            // load, and `loadChildren` short-circuits on `has(urn)` — so one
            // failed first page left the container permanently empty with no
            // retry path for the rest of the session. Record the failure
            // separately and leave the cache untouched.
            // Leaving the key ABSENT is the whole point: `loadChildren`
            // short-circuits on `has(urn)`, so caching [] here made one failed
            // first page permanent for the session.
            console.error(`[useWizardEntityIndex] Failed to load children for ${urn}:`, err)
        } finally {
            loadingRef.current.delete(urn)
            setTick(t => t + 1)
        }
    }, [provider, containmentEdgeTypes])

    /** First page only — idempotent, so expanding a row twice costs one fetch. */
    const loadChildren = useCallback(async (urn: string) => {
        if (childrenRef.current.has(urn)) return
        await fetchChildPage(urn, 0)
    }, [fetchChildPage])

    /** The next page, for a container the user is still walking through. */
    const loadMoreChildren = useCallback(async (urn: string) => {
        await fetchChildPage(urn, (childrenRef.current.get(urn) ?? []).length)
    }, [fetchChildPage])

    const isLoading = useCallback((urn: string) => loadingRef.current.has(urn),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tick])

    return useMemo(() => ({ resolve, childrenOf, loadChildren, loadMoreChildren, isLoading }),
        [resolve, childrenOf, loadChildren, loadMoreChildren, isLoading])
}
