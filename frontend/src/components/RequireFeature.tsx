/**
 * Feature-flag route guard — hides a whole route when an admin has turned the
 * backing feature off (companion to RequireNav, which gates on permissions).
 *
 * By default it REDIRECTS rather than rendering a panel: a disabled feature
 * should feel absent, not forbidden — deep links and stale bookmarks land
 * somewhere useful instead of a dead end.
 *
 * Opt into `explain` when the user plausibly *expected* the feature (they
 * followed a link to it): instead of a silent redirect, render a short
 * "this is turned off" panel that says why and links to the guide — teaching
 * in place instead of bouncing them home.
 */
import type { ReactNode } from 'react'
import { Navigate, Link, useParams } from 'react-router-dom'
import { PowerOff, ArrowLeft } from 'lucide-react'
import { useFeature } from '@/store/features'
import { DocsLink } from '@/components/help/DocsLink'

interface RequireFeatureProps {
    /** Flag key in the features store (e.g. ``versioningEnabled``). */
    feature: string
    /** Where to send the user when the feature is off (default: home).
     *  ``:param`` tokens are filled from the current route params, so a
     *  child route can redirect to its parent (e.g. ``/workspaces/:wsId``). */
    redirectTo?: string
    /** Render an explainer panel instead of redirecting. */
    explain?: boolean
    /** Explainer copy (only used with ``explain``). */
    title?: string
    message?: string
    /** Guide slug linked from the explainer (only used with ``explain``). */
    guideSlug?: string
    children: ReactNode
}

export function RequireFeature({
    feature,
    redirectTo = '/',
    explain = false,
    title,
    message,
    guideSlug,
    children,
}: RequireFeatureProps) {
    const enabled = useFeature(feature)
    const params = useParams()

    if (enabled) return <>{children}</>

    if (explain) {
        return (
            <div className="flex min-h-[60vh] items-center justify-center p-8">
                <div className="max-w-md text-center">
                    <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.05]">
                        <PowerOff className="h-6 w-6 text-ink-muted" />
                    </div>
                    <h2 className="text-base font-bold text-ink">
                        {title ?? 'This feature is turned off'}
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                        {message ??
                            'An administrator has disabled this capability for your deployment. Ask an admin to enable it if you need it.'}
                    </p>
                    <div className="mt-4 flex flex-col items-center gap-3">
                        {guideSlug && <DocsLink slug={guideSlug} />}
                        <Link
                            to="/"
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors"
                        >
                            <ArrowLeft className="h-3.5 w-3.5" /> Back to dashboard
                        </Link>
                    </div>
                </div>
            </div>
        )
    }

    const target = redirectTo.replace(
        /:([A-Za-z0-9_]+)/g,
        (_, key: string) => params[key] ?? '',
    )
    return <Navigate to={target} replace />
}
