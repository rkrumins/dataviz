/**
 * What everyone ELSE sees — shown only to the people who decide it.
 *
 * An administrator configuring the three analytics settings has no way to tell
 * what the result actually looks like without signing in as somebody else.
 * That is how a disclosure setting drifts: it is changed once, never verified,
 * and nobody notices for a year.
 *
 * So the page states the current posture back to the operator, in the same
 * words the settings use, wherever they are already looking. Read-only and
 * unobtrusive — it is a status line, not a control, and the control is one
 * click away where it belongs.
 *
 * Invisible to everyone who is not privileged: for them it would be a
 * description of their own limits, which the redaction notice already gives
 * them in the second person.
 */
import { Link } from 'react-router-dom'
import { Eye, EyeOff, Settings2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import {
    ANALYTICS_PRIVACY_FLAG, ANALYTICS_PUBLIC_FLAG, ANALYTICS_WORKSPACE_FLAG,
    useAnalyticsAccess,
} from '@/hooks/useAnalyticsAccess'
import { useFeaturesStore } from '@/store/features'

const MODE_LABELS: Record<string, string> = {
    strict: 'counts and trends only — nobody is named',
    internal: 'colleagues are named',
    full: 'colleagues and operational health',
}

export function PublicPosture({ className }: { className?: string }) {
    const { privileged } = useAnalyticsAccess()
    const isPublic = useFeature(ANALYTICS_PUBLIC_FLAG)
    const allWorkspaces = useFeature(ANALYTICS_WORKSPACE_FLAG)
    const mode = useFeaturesStore(
        (s) => s.values[ANALYTICS_PRIVACY_FLAG],
    )

    // Only the people who can change it need to be told what it is.
    if (!privileged) return null

    const summary = !isPublic
        ? 'Only administrators and auditors can open Analytics.'
        : `Everyone can open Analytics: ${
            MODE_LABELS[String(mode)] ?? MODE_LABELS.strict
        }, and ${
            allWorkspaces
                ? 'every workspace is named'
                : 'workspaces follow the usual permissions'
        }.`

    return (
        <div
            className={cn(
                'flex flex-wrap items-center gap-2 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2',
                className,
            )}
        >
            <span
                className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg',
                    isPublic
                        ? 'bg-indigo-500/10 text-indigo-500'
                        : 'bg-black/5 text-ink-muted dark:bg-white/10',
                )}
            >
                {isPublic ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            </span>
            <p className="min-w-0 flex-1 text-[11px] text-ink-muted">
                <span className="font-semibold text-ink-secondary">Visibility · </span>
                {summary}
            </p>
            <Link
                to="/admin/features"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-ink-muted outline-none transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-indigo-500/50"
            >
                <Settings2 className="h-3 w-3" /> Change
            </Link>
        </div>
    )
}
