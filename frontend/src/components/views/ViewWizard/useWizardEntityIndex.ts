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
 * paged in yet. Those are batch-resolved via `provider.getNodes({ urns })`, 100
 * per request — a 5,000-entity layer is 50 requests, not 5,000. A URN absent
 * from a SUCCESSFUL answer writes a TOMBSTONE (final) whose identity falls back
 * to a prettified URN fragment with `missing: true`. A FAILED request is not an
 * answer: its URNs stay unresolved and are retried with a capped backoff —
 * tombstoning them turned one network blip into "unknown, 0 children" for the
 * rest of the session, and an anchored column with a zero count offers nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface ProviderScope {
    provider: GraphDataProvider
    /** Per container: where its next page starts and whether there is one — as
     *  the SERVER said (a draft adds and drops rows around each page) — and
     *  whether the last page failed. */
    paging: Map<string, { offset: number; hasMore: boolean; failed: boolean }>
    waiting: Set<string>
    attempts: Map<string, number>
    timers: Set<ReturnType<typeof setTimeout>>
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
    /** What the server said about `urn`'s children: `hasMore` is undefined until
     *  a page has landed; `failed` is true when the last page request failed. */
    childPageState: (urn: string) => { hasMore: boolean | undefined; failed: boolean }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Last-resort display name — the URN fragment the old panel showed. */
export function fallbackNameFromUrn(urn: string): string {
    return urn.split(',').pop()?.replace(')', '') ?? urn
}

const RESOLVE_BATCH = 100
const RESOLVE_CONCURRENCY = 3
/** Retry delays for a lookup that FAILED — never for a confirmed miss. Capped:
 *  a provider that stays down is asked again every 30s while the wizard is open. */
const RESOLVE_RETRY_MS = [1_000, 3_000, 10_000, 30_000]
/** One page of a container's children in the wizard — what a rail "Show N more" fetches. */
export const WIZARD_CHILDREN_PAGE_SIZE = 50
const CHILDREN_PAGE_SIZE = WIZARD_CHILDREN_PAGE_SIZE

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
    /** State that belongs to ONE provider (workspace/data-source scope): each
     *  container's paging, and failed lookups waiting out a backoff. Reset
     *  lazily on first use under a new provider — never during render — so a
     *  switch can't show the previous scope's paging, and its timers stop. */
    const scopeRef = useRef<ProviderScope | null>(null)
    const scoped = useCallback((): ProviderScope => {
        const current = scopeRef.current
        if (current && current.provider === provider) return current
        current?.timers.forEach(clearTimeout)
        const fresh: ProviderScope = {
            provider, paging: new Map(), waiting: new Set(), attempts: new Map(), timers: new Set(),
        }
        scopeRef.current = fresh
        return fresh
    }, [provider])
    const [tick, setTick] = useState(0)
    const [retryTick, setRetryTick] = useState(0)

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

    useEffect(() => () => { scopeRef.current?.timers.forEach(clearTimeout) }, [])

    const snapshotRef = useRef(snapshot)
    snapshotRef.current = snapshot

    // ── Batch-resolve assigned URNs the browser hasn't seen (edit mode) ──
    useEffect(() => {
        const scope = scoped()
        const missing = Object.keys(assignments).filter(urn =>
            !snapshot?.directory.has(urn)
            && !resolvedRef.current.has(urn)
            && !inFlightRef.current.has(urn)
            && !scope.waiting.has(urn))
        if (missing.length === 0) return

        let cancelled = false
        const chunks: string[][] = []
        for (let i = 0; i < missing.length; i += RESOLVE_BATCH) chunks.push(missing.slice(i, i + RESOLVE_BATCH))

        const retryLater = (urns: string[]) => {
            let delay = RESOLVE_RETRY_MS[RESOLVE_RETRY_MS.length - 1]
            for (const urn of urns) {
                const attempt = scope.attempts.get(urn) ?? 0
                scope.attempts.set(urn, attempt + 1)
                delay = Math.min(delay, RESOLVE_RETRY_MS[Math.min(attempt, RESOLVE_RETRY_MS.length - 1)])
                scope.waiting.add(urn)
            }
            const timer = setTimeout(() => {
                scope.timers.delete(timer)
                urns.forEach(u => scope.waiting.delete(u))
                setRetryTick(t => t + 1)
            }, delay)
            scope.timers.add(timer)
        }

        const run = async () => {
            await mapWithConcurrency(chunks, RESOLVE_CONCURRENCY, async chunk => {
                if (cancelled) return
                chunk.forEach(urn => inFlightRef.current.add(urn))
                let answered = false
                try {
                    const nodes = await provider.getNodes({ urns: chunk, limit: chunk.length })
                    const found = new Map(nodes.map(n => [n.urn, n]))
                    for (const urn of chunk) {
                        const node = found.get(urn)
                        // Absent from a SUCCESSFUL answer: the graph does not know
                        // this URN — the one lookup result that is final.
                        resolvedRef.current.set(urn, node
                            ? { name: node.displayName, type: node.entityType, childCount: node.childCount ?? 0 }
                            : null)
                        scope.attempts.delete(urn)
                    }
                    answered = true
                } catch {
                    // Not an answer: leave these unresolved and ask again.
                    retryLater(chunk)
                } finally {
                    chunk.forEach(urn => inFlightRef.current.delete(urn))
                    // Re-render only on an ANSWER. A failure changes nothing on
                    // screen, and re-rendering on it lets a failing provider drive
                    // a render loop (its retry is scheduled, not immediate).
                    // Not gated on `cancelled`: a re-run while this was in flight
                    // skips these URNs as in flight, so if this run stayed silent
                    // the answer would sit in the cache with nothing to show it.
                    if (answered) setTick(t => t + 1)
                }
            })
        }
        void run()
        return () => { cancelled = true }
    }, [assignments, snapshot, provider, retryTick, scoped])

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
     * One page of `urn`'s children, appended to whatever is cached, read at
     * `offset` — where the server said the next page starts — so repeated calls
     * walk the container a page at a time: an anchored column shows a first page
     * and pulls the rest on demand rather than dragging 5000 rows into the wizard.
     */
    const fetchChildPage = useCallback(async (urn: string, offset: number) => {
        if (loadingRef.current.has(urn)) return
        loadingRef.current.add(urn)
        setTick(t => t + 1)
        const paging = scoped().paging
        const prev = paging.get(urn)
        try {
            const result = await provider.getChildrenWithEdges(urn, {
                edgeTypes: containmentEdgeTypes.length > 0 ? containmentEdgeTypes : undefined,
                limit: CHILDREN_PAGE_SIZE,
                // By position — every provider pages by it, whatever the names.
                offset,
                includeLineageEdges: false,
            })
            const next = result.nextOffset ?? offset + result.children.length
            paging.set(urn, {
                offset: next,
                // "More" from a page that did not move the position can make no progress.
                hasMore: result.hasMore && next > offset,
                failed: false,
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
            // ...and SAY so: the rail offers a retry instead of looking finished.
            paging.set(urn, { offset: prev?.offset ?? offset, hasMore: prev?.hasMore ?? true, failed: true })
        } finally {
            loadingRef.current.delete(urn)
            setTick(t => t + 1)
        }
    }, [provider, containmentEdgeTypes, scoped])

    /** First page only — idempotent, so expanding a row twice costs one fetch. */
    const loadChildren = useCallback(async (urn: string) => {
        if (childrenRef.current.has(urn)) return
        await fetchChildPage(urn, 0)
    }, [fetchChildPage])

    /** The next page, for a container the user is still walking through. */
    const loadMoreChildren = useCallback(async (urn: string) => {
        const at = scoped().paging.get(urn)?.offset ?? (childrenRef.current.get(urn) ?? []).length
        await fetchChildPage(urn, at)
    }, [fetchChildPage, scoped])

    const isLoading = useCallback((urn: string) => loadingRef.current.has(urn),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tick])

    const childPageState = useCallback((urn: string) => {
        const state = scoped().paging.get(urn)
        return { hasMore: state?.hasMore, failed: state?.failed ?? false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick, scoped])

    return useMemo(() => ({ resolve, childrenOf, loadChildren, loadMoreChildren, isLoading, childPageState }),
        [resolve, childrenOf, loadChildren, loadMoreChildren, isLoading, childPageState])
}
