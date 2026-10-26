/**
 * useCounts — how many entities match each of a set of conditions, in the
 * scope the panel's search runs in, as the conditions are edited.
 *
 * Built so that counting never gets in the way of typing:
 *   - it waits for the edits to settle (``debounceMs``) and abandons a
 *     count the moment the conditions change;
 *   - a complete count is kept (per provider and scope, five minutes), so
 *     undoing an edit or reopening the panel shows it at once, and only
 *     the conditions not yet counted are asked for — the server keeps its
 *     own count sessions too, so asking again is cheap there as well;
 *   - ``rough``: two requests at most, for a preview that only has to say
 *     "about how many";
 *   - where counting isn't offered (a share link, an engine without
 *     counts) it says so once and stops asking;
 *   - with live counts turned off (``liveCounts``) it asks for nothing,
 *     and a count under way is abandoned.
 */
import { useEffect, useMemo, useState } from 'react'

import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { countRules, type RuleCount } from '@/services/ruleCounts'
import { useSearchStore } from '@/store/searchStore'

import { currentScope } from '../../searchRequest'

import type { CountItem } from './clauseItems'
import { useLiveCounts } from './liveCounts'


export interface CountState {
    count: number
    /** Exact: every entity in scope was read. Otherwise a floor. */
    complete: boolean
    /** Why it couldn't be counted (or stopped short). */
    error?: string
}

export type CountsStatus = 'idle' | 'counting' | 'done' | 'unavailable' | 'off'

export interface CountsResult {
    counts: ReadonlyMap<string, CountState>
    status: CountsStatus
}

export interface UseCountsOptions {
    debounceMs?: number
    rough?: boolean
    enabled?: boolean
}

/** Past this many entities on the canvas, "visible" scope isn't counted
 *  live: every request would carry them all. */
const VISIBLE_URNS_MAX = 5000
const TTL_MS = 5 * 60_000

interface Cached extends CountState { at: number }

/** Complete counts, per provider, then per scope. */
const cache = new WeakMap<object, Map<string, Map<string, Cached>>>()
/** Views whose counts the server refused here (403 / 501), per provider. */
const refused = new WeakMap<object, Set<string>>()

function cacheFor(provider: object, scopeKey: string): Map<string, Cached> {
    let byScope = cache.get(provider)
    if (!byScope) cache.set(provider, (byScope = new Map()))
    let byItem = byScope.get(scopeKey)
    if (!byItem) byScope.set(scopeKey, (byItem = new Map()))
    return byItem
}

function scopeKeyOf(viewId: string): { key: string; urns: number } {
    const scope = currentScope(viewId)
    const urns = scope.visibleUrns ?? []
    let h = 0
    for (const u of [...urns].sort()) for (let i = 0; i < u.length; i++) h = (Math.imul(h, 31) + u.charCodeAt(i)) | 0
    return { key: `${viewId}|${scope.scopeMode}|${urns.length}:${h}`, urns: urns.length }
}

export function useCounts(
    viewId: string | null,
    items: readonly CountItem[],
    { debounceMs = 600, rough = false, enabled = true }: UseCountsOptions = {},
): CountsResult {
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    // Counts belong to the scope the search runs in: a change of scope is
    // a change of every count.
    const scopeMode = useSearchStore((s) => s.scopeMode)
    const [live] = useLiveCounts()
    const itemsKey = items.map((i) => i.id).join(',')
    const [state, setState] = useState<{ key: string; counts: Map<string, CountState>; status: CountsStatus }>(
        { key: '', counts: new Map(), status: 'idle' })

    const unavailable = !remote || (!!viewId && !!refused.get(remote)?.has(viewId))

    useEffect(() => {
        if (!live || !remote || !viewId || !enabled || unavailable || items.length === 0) return
        const { key: scopeKey, urns } = scopeKeyOf(viewId)
        const runKey = `${scopeKey}|${itemsKey}`
        if (scopeMode === 'visible' && urns > VISIBLE_URNS_MAX) return
        const known = cacheFor(remote, scopeKey)
        const now = Date.now()
        const fromCache = new Map<string, CountState>()
        for (const item of items) {
            const c = known.get(item.id)
            if (c && now - c.at < TTL_MS) fromCache.set(item.id, { count: c.count, complete: c.complete })
        }
        const missing = items.filter((i) => !fromCache.has(i.id))
        // A deferred update: the cached answer shows on the next tick, never
        // inside this effect's own render pass.
        const shown = setTimeout(() => setState({ key: runKey, counts: fromCache,
            status: missing.length ? 'counting' : 'done' }), 0)
        if (missing.length === 0) return () => clearTimeout(shown)

        const controller = new AbortController()
        const timer = setTimeout(() => {
            const merge = (got: ReadonlyMap<string, RuleCount>) => {
                if (controller.signal.aborted) return
                const counts = new Map(fromCache)
                for (const [id, c] of got) {
                    counts.set(id, { count: c.count, complete: c.complete, ...(c.error ? { error: c.error } : {}) })
                }
                setState({ key: runKey, counts, status: 'counting' })
            }
            countRules(remote, viewId, missing, {
                signal: controller.signal,
                scope: currentScope(viewId),
                purpose: 'search',
                maxRequests: rough ? 2 : undefined,
                onUpdate: merge,
            }).then((got) => {
                if (controller.signal.aborted) return
                const at = Date.now()
                for (const [id, c] of got) {
                    if (c.complete && !c.error) known.set(id, { count: c.count, complete: true, at })
                }
                merge(got)
                setState((s) => (s.key === runKey ? { ...s, status: 'done' } : s))
            }).catch((err: unknown) => {
                if (controller.signal.aborted) return
                const status = httpStatusOf(err)
                if (status === 403 || status === 501) {
                    let views = refused.get(remote)
                    if (!views) refused.set(remote, (views = new Set()))
                    views.add(viewId)
                    setState({ key: runKey, counts: new Map(), status: 'unavailable' })
                    return
                }
                setState((s) => (s.key === runKey ? { ...s, status: 'done' } : s))
            })
        }, debounceMs)
        return () => {
            clearTimeout(shown)
            clearTimeout(timer)
            controller.abort()
        }
    // ``items`` is read through ``itemsKey``: the same ids are the same counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remote, viewId, itemsKey, scopeMode, enabled, rough, debounceMs, unavailable, live])

    return useMemo(() => {
        if (unavailable) return { counts: new Map(), status: 'unavailable' as const }
        if (!live) return { counts: new Map(), status: 'off' as const }
        if (!viewId || !enabled || items.length === 0) return { counts: new Map(), status: 'idle' as const }
        return { counts: state.counts, status: state.status }
    }, [unavailable, live, viewId, enabled, items.length, state])
}
