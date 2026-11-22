/**
 * usePropertyInsights — lazy, session-cached React hooks over the
 * read-only ``propertyInsights`` service. Each insight is one
 * ``searchAdvanced`` round-trip; hooks only fire when ``enabled`` so the
 * catalogue stays snappy and we pay only for what the user looks at.
 */
import { useEffect, useState } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { getValueDistribution, type ValueDistribution } from '@/services/propertyInsights'


interface Async<T> { data: T | null; loading: boolean; error: string | null }
const IDLE = { data: null, loading: false, error: null } as const

const distCache = new Map<string, ValueDistribution>()


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
