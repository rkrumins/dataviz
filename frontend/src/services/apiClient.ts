/**
 * Authenticated fetch wrapper.
 *
 * Session lives in HttpOnly cookies set by the backend, so every call
 * uses ``credentials: 'include'`` (the cookies are otherwise stripped
 * for cross-origin requests). For state-changing methods we forward
 * the CSRF token from the readable ``nx_csrf`` cookie as the
 * ``X-CSRF-Token`` header — the double-submit comparison is what proves
 * the request was initiated by a same-origin script.
 *
 * On 401 we attempt a single transparent ``POST /auth/refresh``. If it
 * succeeds the original request is retried with the rotated cookies;
 * if it fails the auth store is moved to ``unauthenticated`` and the
 * caller's promise rejects with ``Error("Session expired")``. Concurrent
 * 401s share a single in-flight refresh — the other requests wait on
 * the same promise rather than spawning duplicate refreshes.
 */

import { useAuthStore } from '@/store/auth'
import { useHealthStore } from '@/store/health'
import { authService } from '@/services/authService'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CSRF_COOKIE = 'nx_csrf'
const CSRF_HEADER = 'X-CSRF-Token'

function readCookie(name: string): string | null {
    if (typeof document === 'undefined') return null
    const prefix = `${name}=`
    for (const part of document.cookie.split(';')) {
        const trimmed = part.trim()
        if (trimmed.startsWith(prefix)) {
            return decodeURIComponent(trimmed.slice(prefix.length))
        }
    }
    return null
}

/** Single in-flight refresh promise — concurrent 401s wait on it instead
 *  of each spawning their own refresh. Cleared when the refresh resolves. */
let refreshInFlight: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
        try {
            await authService.refresh()
            return true
        } catch {
            return false
        } finally {
            // Run on the next tick so concurrent waiters share this result
            // before a brand-new refresh can start.
            queueMicrotask(() => { refreshInFlight = null })
        }
    })()
    return refreshInFlight
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
    const method = (init?.method ?? 'GET').toUpperCase()

    const doRequest = async (allowRefreshRetry: boolean): Promise<T> => {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(init?.headers as Record<string, string>),
        }
        if (!SAFE_METHODS.has(method)) {
            const csrf = readCookie(CSRF_COOKIE)
            if (csrf) headers[CSRF_HEADER] = csrf
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 6_000)
        const signal = init?.signal
            ? mergeSignals([controller.signal, init.signal])
            : controller.signal

        let res: Response
        try {
            res = await fetch(url, {
                ...init,
                method,
                headers,
                credentials: 'include',
                signal,
            })
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

        if (res.status === 401 && allowRefreshRetry) {
            const refreshed = await tryRefresh()
            if (refreshed) return doRequest(false)
            useAuthStore.getState().handleSessionLost()
            throw new Error('Session expired')
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

    return doRequest(true)
}
