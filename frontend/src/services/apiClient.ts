/**
 * Shared authenticated fetch wrapper.
 *
 * Attaches the JWT access token from the auth store to every request.
 * On 401, marks the session as expired so the UI can prompt re-auth
 * without nuking the current page state.
 */

import { useAuthStore } from '@/store/auth'
import { useHealthStore } from '@/store/health'

export async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const token = useAuthStore.getState().accessToken
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6_000)

    let res: Response
    try {
        res = await fetch(url, { ...init, headers, signal: controller.signal })
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
        useAuthStore.getState().expireSession()
        throw new Error('Session expired — please log in again.')
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
