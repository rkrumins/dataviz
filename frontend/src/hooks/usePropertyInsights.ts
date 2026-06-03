/**
 * usePropertyInsights — lazy, session-cached React hooks over the
 * read-only ``propertyInsights`` service. Each insight is one
 * ``searchAdvanced`` round-trip; hooks only fire when ``enabled`` so the
 * catalogue stays snappy and we pay only for what the user looks at.
 */
import { useEffect, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import {
    getAffectedSample, getCatalogOverview, getValueDistribution,
    type AffectedSample, type CatalogOverview, type ValueDistribution,
} from '@/services/propertyInsights'
import type { Predicate } from '@/types/search'


interface Async<T> { data: T | null; loading: boolean; error: string | null }
const IDLE = { data: null, loading: false, error: null } as const

const distCache = new Map<string, ValueDistribution>()
const overviewCache = new Map<string, CatalogOverview>()


/** Top values of a property key (lazy, cached per ``viewId key``). */
export function useValueDistribution(viewId: string, key: string, enabled: boolean): Async<ValueDistribution> {
    const provider = useGraphProvider()
    const [state, setState] = useState<Async<ValueDistribution>>(IDLE)
    useEffect(() => {
        if (!enabled || !viewId || !key) return
        const ck = `${viewId} ${key}`
        const cached = distCache.get(ck)
        if (cached) { setState({ data: cached, loading: false, error: null }); return }
        const controller = new AbortController()
        setState({ data: null, loading: true, error: null })
        getValueDistribution(provider, viewId, key, 12, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return
                distCache.set(ck, data)
                setState({ data, loading: false, error: null })
            })
            .catch((e: unknown) => {
                if (!controller.signal.aborted) setState({ data: null, loading: false, error: (e as Error).message })
            })
        return () => controller.abort()
    }, [provider, viewId, key, enabled])
    return state
}


/** Sample of entities a predicate matches (lazy, keyed on the predicate). */
export function useAffectedSample(viewId: string, predicate: Predicate | null, enabled: boolean): Async<AffectedSample> {
    const provider = useGraphProvider()
    const [state, setState] = useState<Async<AffectedSample>>(IDLE)
    const predicateKey = predicate ? JSON.stringify(predicate) : ''
    useEffect(() => {
        if (!enabled || !viewId || !predicate) { setState(IDLE); return }
        const controller = new AbortController()
        setState({ data: null, loading: true, error: null })
        getAffectedSample(provider, viewId, predicate, 8, controller.signal)
            .then((data) => { if (!controller.signal.aborted) setState({ data, loading: false, error: null }) })
            .catch((e: unknown) => { if (!controller.signal.aborted) setState({ data: null, loading: false, error: (e as Error).message }) })
        return () => controller.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, viewId, predicateKey, enabled])
    return state
}


/** View-wide entity totals + per-type breakdown (eager, cached per view). */
export function useCatalogOverview(viewId: string): Async<CatalogOverview> {
    const provider = useGraphProvider()
    const [state, setState] = useState<Async<CatalogOverview>>(IDLE)
    useEffect(() => {
        if (!viewId) return
        const cached = overviewCache.get(viewId)
        if (cached) { setState({ data: cached, loading: false, error: null }); return }
        const controller = new AbortController()
        setState({ data: null, loading: true, error: null })
        getCatalogOverview(provider, viewId, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return
                overviewCache.set(viewId, data)
                setState({ data, loading: false, error: null })
            })
            .catch((e: unknown) => { if (!controller.signal.aborted) setState({ data: null, loading: false, error: (e as Error).message }) })
        return () => controller.abort()
    }, [provider, viewId])
    return state
}
