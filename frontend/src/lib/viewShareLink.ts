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
import { useToast } from '@/components/ui/toast'

export function buildViewShareUrl(viewId: string): string {
    return `${window.location.origin}/views/${encodeURIComponent(viewId)}`
}

export function useCopyViewLink() {
    const { showToast } = useToast()
    return useCallback(async (viewId: string) => {
        try {
            await navigator.clipboard.writeText(buildViewShareUrl(viewId))
            showToast('success', 'Link copied — anyone the view is shared with can open it')
        } catch {
            showToast('error', 'Couldn’t copy the link')
        }
    }, [showToast])
}
