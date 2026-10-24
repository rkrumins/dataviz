/**
 * ruleCounts — each display rule's exact total in the view.
 *
 * The server counts a rule over the whole view — every entity, however
 * many — a slice of the scan per request (``POST /search/counts``). This
 * follows it to the end: the same rules go back with the sessions each
 * answer returned until every count is complete, and every answer is
 * reported as it lands, so a card can read "12,431 so far" and then the
 * exact number.
 */
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchScope } from '@/types/search'


export interface RuleCount {
    count: number
    /** The count is exact: every entity in the view was read. */
    complete: boolean
    /** How far through the view the count has got, 0–100. */
    percent: number
    /** Why the rule could not be counted (``complete``: it reads 0), or
     *  why its count stopped short (``count`` is then a floor). */
    error?: string
}

export interface RuleToCount {
    id: string
    predicate: Predicate
}

/** The server takes at most this many rules per request. */
const RULES_PER_REQUEST = 32

/** How long each request lets the server count before answering. */
const WAIT_MS = 1000

/** A backstop, not a budget: at ~1 s a request, ten minutes of counting. */
const MAX_REQUESTS = 600


export interface CountRulesOptions {
    signal?: AbortSignal
    onUpdate?: (counts: ReadonlyMap<string, RuleCount>) => void
    /** Where to count: the whole view unless said otherwise — a search
     *  being built counts in the scope it runs in. */
    scope?: SearchScope
    /** ``search``: the conditions of a search being built, held to a
     *  search's limits rather than a display rule's. */
    purpose?: 'rule' | 'search'
    /** Stop after this many requests and answer with the counts so far —
     *  floors, not exact — instead of following every count to the end. */
    maxRequests?: number
}


/**
 * Count ``rules`` in ``viewId``, calling ``onUpdate`` with every rule's
 * count after each answer. Resolves with the final counts; rejects when
 * aborted or when a request fails — after one last ``onUpdate`` in which
 * every unfinished count carries why it stopped, so nothing reads
 * "counting" for ever. (The request layer has already retried what was
 * worth retrying: a 429, a timeout, a dropped connection.)
 */
export async function countRules(
    provider: RemoteGraphProvider,
    viewId: string,
    rules: ReadonlyArray<RuleToCount>,
    opts: CountRulesOptions = {},
): Promise<ReadonlyMap<string, RuleCount>> {
    const counts = new Map<string, RuleCount>()
    try {
        for (let i = 0; i < rules.length; i += RULES_PER_REQUEST) {
            await countGroup(provider, viewId, rules.slice(i, i + RULES_PER_REQUEST), counts, opts)
        }
    } catch (err) {
        if (!opts.signal?.aborted) {
            const error = `The count stopped: ${(err as Error).message}`
            for (const rule of rules) {
                const c = counts.get(rule.id)
                if (!c?.complete) {
                    counts.set(rule.id, { count: c?.count ?? 0, complete: false, percent: c?.percent ?? 0, error })
                }
            }
            opts.onUpdate?.(new Map(counts))
        }
        throw err
    }
    return counts
}


async function countGroup(
    provider: RemoteGraphProvider,
    viewId: string,
    rules: ReadonlyArray<RuleToCount>,
    counts: Map<string, RuleCount>,
    opts: CountRulesOptions,
): Promise<void> {
    const sessions: Record<string, string> = {}
    const items = rules.map((r) => ({ id: r.id, predicate: asGroup(r.predicate) }))
    const scope = opts.scope ?? { viewId, scopeMode: 'view' }
    for (let request = 0; request < (opts.maxRequests ?? MAX_REQUESTS); request++) {
        const answer = await provider.searchCounts(
            { scope, items, waitMs: WAIT_MS, sessions: { ...sessions },
              ...(opts.purpose ? { purpose: opts.purpose } : {}) },
            { signal: opts.signal },
        )
        let complete = true
        for (const rule of rules) {
            const c = answer.counts[rule.id]
            if (!c) continue
            if (c.sessionId) sessions[rule.id] = c.sessionId
            const done = c.status === 'complete'
            complete = complete && done
            counts.set(rule.id, {
                count: c.count,
                complete: done,
                percent: done ? 100 : percentOf(c.progress),
                ...(c.error ? { error: c.error } : {}),
            })
        }
        opts.onUpdate?.(new Map(counts))
        if (complete) return
    }
    // A cap the caller asked for: what has been counted so far is the answer.
    if (opts.maxRequests !== undefined) return
    throw new Error(`still counting after ${MAX_REQUESTS} requests`)
}


function percentOf(progress: { scanned: number; total: number } | null | undefined): number {
    if (!progress || progress.total <= 0) return 0
    return Math.min(99, Math.floor((progress.scanned / progress.total) * 100))
}


/** The same defensive AND-wrap every search applies to a bare leaf. */
function asGroup(predicate: Predicate): Predicate {
    return predicate.kind === 'group'
        ? predicate
        : { kind: 'group', op: 'and', children: [predicate] }
}
