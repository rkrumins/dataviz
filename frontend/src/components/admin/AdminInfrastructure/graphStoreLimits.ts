/**
 * The pure half of the graph store limits dialog: what a draft would change
 * on a node, and what blocks it — the same rules the server applies
 * (``graph_store_limits.validate_limits``), so the dialog explains a refusal
 * before the round trip and the server stays the authority.
 */
import type { GraphStoreLimitsPatch, ShardCapacity } from '@/services/aggregationService'
import { compactBytes, containerNeededBytes } from '../shared/aggregationKnobs'

export const MIB = 2 ** 20
export const GIB = 2 ** 30
/** The planning figure when the node does not report its THREAD_COUNT — the shipped FALKORDB_ARGS value. */
export const THREADS_ASSUMED = 4

export function parse(raw: string): number | null {
    const t = raw.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
}

export function fmtS(ms: number): string {
    const s = ms / 1000
    return s % 1 === 0 ? String(s) : s.toFixed(1)
}

export interface LimitsDraft {
    /** TIMEOUT_MAX, seconds. */
    timeoutS: string
    /** QUERY_MEM_CAPACITY, MiB. */
    capMb: string
    /** The container's memory limit, GiB — needed to raise the ceiling. */
    containerGb: string
    /** Queries that may hold the ceiling at once, for the formula. */
    concurrent: string
    applyToAll: boolean
}

export interface LimitsPlan {
    /** The request to send, or null while nothing changed or something blocks it. */
    patch: GraphStoreLimitsPatch | null
    changes: { name: 'TIMEOUT_MAX' | 'QUERY_MEM_CAPACITY'; from: string; to: string }[]
    /** What to add to FALKORDB_ARGS to keep the change across a restart. */
    fragment: string
    resultingCap: number | null
    /** The container the formula asks for at the resulting ceiling; null without maxmemory or a ceiling. */
    needed: number | null
    container: number | null
    concurrent: number
    threads: number
    threadsAssumed: boolean
    raising: boolean
    problems: string[]
}

/**
 * What the draft would change on the node, and what blocks it — the same
 * rules the server applies (``graph_store_limits.validate_limits``), so the
 * dialog explains a refusal before the round trip and the server stays the
 * authority.
 */
export function planLimits(shard: ShardCapacity | null | undefined, draft: LimitsDraft): LimitsPlan {
    const threads = shard?.threadCount ?? THREADS_ASSUMED
    const threadsAssumed = shard?.threadCount == null
    const concurrentRaw = parse(draft.concurrent)
    const concurrent = Math.min(threads, Math.max(1, Math.floor(concurrentRaw ?? threads)))
    const containerGb = parse(draft.containerGb)
    const container = containerGb != null && containerGb > 0 ? Math.round(containerGb * GIB) : null
    const base = { container, concurrent, threads, threadsAssumed }
    if (!shard) {
        return {
            ...base, patch: null, changes: [], fragment: '', resultingCap: null, needed: null, raising: false,
            problems: ['This node is not in the capacity sweep, so there is no client to reach it through.'],
        }
    }
    const problems: string[] = []
    const changes: LimitsPlan['changes'] = []
    const fragment: string[] = []
    const patch: GraphStoreLimitsPatch = {}

    const timeoutSRaw = parse(draft.timeoutS)
    const timeoutMs = timeoutSRaw != null ? Math.round(timeoutSRaw * 1000) : null
    const currentTimeout = shard.timeoutMaxMs ?? null
    if (timeoutMs != null && timeoutMs !== currentTimeout) {
        if (timeoutMs < 1_000) {
            problems.push('The query time cap must be at least 1 s.')
        } else if (timeoutMs > 3_600_000) {
            problems.push('The query time cap must be at most one hour (3,600 s).')
        } else if (shard.timeoutDefaultMs != null && timeoutMs < shard.timeoutDefaultMs) {
            problems.push(`The query time cap cannot go below the node’s TIMEOUT_DEFAULT of ${fmtS(shard.timeoutDefaultMs)} s — the store refuses that.`)
        } else {
            patch.timeoutMaxMs = timeoutMs
            changes.push({ name: 'TIMEOUT_MAX', from: currentTimeout != null ? `${fmtS(currentTimeout)} s` : 'no cap', to: `${fmtS(timeoutMs)} s` })
            fragment.push(`TIMEOUT_MAX ${timeoutMs}`)
        }
    }

    const capMbRaw = parse(draft.capMb)
    const capBytes = capMbRaw != null ? Math.round(capMbRaw * MIB) : null
    const currentCap = shard.queryMemCapacity ?? null
    const capChanged = capBytes != null && capBytes !== currentCap
    const raising = capChanged && (currentCap == null || capBytes > currentCap)
    const resultingCap = capChanged ? capBytes : currentCap
    const maxmemory = shard.maxmemory ?? 0
    const needed = resultingCap != null && resultingCap > 0 && maxmemory > 0
        ? containerNeededBytes(maxmemory, concurrent, resultingCap)
        : null
    if (capChanged) {
        if (capBytes <= 0) {
            problems.push('The per-query memory ceiling must be above 0 — 0 would be unlimited, and one query could take the whole container.')
        } else if (raising && container == null) {
            problems.push('Enter the container memory limit to raise the ceiling — the application cannot read it, and a ceiling the container cannot back turns a refused query into an OOM-killed node.')
        } else if (raising && maxmemory <= 0) {
            problems.push('The node reports no maxmemory, so the sizing formula cannot be applied. Set maxmemory on the node first.')
        } else if (raising && needed != null && container != null && needed > container) {
            problems.push(
                `Short by ${compactBytes(needed - container)}: a ${compactBytes(capBytes)} ceiling needs at least ${compactBytes(needed)} `
                + `for ${concurrent} concurrent ${concurrent === 1 ? 'query' : 'queries'}, and the container has ${compactBytes(container)}. `
                + 'Raise the container limit first, plan for fewer concurrent queries, or choose a smaller ceiling.',
            )
        } else {
            patch.queryMemCapacity = capBytes
            patch.concurrentQueries = concurrent
            if (raising && container != null) patch.containerMemoryBytes = container
            changes.push({ name: 'QUERY_MEM_CAPACITY', from: currentCap != null ? compactBytes(currentCap) : 'unlimited', to: compactBytes(capBytes) })
            fragment.push(`QUERY_MEM_CAPACITY ${capBytes}`)
        }
    }
    if (draft.applyToAll && changes.length) patch.applyToAllNodes = true
    return {
        ...base,
        patch: changes.length && !problems.length ? patch : null,
        changes, fragment: fragment.join(' '), resultingCap, needed, raising, problems,
    }
}
