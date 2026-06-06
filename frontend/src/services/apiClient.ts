/**
 * ``authFetch`` — convenience wrapper that calls ``fetchWithTimeout``
 * and parses the response as JSON (or returns ``undefined`` on 204).
 *
 * All of the interesting behaviour — credentialed cookies, CSRF header
 * injection, silent refresh on 401 — lives in ``fetchWithTimeout`` so
 * every service (authFetch callers or not) inherits it uniformly. This
 * module is only here so existing call sites that return parsed JSON
 * don't have to each repeat the ``res.ok`` / ``res.json()`` boilerplate.
 */

import { fetchWithTimeout } from './fetchWithTimeout'
import { useHealthStore } from '@/store/health'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

export async function authFetch<T>(
    url: string,
    init?: RequestInit & { silent403?: boolean },
): Promise<T> {
    let res: Response
    try {
        res = await fetchWithTimeout(url, init)
    } catch (err) {
        // Network / timeout failures should surface to the health store
        // the same way they did previously, so banner + retry UI continue
        // to work unchanged.
        useHealthStore.getState().reportFailure(err)
        throw err
    }

    if (!res.ok) {
        const text = await res.text()
        // Use the shared extractor so every error body — string,
        // FastAPI 422 array, or structured permission envelope —
        // arrives as a friendly string. Previously this file had its
        // own copy of the logic; pulled out to ``@/lib/errorMessage``
        // so authService / ssoAdminService / future services can't
        // silently drift.
        const detail = extractErrorMessageFromText(text, res.statusText)
        if (res.status === 401) throw new Error('Session expired')
        throw new Error(detail)
    }

    if (res.status === 204) return undefined as T
    return res.json()
}
