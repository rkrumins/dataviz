/**
 * useProviderHealthSweep — bounded, abortable provider health probing.
 *
 * Replaces the naive `providers.forEach(p => testProvider(p.id))` stampede
 * that used to fire N unbounded, unabortable POSTs per mount. Known pain:
 * when a single provider hung, every subsequent probe piled a 10s-held DB
 * session onto the backend and the page froze.
 *
 * Guarantees:
 *  - At most `concurrency` probes in flight at once.
 *  - Each probe gets its own AbortController with `perCallTimeoutMs`.
 *  - Dead providers are short-circuited by `getCircuitBreaker` after
 *    three consecutive failures, skipping the network entirely until the
 *    breaker transitions to half-open.
 *  - The initial sweep fires exactly once per mount; resets per provider
 *    set identity.
 *  - Unmount aborts every in-flight probe.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { getCircuitBreaker } from '@/services/circuitBreaker'

export type HealthStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown'

export interface ProviderHealth {
    status: HealthStatus
    latencyMs?: number
    error?: string
}

export interface UseProviderHealthSweepOptions {
    concurrency?: number
    perCallTimeoutMs?: number
}

const DEFAULT_CONCURRENCY = 3
const DEFAULT_PER_CALL_TIMEOUT_MS = 8_000

export function useProviderHealthSweep(
    providers: ProviderResponse[],
    options: UseProviderHealthSweepOptions = {},
) {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    const perCallTimeoutMs = options.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS

    const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({})
    const inflightControllers = useRef<Map<string, AbortController>>(new Map())
    const initialSweepDone = useRef(false)

    const runProbe = useCallback(async (id: string): Promise<void> => {
        const breaker = getCircuitBreaker('provider', id)
        if (!breaker.canRequest()) {
            setHealthMap(prev => ({
                ...prev,
                [id]: { status: 'unhealthy', error: 'Circuit open — skipping probe until provider recovers' },
            }))
            return
        }

        // If an earlier probe for this provider is still in flight, cancel it
        // before starting a new one — the caller wants fresh data.
        const previous = inflightControllers.current.get(id)
        if (previous) previous.abort()

        const controller = new AbortController()
        inflightControllers.current.set(id, controller)
        const timer = setTimeout(() => controller.abort(), perCallTimeoutMs)

        setHealthMap(prev => ({ ...prev, [id]: { status: 'checking' } }))

        try {
            const result = await providerService.test(id, {
                signal: controller.signal,
                timeoutMs: perCallTimeoutMs,
            })
            if (controller.signal.aborted) return
            if (result.success) breaker.recordSuccess()
            else breaker.recordFailure()
            setHealthMap(prev => ({
                ...prev,
                [id]: {
                    status: result.success ? 'healthy' : 'unhealthy',
                    latencyMs: result.latencyMs,
                    error: result.error,
                },
            }))
        } catch (err) {
            if (controller.signal.aborted) return
            breaker.recordFailure()
            const message = err instanceof Error ? err.message : 'Provider health check failed'
            setHealthMap(prev => ({ ...prev, [id]: { status: 'unhealthy', error: message } }))
        } finally {
            clearTimeout(timer)
            if (inflightControllers.current.get(id) === controller) {
                inflightControllers.current.delete(id)
            }
        }
    }, [perCallTimeoutMs])

    const runSweep = useCallback(async (ids: string[]): Promise<void> => {
        // Simple in-file semaphore — avoids pulling in p-limit for ~15 lines.
        const queue = [...ids]
        const workers: Promise<void>[] = []
        const next = async (): Promise<void> => {
            while (queue.length > 0) {
                const id = queue.shift()!
                await runProbe(id)
            }
        }
        for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
            workers.push(next())
        }
        await Promise.allSettled(workers)
    }, [concurrency, runProbe])

    const refresh = useCallback((): Promise<void> => {
        return runSweep(providers.map(p => p.id))
    }, [providers, runSweep])

    // Initial sweep — fires once per mount when providers first arrive.
    useEffect(() => {
        if (initialSweepDone.current) return
        if (providers.length === 0) return
        initialSweepDone.current = true
        void runSweep(providers.map(p => p.id))
    }, [providers, runSweep])

    // Cleanup — abort anything in flight on unmount.
    useEffect(() => {
        return () => {
            inflightControllers.current.forEach(c => c.abort())
            inflightControllers.current.clear()
        }
    }, [])

    const setHealth = useCallback((id: string, health: ProviderHealth): void => {
        setHealthMap(prev => ({ ...prev, [id]: health }))
    }, [])

    return {
        healthMap,
        testOne: runProbe,
        refresh,
        setHealth,
    }
}
