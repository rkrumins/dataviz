/**
 * Feature-flag route guard — hides a whole route when an admin has turned the
 * backing feature off (companion to RequireNav, which gates on permissions).
 *
 * Redirects rather than rendering a denied panel: a disabled feature should
 * feel absent, not forbidden — deep links and stale bookmarks land somewhere
 * useful instead of a dead end.
 */
import type { ReactNode } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useFeature } from '@/store/features'

interface RequireFeatureProps {
    /** Flag key in the features store (e.g. ``versioningEnabled``). */
    feature: string
    /** Where to send the user when the feature is off (default: home).
     *  ``:param`` tokens are filled from the current route params, so a
     *  child route can redirect to its parent (e.g. ``/workspaces/:wsId``). */
    redirectTo?: string
    children: ReactNode
}

export function RequireFeature({ feature, redirectTo = '/', children }: RequireFeatureProps) {
    const enabled = useFeature(feature)
    const params = useParams()
    if (!enabled) {
        const target = redirectTo.replace(
            /:([A-Za-z0-9_]+)/g,
            (_, key: string) => params[key] ?? '',
        )
        return <Navigate to={target} replace />
    }
    return <>{children}</>
}
