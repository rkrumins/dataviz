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
 * paged in yet. Those are batch-resolved via `provider.getNode(urn)` at small
 * concurrency; a null/failed lookup writes a TOMBSTONE (fetched exactly once)
 * whose identity falls back to a prettified URN fragment with `missing: true`
 * so the UI can hint "not found in graph" without ever re-fetching.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
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
    isLoading: (urn: string) => boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Last-resort display name — the URN fragment the old panel showed. */
export function fallbackNameFromUrn(urn: string): string {
    return urn.split(',').pop()?.replace(')', '') ?? urn
}

const RESOLVE_CONCURRENCY = 5
const CHILDREN_PAGE_SIZE = 50

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useWizardEntityIndex(opts: {
    provider: GraphDataProvider
    containmentEdgeTypes: string[]
    /** The wizard's canonical assignment buffer — its keys drive batch resolution. */
    assignments: Record<string, LayerAssignmentEntry>
    /** Live directory published by WizardAssignmentTree (null until first publish). */
    snapshot: BrowserSnapshot | null
}): WizardEntityIndex {
    const { provider, containmentEdgeTypes, assignments, snapshot } = opts

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
        const missing = Object.keys(assignments).filter(urn =>
            !snapshot?.directory.has(urn)
            && !resolvedRef.current.has(urn)
            && !inFlightRef.current.has(urn))
        if (missing.length === 0) return

        let cancelled = false
        const run = async () => {
            for (let i = 0; i < missing.length; i += RESOLVE_CONCURRENCY) {
                if (cancelled) return
                const chunk = missing.slice(i, i + RESOLVE_CONCURRENCY)
                chunk.forEach(urn => inFlightRef.current.add(urn))
                await Promise.all(chunk.map(async urn => {
                    try {
                        const node = await provider.getNode(urn)
                        resolvedRef.current.set(urn, node
                            ? { name: node.displayName, type: node.entityType, childCount: node.childCount ?? 0 }
                            : null)
                    } catch {
                        // Tombstone — resolved once, never re-fetched.
                        resolvedRef.current.set(urn, null)
                    } finally {
                        inFlightRef.current.delete(urn)
                    }
                }))
                if (!cancelled) setTick(t => t + 1)
            }
        }
        void run()
        return () => { cancelled = true }
    }, [assignments, snapshot, provider])

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

    const loadChildren = useCallback(async (urn: string) => {
        if (childrenRef.current.has(urn) || loadingRef.current.has(urn)) return
        loadingRef.current.add(urn)
        setTick(t => t + 1)
        try {
            const result = await provider.getChildrenWithEdges(urn, {
                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                limit: CHILDREN_PAGE_SIZE,
                offset: 0,
                includeLineageEdges: false,
            })
            childrenRef.current.set(urn, result.children.map(c => c.urn))
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
            console.error(`[useWizardEntityIndex] Failed to load children for ${urn}:`, err)
            childrenRef.current.set(urn, [])
        } finally {
            loadingRef.current.delete(urn)
            setTick(t => t + 1)
        }
    }, [provider, containmentEdgeTypes])

    const isLoading = useCallback((urn: string) => loadingRef.current.has(urn),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tick])

    return useMemo(() => ({ resolve, childrenOf, loadChildren, isLoading }),
        [resolve, childrenOf, loadChildren, isLoading])
}
