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
import { readJsonLossless } from '@/lib/losslessJson'

/** The request + failure handling every helper here shares: a failure
 *  throws a readable Error, success hands back the Response. */
async function checkedFetch(
    url: string,
    init?: RequestInit & { silent403?: boolean },
): Promise<Response> {
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
    return res
}

export async function authFetch<T>(
    url: string,
    init?: RequestInit & { silent403?: boolean },
): Promise<T> {
    const res = await checkedFetch(url, init)
    if (res.status === 204) return undefined as T
    return readJsonLossless<T>(res)
}

/**
 * One page of a list endpoint that reports its full size in
 * ``X-Total-Count`` (``GET /admin/users``, ``GET /admin/workspaces?limit=``).
 * A server that doesn't send the header yields the page length, so a pager
 * degrades to "what we can see" instead of breaking — the same fallback as
 * ``workspaceService.listPage``.
 */
export async function authFetchPage<T>(url: string): Promise<{ items: T[]; total: number }> {
    const res = await checkedFetch(url)
    const items: T[] = await readJsonLossless<T[]>(res)
    const header = res.headers.get('X-Total-Count')
    return { items, total: header ? Number(header) : items.length }
}
