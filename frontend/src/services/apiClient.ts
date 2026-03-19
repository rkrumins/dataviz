/**
 * Shared authenticated fetch wrapper.
 *
 * Attaches the JWT access token from the auth store to every request.
 * On 401, calls logout() so the user is redirected to /login.
 */

import { useAuthStore } from '@/store/auth'

export async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const token = useAuthStore.getState().accessToken
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const res = await fetch(url, { ...init, headers })

    if (res.status === 401) {
        useAuthStore.getState().logout()
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
