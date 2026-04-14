/**
 * Shared authenticated fetch wrapper.
 *
 * Attaches the JWT access token from the auth store to every request.
 * On 401, marks the session as expired so the UI can prompt re-auth
 * without nuking the current page state.
 *
 * Concurrent 401s (e.g. admin page mount with parallel fetches + the banner
 * poll) are queued: only one overlay shows, and each failed request is
 * transparently retried with the fresh token once the user re-authenticates.
 * This prevents the double-prompt where a stale in-flight 401 re-triggers the
 * overlay after a successful re-auth.
 */

import { useAuthStore } from '@/store/auth'
import { useHealthStore } from '@/store/health'

type Waiter = { resolve: () => void; reject: (err: unknown) => void }

let reauthWaiters: Waiter[] = []
let storeSubscribed = false

function ensureStoreSubscribed() {
    if (storeSubscribed) return
    storeSubscribed = true
    useAuthStore.subscribe((state, prev) => {
        // Re-auth succeeded: flush queued requests to retry with the new token.
        if (
            prev.sessionExpired &&
            !state.sessionExpired &&
            state.isAuthenticated &&
            state.accessToken
        ) {
            const waiters = reauthWaiters
            reauthWaiters = []
            waiters.forEach(w => w.resolve())
        }
        // User signed out (either from the overlay or elsewhere): reject queued
        // requests so callers can unwind cleanly instead of hanging forever.
        if (prev.isAuthenticated && !state.isAuthenticated) {
            const waiters = reauthWaiters
            reauthWaiters = []
            waiters.forEach(w => w.reject(new Error('Signed out')))
        }
    })
}

/**
 * Merge multiple AbortSignals into one that aborts if any input aborts.
 * Prefers the native AbortSignal.any() when available; falls back to a
 * manual listener chain for older runtimes.
 */
function mergeSignals(signals: AbortSignal[]): AbortSignal {
    const filtered = signals.filter((s): s is AbortSignal => !!s)
    if (filtered.length === 1) return filtered[0]
    const anyFn = (AbortSignal as { any?: (sigs: AbortSignal[]) => AbortSignal }).any
    if (typeof anyFn === 'function') return anyFn(filtered)
    const controller = new AbortController()
    for (const s of filtered) {
        if (s.aborted) {
            controller.abort((s as { reason?: unknown }).reason)
            break
        }
        s.addEventListener('abort', () => controller.abort((s as { reason?: unknown }).reason), { once: true })
    }
    return controller.signal
}

export async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
    ensureStoreSubscribed()

    const doRequest = async (): Promise<T> => {
        const requestToken = useAuthStore.getState().accessToken
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(init?.headers as Record<string, string>),
        }
        if (requestToken) {
            headers['Authorization'] = `Bearer ${requestToken}`
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 6_000)
        const signal = init?.signal
            ? mergeSignals([controller.signal, init.signal])
            : controller.signal

        let res: Response
        try {
            res = await fetch(url, { ...init, headers, signal })
        } catch (err) {
            clearTimeout(timer)
            if (err instanceof DOMException && err.name === 'AbortError') {
                const timeoutErr = new Error('Request timed out')
                useHealthStore.getState().reportFailure(timeoutErr)
                throw timeoutErr
            }
            useHealthStore.getState().reportFailure(err)
            throw err
        }
        clearTimeout(timer)

        if (res.status === 401) {
            const store = useAuthStore.getState()

            // Stale 401: the token rotated while this request was in flight,
            // so the user already re-authenticated. Retry silently.
            if (store.accessToken && store.accessToken !== requestToken) {
                return doRequest()
            }

            // Genuine expiry. Show the overlay at most once regardless of how
            // many concurrent requests are currently failing.
            if (!store.sessionExpired) {
                store.expireSession()
            }

            // Wait for the user to re-authenticate (or sign out), then retry.
            await new Promise<void>((resolve, reject) => {
                reauthWaiters.push({ resolve, reject })
            })
            return doRequest()
        }

        if (!res.ok) {
            const text = await res.text()
            let detail = res.statusText
            try {
                const body = JSON.parse(text)
                detail = body.detail || JSON.stringify(body)
            } catch {
                detail = text || res.statusText
            }
            throw new Error(detail)
        }

        if (res.status === 204) return undefined as T
        return res.json()
    }

    return doRequest()
}
