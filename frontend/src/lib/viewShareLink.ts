/**
 * The one way to build and copy a view's share link. Two surfaces
 * (ShareViewDialog and the Explorer's bare copy action) each rolled
 * their own; a changed URL shape would have had to be fixed twice.
 *
 * `/views/{id}` is deliberately flat — no workspace in the path — so
 * the same link works for members and for people the view is shared
 * with (the backend authorizes by view, not by membership).
 */
import { useCallback } from 'react'
import { useAppNotifications } from '@/components/ui/notifications'

export function buildViewShareUrl(viewId: string): string {
    return `${window.location.origin}/views/${encodeURIComponent(viewId)}`
}

export function useCopyViewLink() {
    const { notify } = useAppNotifications()
    return useCallback(async (viewId: string) => {
        try {
            await navigator.clipboard.writeText(buildViewShareUrl(viewId))
            notify('success', 'Link copied — anyone the view is shared with can open it')
        } catch {
            notify('error', 'Couldn’t copy the link')
        }
    }, [notify])
}

/**
 * A view link that opens on something: `focus` reveals an entity (`?focus=<urn>`), `search` opens
 * Advanced Search with a query in it (`?search=<base64url JSON>`). The canvas reads both on its
 * first render, as it does `?trace=`, and never trusts them: a malformed or invalid one is ignored.
 */
export function buildViewLink(viewId: string, opens: { focus?: string; search?: unknown } = {}): string {
    const url = new URL(buildViewShareUrl(viewId))
    if (opens.focus) url.searchParams.set('focus', opens.focus)
    if (opens.search !== undefined) url.searchParams.set('search', encodeSearchParam(opens.search))
    return url.toString()
}

/** UTF-8-safe base64url of the JSON — names and values can carry any unicode. */
export function encodeSearchParam(predicate: unknown): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(predicate))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The JSON text a `?search=` carries, or null when it is not base64url of UTF-8 at all. */
export function decodeSearchParam(raw: string): string | null {
    try {
        const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return null
    }
}
