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

export async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
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
        let detail = res.statusText
        try {
            const body = JSON.parse(text)
            detail = body.detail || JSON.stringify(body)
        } catch {
            detail = text || res.statusText
        }
        if (res.status === 401) throw new Error('Session expired')
        throw new Error(detail)
    }

    if (res.status === 204) return undefined as T
    return res.json()
}
