/**
 * useAggregatedLineage - Progressive edge disclosure hook
 * 
 * Manages aggregated lineage edges that show summarized connections
 * between containers (e.g., datasets, systems). Supports expanding
 * aggregated edges to reveal detailed connections on demand.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { create } from 'zustand'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { mapWithConcurrency } from '@/lib/concurrency'
import { lookupRetryDelayMs } from '@/config/polling'
import { CIRCUIT_RESET_MS } from '@/services/circuitBreaker'
import { classifyGraphFailure } from '@/services/graphRequestFailure'
import { fnv1a64 } from './lib/lineageCache'
import type {
    AggregatedEdgeInfo,
    AggregatedEdgeResult,
    GraphDataProvider,
    GraphEdge, AggregatedDegradedDetail } from '@/providers/GraphDataProvider'

// ============================================
// Types
// ============================================

export type ExpansionState = 'collapsed' | 'expanded' | 'loading'

export interface AggregatedEdgeState {
    /** The aggregated edge info from backend */
    aggregated: AggregatedEdgeInfo
    /** Current expansion state */
    state: ExpansionState
    /** Detailed edges (populated when expanded) */
    detailedEdges: GraphEdge[]
    /** Total underlying edges (the aggregated edgeCount) — the denominator
     *  for "showing X of Y" when detail is truncated. */
    detailTotal?: number
    /** True when more underlying edges exist than are loaded. */
    detailTruncated?: boolean
}

export interface UseAggregatedLineageOptions {
    /**
     * Entity type ID to aggregate lineage to (e.g. "dataset", "term").
     * null = no aggregation, show all fine-grained edges.
     */
    granularity?: string | null
    /** Whether to automatically fetch aggregated edges */
    autoFetch?: boolean
    /** Cache TTL in milliseconds (default: 5 minutes) */
    cacheTtl?: number
}

export interface UseAggregatedLineageResult {
    /** Map of aggregated edge ID to its state */
    aggregatedEdges: Map<string, AggregatedEdgeState>

    /** Whether any aggregation request is loading */
    isLoading: boolean

    /** Last error encountered */
    error: string | null

    /**
     * Current granularity: entity type ID string, or null (no aggregation).
     */
    granularity: string | null

    /** Fetch aggregated edges for given source URNs */
    fetchAggregated: (sourceUrns: string[], targetUrns?: string[]) => Promise<void>

    /** Ask again, now, about the rows whose roll-ups could not be loaded
     *  after every automatic retry. */
    retryAggregated: () => Promise<void>

    /** Expand an aggregated edge to show detailed edges */
    expandEdge: (aggregatedEdgeId: string) => Promise<void>

    /** Fetch the next page of underlying edges for an expanded aggregated
     *  edge whose detail was truncated. */
    loadMoreDetail: (aggregatedEdgeId: string) => Promise<void>

    /** Collapse an expanded edge back to aggregated state */
    collapseEdge: (aggregatedEdgeId: string) => void

    /** Toggle expansion state of an edge */
    toggleEdge: (aggregatedEdgeId: string) => Promise<void>

    /** Check if an edge is expanded */
    isExpanded: (aggregatedEdgeId: string) => boolean

    /** Get all visible edges (both aggregated and detailed) */
    getVisibleEdges: () => Array<GraphEdge | AggregatedEdgeInfo>

    /** Change granularity (entity type ID string, or null for no aggregation) */
    setGranularity: (granularity: string | null) => void

    /** Clear all cached data */
    clearCache: () => void

    /**
     * Drop every aggregated-edge entry whose `sourceUrn` or `targetUrn` is
     * in the supplied URN set. Used on subtree collapse so stale child-level
     * aggregated edges disappear synchronously instead of waiting for the
     * 500 ms debounced refetch.
     */
    purgeEdgesIncidentToUrns: (urns: Iterable<string>) => void

    /** Get edge count for a specific aggregated edge */
    getEdgeCount: (aggregatedEdgeId: string) => number

    /** Get edge types summary for an aggregated edge */
    getEdgeTypes: (aggregatedEdgeId: string) => string[]

    /** True when the backend capped the aggregated-edge result set. */
    truncated: boolean

    /**
     * True while a source's data changed and a rebuild is queued/running —
     * the response is the prior rollup (stale-while-revalidate). Any stale
     * chunk marks the merged result stale.
     */
    stale: boolean

    /**
     * Why the result is stale (e.g. "source_changed"), or null when fresh.
     * First non-null reason across the merged chunks wins.
     */
    staleReason: string | null

    /**
     * Why part of the read was lost under the graph store's per-query
     * pressure (staleReason "query_memory" / "timeout"), or null. First
     * non-null detail across the merged chunks wins.
     */
    degradedDetail: AggregatedDegradedDetail | null

    /**
     * ISO-8601 timestamp of the last AGGREGATED materialisation, or null if
     * the projection has never been computed for this data source.
     */
    lastMaterializedAt: string | null

    /**
     * True when this response triggered a fire-and-forget materialise on
     * the backend — the canvas should re-poll shortly to pick up edges.
     */
    materializationTriggered: boolean
}

// ============================================
// Cache for aggregated edge results
// ============================================

interface CacheEntry {
    result: AggregatedEdgeResult
    timestamp: number
    sourceUrns: string[]
    targetUrns?: string[]
    granularity: string | null
}

const aggregatedEdgeCache = new Map<string, CacheEntry>()
const CACHE_MAX_ENTRIES = 200

function rememberResult(cacheKey: string, entry: CacheEntry): void {
    if (aggregatedEdgeCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = aggregatedEdgeCache.keys().next().value
        if (oldestKey !== undefined) aggregatedEdgeCache.delete(oldestKey)
    }
    aggregatedEdgeCache.set(cacheKey, entry)
}

const AGGREGATED_FETCH_BATCH_SIZE = 500
/** Page size for aggregated-edge detail expansion. The backend EdgeQuery
 *  default is 100, which silently under-delivered on large bundles. */
const AGG_EXPAND_LIMIT = 1000

// Cross-canvas invalidation. A draft save changes which rollups the server reports (the
// draft overlay adjusts main's aggregated edges by the draft's lineage delta), but the
// visible container set — and so the cache key — doesn't change, so nothing would refetch.
// Bumping the version gives `fetchAggregated` a new identity, re-running every canvas
// effect that depends on it against a cleared cache.
//
// Versions are kept PER SCOPE, with `GLOBAL_SCOPE` as the one every canvas adds in.
// The store used to hold a single counter, so every invalidation — including the ones
// a single degraded graph's retry loop fires — refetched `POST /graph/edges/aggregated`
// on every mounted canvas in the tab. That is the most expensive endpoint in the app,
// fanned into chunks, and a POST, so the client response cache absorbs none of it.
const GLOBAL_SCOPE = '*'
const useAggregatedCacheVersion = create<{ versions: Record<string, number> }>(
    () => ({ versions: {} }),
)

/** The version a canvas reading `scopeKey` sees: the global one plus its own. */
function versionFor(versions: Record<string, number>, scopeKey?: string): number {
    return (versions[GLOBAL_SCOPE] ?? 0) + (scopeKey ? (versions[scopeKey] ?? 0) : 0)
}

function bumpScope(scope: string): void {
    useAggregatedCacheVersion.setState((s) => ({
        versions: { ...s.versions, [scope]: (s.versions[scope] ?? 0) + 1 },
    }))
}

/** Drop all cached aggregated edges and make every mounted canvas refetch. Call after
 *  any mutation that can change rollups (draft save, publish/merge). */
export function invalidateAggregatedEdges(): void {
    aggregatedEdgeCache.clear()
    bumpScope(GLOBAL_SCOPE)
}

/**
 * The same thing for ONE provider scope: drop that scope's cached answers and
 * refetch only the canvases reading it.
 *
 * For conditions that belong to a single graph — a node holding it being
 * replaced, that source's projection catching up — this is what should run.
 * The global version stays where it belongs: mutations that genuinely change
 * what every canvas would see.
 *
 * An empty `scopeKey` means the provider did not declare one, and a cache key
 * built from '' is shared rather than scoped — so fall back to the global
 * drop rather than silently invalidating nothing.
 */
export function invalidateAggregatedEdgesForScope(scopeKey: string | undefined): void {
    if (!scopeKey) {
        invalidateAggregatedEdges()
        return
    }
    const prefix = `${scopeKey}:`
    for (const key of aggregatedEdgeCache.keys()) {
        if (key.startsWith(prefix)) aggregatedEdgeCache.delete(key)
    }
    bumpScope(scopeKey)
}

// Server-driven epoch invalidation. Every /edges/aggregated response carries
// lastMaterializedAt — the graph's aggregation-state epoch, bumped by the
// worker pipeline AND by purge. Whenever any fetch observes a DIFFERENT epoch
// than the last one seen, every cached answer (for every visible-set key) is
// pre-epoch and must go: purge, re-aggregation, post-purge heal, projection
// rebuild — all propagate within one fetch, with no dependence on a banner
// or job poller being mounted.
let lastSeenMaterializedEpoch: string | null | undefined = undefined

function noteMaterializedEpoch(epoch: string | null | undefined): void {
    if (epoch === undefined) return
    if (lastSeenMaterializedEpoch !== undefined && lastSeenMaterializedEpoch !== epoch) {
        lastSeenMaterializedEpoch = epoch
        invalidateAggregatedEdges()
        return
    }
    lastSeenMaterializedEpoch = epoch
}

/** Reactive cache version. Canvases include it in their fetch-dedupe keys so an
 *  invalidation (draft save, publish/merge, aggregation job completion) defeats
 *  the "visible set unchanged → skip refetch" guard and actually refetches.
 *
 *  Pass the provider's `scopeKey` to also pick up invalidations aimed at that
 *  scope alone; without it only the global ones are seen. The sum re-renders
 *  the caller on either, and never on another scope's. */
export function useAggregatedEdgesCacheVersion(scopeKey?: string): number {
    return useAggregatedCacheVersion((s) => versionFor(s.versions, scopeKey))
}

/**
 * Cap on parallel `/edges/aggregated` chunks. Aggregation is the
 * single most expensive endpoint — letting a 100k-URN canvas fire all
 * 200 chunks at once is a reliable way to saturate FalkorDB's single
 * Cypher thread. 4 concurrent chunks is the sweet spot per Phase 0 load
 * tests; tune via VITE_AGGREGATED_FETCH_CONCURRENCY.
 */
const AGGREGATED_FETCH_CONCURRENCY = (() => {
    const fromEnv = Number(import.meta.env?.VITE_AGGREGATED_FETCH_CONCURRENCY)
    return Number.isFinite(fromEnv) && fromEnv >= 1 ? fromEnv : 4
})()

// Cache key helper. The FNV-1a hash itself lives in hooks/lib/lineageCache
// so useLineageStubs and any future lineage hook share the same compact-key
// implementation. The shape of the key is per-hook (this one is per-pair).
// The hashes come in already made: a ledger ask hashes its (large) target
// list once for all of its chunks.
function urnSetHash(urns: readonly string[]): string {
    return fnv1a64([...urns].sort().join(''))
}

function getCacheKey(scope: string, srcHash: string, tgtHash: string, granularity: string | null): string {
    // ``scope`` = provider (workspace, data source, branch) identity. Without
    // it the module-global cache serves one graph's aggregated edges for an
    // identical URN set in ANOTHER graph — the same URN can exist in both.
    return `${scope}:${granularity}:${srcHash}:${tgtHash}`
}

/** Chunk answers merged into one: pairs deduped by id (a later chunk wins),
 *  any truncated or stale chunk marks the whole, the first reason and detail
 *  win, and the OLDEST materialisation epoch is reported — undefined when no
 *  chunk carried one, so an answer without it moves no epoch. */
function mergeAggregatedResults(results: AggregatedEdgeResult[]): AggregatedEdgeResult {
    const mergedEdgesById = new Map<string, AggregatedEdgeInfo>()
    let mergedTotalSourceEdges = 0
    let mergedTruncated = false
    let mergedStale = false
    let mergedStaleReason: string | null = null
    let mergedDegradedDetail: AggregatedDegradedDetail | null = null
    let mergedLastMaterializedAt: string | null | undefined = undefined
    let mergedMaterializationTriggered = false
    for (const r of results) {
        for (const agg of r.aggregatedEdges) mergedEdgesById.set(agg.id, agg)
        mergedTotalSourceEdges += r.totalSourceEdges ?? 0
        if (r.truncated) mergedTruncated = true
        if (r.stale) mergedStale = true
        if (mergedStaleReason === null && r.staleReason != null) mergedStaleReason = r.staleReason
        if (mergedDegradedDetail === null && r.degradedDetail != null) mergedDegradedDetail = r.degradedDetail
        if (r.materializationTriggered) mergedMaterializationTriggered = true
        if (r.lastMaterializedAt !== undefined) {
            if (mergedLastMaterializedAt === undefined || mergedLastMaterializedAt === null) {
                mergedLastMaterializedAt = r.lastMaterializedAt
            } else if (r.lastMaterializedAt && r.lastMaterializedAt < mergedLastMaterializedAt) {
                mergedLastMaterializedAt = r.lastMaterializedAt
            }
        }
    }
    return {
        aggregatedEdges: Array.from(mergedEdgesById.values()),
        totalSourceEdges: mergedTotalSourceEdges,
        truncated: mergedTruncated,
        stale: mergedStale,
        staleReason: mergedStaleReason,
        degradedDetail: mergedDegradedDetail,
        lastMaterializedAt: mergedLastMaterializedAt,
        materializationTriggered: mergedMaterializationTriggered,
    }
}

// ============================================
// The pair ledger
// ============================================
//
// Every canvas asks for the roll-ups among the rows it draws: the same list as
// sources and targets. That list changes with every page that lands and every
// expand or collapse, and asking the whole V × V set again each time sent
// ceil(V / 500) requests, each carrying all V targets, and repeated the
// server's target-side work for every one of them.
//
// A pair's answer depends only on that pair (the server reads s IN sources,
// t IN targets), so the ledger keeps what it has been told and asks only the
// delta: the new rows out to every row, and the rows it kept in to the new
// ones. Together with the pairs among the kept rows, that is every pair.
// Rows that leave take their pairs with them and ask nothing.
//
// One ledger per canvas, for one graph at one level: a new scope or level
// starts an empty one. A new cache version (an invalidation) starts over too,
// but keeps showing the pairs it knew until each row's fresh answer replaces
// them, so a resync that fails does not wipe every line.
//
// A chunk that fails, or comes back cut short, leaves the rows it was about
// uncovered, and the pairs the rest answered stay. Those rows wait for the
// ledger's own backoff (lookupRetryDelayMs, or the circuit breaker's window
// when the open breaker refused them), not the next page, and are asked
// MAX_ATTEMPTS times in all. Only then is there an `error` to show. A row
// is asked again only the leg it missed — its flows out, or its flows in —
// and a row whose flows out are known answers its part of a later page's
// flows in meanwhile. A cut-short row keeps why it was cut, so the canvas
// can tell a size cap (no reason) from a read that gave up.

/** Asks per row before its roll-ups are given up on, until Retry. */
const MAX_ATTEMPTS = 5

interface PairLedger {
    /** `${scopeKey}:${granularity}`: the graph and level the pairs are of. */
    scope: string
    /** The cache version they were asked at. */
    version: number
    /** Rows whose pairs with every other covered row are known. */
    covered: Set<string>
    /** The known pairs, by the server's own id (agg-{source}-{target}). */
    pairs: Map<string, AggregatedEdgeInfo>
    /** Uncovered rows whose last ask failed or was cut short. */
    misses: Map<string, Miss>
}

interface Miss {
    attempts: number
    /** Its last failure's message, or null when it came back cut short. */
    error: string | null
    /** The legs still unanswered: its flows out (row × every row), its
     *  flows in (every row whose flows out are known × row). */
    legs: { in: boolean; out: boolean }
    /** Why a cut-short answer was cut (its staleReason and detail); none
     *  is the server's size cap. */
    reason: string | null
    detail: AggregatedDegradedDetail | null
}

const emptyLedger = (scope: string, version: number, pairs?: Map<string, AggregatedEdgeInfo>): PairLedger =>
    ({ scope, version, covered: new Set(), pairs: new Map(pairs), misses: new Map() })

function scopeVersion(scopeKey: string | undefined): number {
    return versionFor(useAggregatedCacheVersion.getState().versions, scopeKey)
}

/** Forget the rows `gone` names: they are no longer covered or missed, and
 *  every pair touching one goes. True when a pair or a miss went. */
function forgetRows(ledger: PairLedger, gone: (urn: string) => boolean): boolean {
    let dropped = false
    for (const urn of ledger.covered) if (gone(urn)) ledger.covered.delete(urn)
    for (const urn of ledger.misses.keys()) {
        if (gone(urn)) {
            ledger.misses.delete(urn)
            dropped = true
        }
    }
    for (const [id, p] of ledger.pairs) {
        if (gone(p.sourceUrn) || gone(p.targetUrn)) {
            ledger.pairs.delete(id)
            dropped = true
        }
    }
    return dropped
}

function chunked(urns: string[]): string[][] {
    const chunks: string[][] = []
    for (let i = 0; i < urns.length; i += AGGREGATED_FETCH_BATCH_SIZE) {
        chunks.push(urns.slice(i, i + AGGREGATED_FETCH_BATCH_SIZE))
    }
    return chunks
}

/** One ledger ask, answered from the module cache when it can be. Only a
 *  complete answer is cached, and never one an invalidation outdated while
 *  it was out. */
async function askPairs(
    provider: GraphDataProvider,
    granularity: string | null,
    cacheTtl: number,
    sourceUrns: string[],
    targetUrns: string[],
    targetHash: string,
): Promise<AggregatedEdgeResult> {
    const cacheKey = getCacheKey(provider.scopeKey ?? '', urnSetHash(sourceUrns), targetHash, granularity)
    const cached = aggregatedEdgeCache.get(cacheKey)
    if (cached && (Date.now() - cached.timestamp) < cacheTtl) return cached.result
    const version = scopeVersion(provider.scopeKey)
    const result = await provider.getAggregatedEdges({ sourceUrns, targetUrns, granularity })
    if (!result.truncated && scopeVersion(provider.scopeKey) === version) {
        rememberResult(cacheKey, { result, timestamp: Date.now(), sourceUrns, granularity })
    }
    return result
}

// ============================================
// Hook Implementation
// ============================================

export function useAggregatedLineage(options: UseAggregatedLineageOptions = {}): UseAggregatedLineageResult {
    const {
        granularity: initialGranularity = null,
        cacheTtl = 5 * 60 * 1000, // 5 minutes
    } = options

    const provider = useGraphProvider()
    // Bumped by invalidateAggregatedEdges() — flows into fetchAggregated's deps so canvas
    // effects refetch against the cleared cache after a save. Scoped to this provider so
    // another graph's invalidation does not re-run this one's fetch.
    const cacheVersion = useAggregatedEdgesCacheVersion(provider?.scopeKey)

    // State
    const [aggregatedEdges, setAggregatedEdges] = useState<Map<string, AggregatedEdgeState>>(new Map())
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [granularity, setGranularity] = useState(initialGranularity)
    const [truncated, setTruncated] = useState(false)
    const [stale, setStale] = useState(false)
    const [staleReason, setStaleReason] = useState<string | null>(null)
    const [degradedDetail, setDegradedDetail] = useState<AggregatedDegradedDetail | null>(null)
    const [lastMaterializedAt, setLastMaterializedAt] = useState<string | null>(null)
    const [materializationTriggered, setMaterializationTriggered] = useState(false)

    // Track current source URNs for refetch on granularity change
    const currentSourceUrnsRef = useRef<string[]>([])
    const currentTargetUrnsRef = useRef<string[] | undefined>(undefined)

    // The pair ledger (see above) and what its next sync asks about. Read at
    // sync time, not at render: a level change must reach a sync the old
    // callback started.
    const ledgerRef = useRef<PairLedger>(emptyLedger('', 0))
    const rowsRef = useRef<Set<string>>(new Set())
    const askerRef = useRef<{ provider: GraphDataProvider; cacheTtl: number } | null>(null)
    const granularityRef = useRef(granularity)
    // One sync at a time; a change that arrives meanwhile runs it again.
    const runningRef = useRef(false)
    const againRef = useRef(false)
    // The backoff for the missed rows, and whether it is up.
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const retryDueRef = useRef(false)
    // Bumped per call. A one-sided (non-ledger) answer that lands after a
    // newer call is cached, never shown.
    const requestSeqRef = useRef(0)
    // What the ledger's latest answers said about their freshness.
    const latestFlagsRef = useRef<{ staleReason: string | null; degradedDetail: AggregatedDegradedDetail | null }>(
        { staleReason: null, degradedDetail: null })

    useEffect(() => () => clearTimeout(retryTimerRef.current), [])

    const showPairs = useCallback((pairs: Iterable<AggregatedEdgeInfo>) => {
        // Functional update: no dependency on aggregatedEdges, and an open
        // edge keeps its expansion.
        setAggregatedEdges(prev => {
            const edgeMap = new Map<string, AggregatedEdgeState>()
            for (const agg of pairs) {
                const existing = prev.get(agg.id)
                edgeMap.set(agg.id, {
                    aggregated: agg,
                    state: existing?.state ?? 'collapsed',
                    detailedEdges: existing?.detailedEdges ?? [],
                })
            }
            return edgeMap
        })
    }, [])

    const showFlags = useCallback((result: AggregatedEdgeResult) => {
        setTruncated(result.truncated ?? false)
        setStale(result.stale ?? false)
        setStaleReason(result.staleReason ?? null)
        setDegradedDetail(result.degradedDetail ?? null)
        setLastMaterializedAt(result.lastMaterializedAt ?? null)
        setMaterializationTriggered(result.materializationTriggered ?? false)
    }, [])

    // What the missing rows say: whether one was cut at the size cap; why
    // one was cut short otherwise, while the latest answers say nothing of
    // it; and, only once a row's asks are used up, why some are missing.
    const showMisses = useCallback((ledger: PairLedger) => {
        let capped = false
        let reason: string | null = null
        let detail: AggregatedDegradedDetail | null = null
        let failure: string | null = null
        ledger.misses.forEach(m => {
            if (m.error === null) {
                if (m.reason === null) capped = true
                reason ??= m.reason
                detail ??= m.detail
            } else if (m.attempts >= MAX_ATTEMPTS) failure ??= m.error
        })
        setTruncated(capped)
        setStaleReason(latestFlagsRef.current.staleReason ?? reason)
        setDegradedDetail(latestFlagsRef.current.degradedDetail ?? detail)
        setError(failure)
    }, [])

    const showLedger = useCallback((ledger: PairLedger) => {
        showPairs([...ledger.pairs.values()])
        showMisses(ledger)
    }, [showPairs, showMisses])

    // Bring the ledger up to the rows in rowsRef: forget the rows that left,
    // then ask about the new ones, and the missed ones once their backoff is up.
    const syncPairs = useCallback(async () => {
        if (runningRef.current) { againRef.current = true; return }
        const where = () => {
            const scopeKey = askerRef.current?.provider.scopeKey
            return { scope: `${scopeKey ?? ''}:${granularityRef.current}`, version: scopeVersion(scopeKey) }
        }
        const syncOnce = async () => {
            const asker = askerRef.current
            if (!asker) return
            const { provider, cacheTtl } = asker
            const granularity = granularityRef.current
            const at = where()
            if (ledgerRef.current.scope !== at.scope || ledgerRef.current.version !== at.version) {
                const prev = ledgerRef.current
                ledgerRef.current = emptyLedger(at.scope, at.version, prev.scope === at.scope ? prev.pairs : undefined)
            }
            const ledger = ledgerRef.current
            const rows = rowsRef.current
            const retrying = retryDueRef.current
            retryDueRef.current = false
            if (forgetRows(ledger, urn => !rows.has(urn))) showLedger(ledger)

            const added = [...rows].filter(urn => {
                if (ledger.covered.has(urn)) return false
                const miss = ledger.misses.get(urn)
                return !miss || (retrying && miss.attempts < MAX_ATTEMPTS)
            })
            if (added.length === 0) return
            // Each leg where it is unanswered: a new row needs both, a missed
            // row the one it missed. Flows in come from every row whose flows
            // out are known (covered, or missed on its flows in alone); the
            // rows asked their flows out now answer the rest.
            const outRows = added.filter(urn => ledger.misses.get(urn)?.legs.out ?? true)
            const inRows = added.filter(urn => ledger.misses.get(urn)?.legs.in ?? true)
            const inSources = [...rows].filter(urn => ledger.covered.has(urn) || ledger.misses.get(urn)?.legs.out === false)
            const all = [...rows]
            const allHash = urnSetHash(all)
            const inHash = urnSetHash(inRows)
            const asks = [
                ...chunked(outRows).map(sources => ({ sources, targets: all, targetHash: allHash, out: true })),
                ...(inRows.length > 0
                    ? chunked(inSources).map(sources => ({ sources, targets: inRows, targetHash: inHash, out: false }))
                    : []),
            ]

            setIsLoading(true)
            try {
                // Bound parallel chunks: every chunk competes for the same
                // single-threaded Cypher slot.
                const settled = await mapWithConcurrency(
                    asks,
                    AGGREGATED_FETCH_CONCURRENCY,
                    (a) => askPairs(provider, granularity, cacheTtl, a.sources, a.targets, a.targetHash),
                )
                // Superseded (a new graph, level or invalidation, or a clear,
                // while this was out): cached by askPairs, never shown.
                const now = where()
                if (ledgerRef.current !== ledger || now.scope !== ledger.scope || now.version !== ledger.version) return

                // The rows an ask was about: an out ask's sources, or the
                // rows an in ask asked about; each misses that leg when the
                // ask failed or came back cut short. A full answer to (S, T)
                // is the whole truth about S × T, so what it no longer names
                // goes, including what an invalidated ledger carried over.
                const missed = new Map<string, Miss>()
                const noteMiss = (urn: string, out: boolean, error: string | null, cut?: AggregatedEdgeResult) => {
                    const m = missed.get(urn) ?? { attempts: 0, error: null, legs: { in: false, out: false }, reason: null, detail: null }
                    m.legs[out ? 'out' : 'in'] = true
                    if (error !== null) m.error = error
                    if (cut) {
                        m.reason ??= cut.staleReason ?? null
                        m.detail ??= cut.degradedDetail ?? null
                    }
                    missed.set(urn, m)
                }
                const answeredOut = new Set<string>()
                const answeredIn = new Set<string>()
                const fulfilled: AggregatedEdgeResult[] = []
                let refused = false
                settled.forEach((s, i) => {
                    const { sources, out } = asks[i]
                    const about = out ? sources : inRows
                    if (s.status === 'rejected') {
                        const message = s.reason instanceof Error ? s.reason.message : 'Failed to fetch some aggregated edges'
                        about.forEach(urn => noteMiss(urn, out, message))
                        if (classifyGraphFailure(s.reason) === 'unavailable') refused = true
                        return
                    }
                    fulfilled.push(s.value)
                    if (s.value.truncated) {
                        about.forEach(urn => noteMiss(urn, out, null, s.value))
                    } else {
                        sources.forEach(urn => (out ? answeredOut : answeredIn).add(urn))
                    }
                })
                const inSet = new Set(inRows)
                for (const [id, p] of ledger.pairs) {
                    if (answeredOut.has(p.sourceUrn) || (answeredIn.has(p.sourceUrn) && inSet.has(p.targetUrn))) {
                        ledger.pairs.delete(id)
                    }
                }
                for (const r of fulfilled) for (const agg of r.aggregatedEdges) ledger.pairs.set(agg.id, agg)
                for (const urn of added) {
                    const m = missed.get(urn)
                    if (m === undefined) {
                        ledger.covered.add(urn)
                        ledger.misses.delete(urn)
                    } else {
                        ledger.misses.set(urn, { ...m, attempts: (ledger.misses.get(urn)?.attempts ?? 0) + 1 })
                    }
                }
                // Rows that left while this was out.
                const latest = rowsRef.current
                forgetRows(ledger, urn => !latest.has(urn))
                if (fulfilled.length > 0) {
                    const merged = mergeAggregatedResults(fulfilled)
                    noteMaterializedEpoch(merged.lastMaterializedAt)
                    latestFlagsRef.current = { staleReason: merged.staleReason ?? null, degradedDetail: merged.degradedDetail ?? null }
                    showFlags(merged)
                }
                showLedger(ledger)

                // Asking again before the open breaker lets a probe through
                // would only be refused again, so a refusal waits for it.
                let due = 0
                ledger.misses.forEach(m => { if (m.attempts < MAX_ATTEMPTS) due = Math.max(due, m.attempts) })
                if (due > 0 && retryTimerRef.current === undefined) {
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = undefined
                        retryDueRef.current = true
                        void syncPairs()
                    }, Math.max(lookupRetryDelayMs(due), refused ? CIRCUIT_RESET_MS : 0))
                }
            } finally {
                setIsLoading(false)
            }
        }
        runningRef.current = true
        try {
            do {
                againRef.current = false
                await syncOnce()
            } while (againRef.current)
        } finally {
            runningRef.current = false
        }
    }, [showLedger, showFlags])

    // Ask again, now, about the rows whose asks were used up (the banner's
    // Retry): the legs they missed, as many times again.
    const retryAggregated = useCallback(() => {
        ledgerRef.current.misses.forEach(m => { m.attempts = 0 })
        retryDueRef.current = true
        return syncPairs()
    }, [syncPairs])

    // Fetch aggregated edges from backend
    const fetchAggregated = useCallback(async (sourceUrns: string[], targetUrns?: string[]) => {
        if (!provider || sourceUrns.length === 0) return
        const seq = ++requestSeqRef.current

        // The pairs among a set of rows — what every canvas asks for — go
        // through the ledger, which asks only about what changed.
        if (targetUrns === sourceUrns) {
            askerRef.current = { provider, cacheTtl }
            rowsRef.current = new Set(sourceUrns)
            currentSourceUrnsRef.current = sourceUrns
            currentTargetUrnsRef.current = targetUrns
            return syncPairs()
        }

        // Check cache first (scoped by provider identity — the same URN set
        // in a different data source must not collide in the module cache).
        const cacheKey = getCacheKey(
            provider.scopeKey ?? '', urnSetHash(sourceUrns), targetUrns ? urnSetHash(targetUrns) : '0', granularity,
        )
        const cached = aggregatedEdgeCache.get(cacheKey)

        if (cached && (Date.now() - cached.timestamp) < cacheTtl) {
            showPairs(cached.result.aggregatedEdges)
            showFlags(cached.result)
            return
        }

        setIsLoading(true)
        setError(null)

        try {
            // Chunk source URNs above the per-request budget so a 100k-node
            // canvas doesn't hand the backend a single 100k-URN payload.
            const chunks = chunked(sourceUrns)

            // Bound parallel chunks so a 200-chunk fan-out doesn't blow
            // up the FalkorDB Cypher thread (single-threaded — every
            // chunk competes for the same slot).
            const settled = await mapWithConcurrency(
                chunks,
                AGGREGATED_FETCH_CONCURRENCY,
                (chunk) => provider.getAggregatedEdges({
                    sourceUrns: chunk,
                    targetUrns,
                    granularity,
                }),
            )

            const fulfilled = settled
                .filter((s): s is PromiseFulfilledResult<AggregatedEdgeResult> => s.status === 'fulfilled')
                .map(s => s.value)
            const rejected = settled.filter(s => s.status === 'rejected') as PromiseRejectedResult[]

            // Dedupe-merge by agg.id; later chunks with same id win (last-write).
            const merged = mergeAggregatedResults(fulfilled)
            noteMaterializedEpoch(merged.lastMaterializedAt)
            const mergedResult: AggregatedEdgeResult = { ...merged, lastMaterializedAt: merged.lastMaterializedAt ?? null }

            // Cache the merged result (LRU eviction when full) — but only when
            // it's a COMPLETE answer. A truncated merge, or one missing a chunk
            // that rejected/failed, must never be re-served from the module
            // cache as if it were the full set. `stale` results ARE cached:
            // while a rebuild runs every response is stale-flagged, so skipping
            // the cache for stale would refetch continuously and defeat
            // stale-while-revalidate.
            if (!mergedResult.truncated && rejected.length === 0) {
                rememberResult(cacheKey, {
                    result: mergedResult,
                    timestamp: Date.now(),
                    sourceUrns,
                    targetUrns,
                    granularity,
                })
            }
            // A newer call was answered meanwhile (the cache-hit branch
            // answers at once): this one is cached, never shown.
            if (seq !== requestSeqRef.current) return

            showPairs(mergedResult.aggregatedEdges)
            showFlags(mergedResult)

            // Partial-success: surface the failure but keep applied chunks.
            if (rejected.length > 0) {
                const firstErr = rejected[0].reason
                setError(firstErr instanceof Error ? firstErr.message : 'Failed to fetch some aggregated edges')
            }

            // Track for refetch
            currentSourceUrnsRef.current = sourceUrns
            currentTargetUrnsRef.current = targetUrns

        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch aggregated edges')
        } finally {
            setIsLoading(false)
        }
        // cacheVersion: identity-busting dep — see invalidateAggregatedEdges.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, granularity, cacheTtl, cacheVersion, syncPairs, showPairs, showFlags])

    // Expand an aggregated edge to show detailed edges
    const expandEdge = useCallback(async (aggregatedEdgeId: string) => {
        const edgeState = aggregatedEdges.get(aggregatedEdgeId)
        if (!edgeState || !provider) return

        // Already expanded or loading
        if (edgeState.state === 'expanded' || edgeState.state === 'loading') return

        // Update state to loading
        setAggregatedEdges(prev => {
            const next = new Map(prev)
            const current = next.get(aggregatedEdgeId)
            if (current) {
                next.set(aggregatedEdgeId, { ...current, state: 'loading' })
            }
            return next
        })

        try {
            // Fetch detailed edges strictly between source and target.
            // Explicit limit: the backend EdgeQuery default is 100, which
            // silently truncated bundles advertising thousands of edges.
            // 1000 matches what the canvas can usefully absorb via the
            // coalesced tier; beyond that, loadMoreDetail pages onward.
            const edges = await provider.getEdges({
                sourceUrns: [edgeState.aggregated.sourceUrn],
                targetUrns: [edgeState.aggregated.targetUrn],
                limit: AGG_EXPAND_LIMIT,
            })

            const detailTotal = edgeState.aggregated.edgeCount
            const detailTruncated = edges.length >= AGG_EXPAND_LIMIT
                && (detailTotal ?? 0) > edges.length

            setAggregatedEdges(prev => {
                const next = new Map(prev)
                const current = next.get(aggregatedEdgeId)
                if (current) {
                    next.set(aggregatedEdgeId, {
                        ...current,
                        state: 'expanded',
                        detailedEdges: edges,
                        detailTotal,
                        detailTruncated,
                    })
                }
                return next
            })
        } catch (err) {
            // Revert to collapsed on error
            setAggregatedEdges(prev => {
                const next = new Map(prev)
                const current = next.get(aggregatedEdgeId)
                if (current) {
                    next.set(aggregatedEdgeId, { ...current, state: 'collapsed' })
                }
                return next
            })
            setError(err instanceof Error ? err.message : 'Failed to expand edge')
        }
    }, [aggregatedEdges, provider])

    // Fetch the next page of underlying edges for a truncated expansion
    const loadMoreDetail = useCallback(async (aggregatedEdgeId: string) => {
        const edgeState = aggregatedEdges.get(aggregatedEdgeId)
        if (!edgeState || !provider) return
        if (edgeState.state !== 'expanded' || !edgeState.detailTruncated) return

        try {
            const more = await provider.getEdges({
                sourceUrns: [edgeState.aggregated.sourceUrn],
                targetUrns: [edgeState.aggregated.targetUrn],
                offset: edgeState.detailedEdges.length,
                limit: AGG_EXPAND_LIMIT,
            })
            setAggregatedEdges(prev => {
                const next = new Map(prev)
                const current = next.get(aggregatedEdgeId)
                if (current) {
                    const seen = new Set(current.detailedEdges.map(e => e.id))
                    const merged = [...current.detailedEdges, ...more.filter(e => !seen.has(e.id))]
                    next.set(aggregatedEdgeId, {
                        ...current,
                        detailedEdges: merged,
                        detailTruncated: more.length >= AGG_EXPAND_LIMIT
                            && (current.detailTotal ?? 0) > merged.length,
                    })
                }
                return next
            })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load more edges')
        }
    }, [aggregatedEdges, provider])

    // Collapse an expanded edge
    const collapseEdge = useCallback((aggregatedEdgeId: string) => {
        setAggregatedEdges(prev => {
            const next = new Map(prev)
            const current = next.get(aggregatedEdgeId)
            if (current) {
                next.set(aggregatedEdgeId, {
                    ...current,
                    state: 'collapsed',
                    // Keep detailed edges cached for quick re-expand
                })
            }
            return next
        })
    }, [])

    // Toggle expansion
    const toggleEdge = useCallback(async (aggregatedEdgeId: string) => {
        const edgeState = aggregatedEdges.get(aggregatedEdgeId)
        if (!edgeState) return

        if (edgeState.state === 'expanded') {
            collapseEdge(aggregatedEdgeId)
        } else if (edgeState.state === 'collapsed') {
            await expandEdge(aggregatedEdgeId)
        }
    }, [aggregatedEdges, expandEdge, collapseEdge])

    // Check if expanded
    const isExpanded = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.state === 'expanded'
    }, [aggregatedEdges])

    // Get all visible edges
    const getVisibleEdges = useCallback(() => {
        const visible: Array<GraphEdge | AggregatedEdgeInfo> = []

        for (const [, edgeState] of aggregatedEdges) {
            if (edgeState.state === 'expanded' && edgeState.detailedEdges.length > 0) {
                // Show detailed edges when expanded
                visible.push(...edgeState.detailedEdges)
            } else {
                // Show aggregated edge when collapsed
                visible.push(edgeState.aggregated)
            }
        }

        return visible
    }, [aggregatedEdges])

    // Change granularity and refetch
    const handleSetGranularity = useCallback((newGranularity: string | null) => {
        if (newGranularity === granularity) return

        granularityRef.current = newGranularity
        setGranularity(newGranularity)

        // Refetch with new granularity if we have current sources
        if (currentSourceUrnsRef.current.length > 0) {
            // Clear cache for new granularity
            aggregatedEdgeCache.clear()
            fetchAggregated(currentSourceUrnsRef.current, currentTargetUrnsRef.current)
        }
    }, [granularity, fetchAggregated])

    // Clear cache
    const clearCache = useCallback(() => {
        aggregatedEdgeCache.clear()
        setAggregatedEdges(new Map())
        currentSourceUrnsRef.current = []
        currentTargetUrnsRef.current = undefined
        ledgerRef.current = emptyLedger('', 0)
        rowsRef.current = new Set()
        latestFlagsRef.current = { staleReason: null, degradedDetail: null }
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = undefined
        setTruncated(false)
        setStale(false)
        setStaleReason(null)
        setLastMaterializedAt(null)
        setMaterializationTriggered(false)
    }, [])

    // Synchronous purge: drop entries incident to the supplied URN set.
    // Caller is the collapse path in ContextViewCanvas — it computes the
    // collapsed subtree's URNs and asks us to drop their aggregated edges
    // immediately, avoiding the 500 ms debounce flicker.
    const purgeEdgesIncidentToUrns = useCallback((urns: Iterable<string>) => {
        const urnSet = urns instanceof Set ? urns : new Set(urns)
        if (urnSet.size === 0) return
        // The ledger forgets them too, so they are asked about again if
        // they come back before the next sync sees them leave; and what it
        // says is missing is said again without them.
        if (forgetRows(ledgerRef.current, urn => urnSet.has(urn))) showMisses(ledgerRef.current)
        setAggregatedEdges(prev => {
            let removed = 0
            const next = new Map(prev)
            for (const [id, entry] of prev) {
                if (urnSet.has(entry.aggregated.sourceUrn) || urnSet.has(entry.aggregated.targetUrn)) {
                    next.delete(id)
                    removed++
                }
            }
            return removed > 0 ? next : prev
        })
    }, [showMisses])

    // Get edge count
    const getEdgeCount = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.aggregated.edgeCount ?? 0
    }, [aggregatedEdges])

    // Get edge types
    const getEdgeTypes = useCallback((aggregatedEdgeId: string) => {
        return aggregatedEdges.get(aggregatedEdgeId)?.aggregated.edgeTypes ?? []
    }, [aggregatedEdges])

    return {
        aggregatedEdges,
        isLoading,
        error,
        granularity,
        fetchAggregated,
        retryAggregated,
        expandEdge,
        loadMoreDetail,
        collapseEdge,
        toggleEdge,
        isExpanded,
        getVisibleEdges,
        setGranularity: handleSetGranularity,
        clearCache,
        purgeEdgesIncidentToUrns,
        getEdgeCount,
        getEdgeTypes,
        truncated,
        stale,
        staleReason,
        degradedDetail,
        lastMaterializedAt,
        materializationTriggered,
    }
}

// ============================================
// Utility: Convert aggregated edge to React Flow edge
// ============================================

export function aggregatedEdgeToFlowEdge(
    agg: AggregatedEdgeInfo,
    options?: {
        animated?: boolean
        strokeWidth?: number
        showLabel?: boolean
    }
): {
    id: string
    source: string
    target: string
    type: string
    animated: boolean
    style: React.CSSProperties
    data: Record<string, unknown>
    label?: string
} {
    const { animated = true, strokeWidth = 2, showLabel = true } = options ?? {}

    // Scale stroke width based on edge count
    const scaledStrokeWidth = Math.min(strokeWidth + Math.log2(agg.edgeCount), 8)

    return {
        id: agg.id,
        source: agg.sourceUrn,
        target: agg.targetUrn,
        type: 'aggregated',
        animated,
        style: {
            strokeWidth: scaledStrokeWidth,
            opacity: agg.confidence,
        },
        data: {
            isAggregated: true,
            edgeCount: agg.edgeCount,
            edgeTypes: agg.edgeTypes,
            confidence: agg.confidence,
            sourceEdgeIds: agg.sourceEdgeIds,
        },
        label: showLabel ? `${agg.edgeCount} edges` : undefined,
    }
}

