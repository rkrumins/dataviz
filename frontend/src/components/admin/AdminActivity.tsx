/**
 * Admin → Activity: the platform's activity, for the people who audit it.
 *
 * Replaces the RBAC-only audit log. Same route (`/admin/audit`), same gate
 * (`system:audit:read`), but every recorded change — operations, access,
 * identity, data, content and platform settings — with who did it, where and
 * the reason they gave.
 */
import { AlertCircle, History } from 'lucide-react'

import { PageContainer } from '@/components/layout/PageContainer'
import { ActivityExplorer } from '@/components/activity/ActivityExplorer'
import { usePermission } from '@/store/auth'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

const PLATFORM = { kind: 'platform' } as const

export function AdminActivity() {
    const canRead = usePermission('system:audit:read')
    useDocumentTitle('Activity')

    if (!canRead) {
        return (
            <div className="p-6">
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-semibold text-ink">Activity requires audit access</p>
                        <p className="text-xs text-ink-muted mt-1">
                            The activity log records who changed what across the platform, including
                            role and permission changes, and requires audit read access
                            (<code className="font-mono">system:audit:read</code>).
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <PageContainer gutter="shell" className="py-8 space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shrink-0">
                    <History className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-ink">Activity</h1>
                    <p className="text-sm text-ink-muted">
                        Who did what, where and why — every recorded change across the platform.
                    </p>
                </div>
            </div>
            <ActivityExplorer scope={PLATFORM} />
        </PageContainer>
    )
}
