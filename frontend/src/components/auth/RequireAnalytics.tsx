/**
 * Route guard for Analytics — the one section whose door is a permission OR a
 * feature flag, which `RequireNav` cannot express.
 *
 * It shares `useAnalyticsAccess` with the sidebar item on purpose. A guard and
 * a nav entry that compute visibility separately drift, and the drift is only
 * ever noticed as a bug report: "the menu shows Analytics and clicking it says
 * I can't have it."
 *
 * The refusal explains the actual reason. A generic "you need this permission"
 * panel would be wrong here — nobody is missing a permission, an operator has
 * chosen not to open the section to everyone, and telling someone to go and
 * request `system:audit:read` would send them to ask for the wrong thing.
 */
import type { ReactNode } from 'react'
import { BarChart3, Lock } from 'lucide-react'

import { GuardSkeleton } from '@/components/auth/RequirePermission'
import { usePermissionsReady } from '@/store/auth'
import { useAnalyticsAccess } from '@/hooks/useAnalyticsAccess'

export function RequireAnalytics({ children }: { children: ReactNode }) {
    const ready = usePermissionsReady()
    const { allowed, pending } = useAnalyticsAccess()

    // Claims or flags still in flight. Un-hydrated is indistinguishable from a
    // real denial when read off either slice alone, so wait for the answer
    // rather than flashing a refusal at someone who does have access.
    if (!ready || pending) return <GuardSkeleton />
    if (allowed) return <>{children}</>

    return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
            <div className="max-w-sm text-center">
                <div className="relative w-16 h-16 mx-auto mb-5">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/0 border border-indigo-500/20 flex items-center justify-center">
                        <BarChart3 className="w-7 h-7 text-indigo-500" />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-xl bg-canvas-elevated border border-glass-border flex items-center justify-center shadow-sm">
                        <Lock className="w-3.5 h-3.5 text-ink-muted" />
                    </div>
                </div>
                <h2 className="text-base font-bold text-ink mb-1.5">
                    Analytics isn't open on this deployment
                </h2>
                <p className="text-sm text-ink-muted leading-relaxed">
                    Platform insights are currently limited to administrators and
                    auditors. An administrator can open a redacted version to
                    everyone under Admin → Features.
                </p>
                <p className="text-xs text-ink-muted/80 mt-3">
                    Nothing is missing from your account — this is a deployment
                    setting, not a permission.
                </p>
            </div>
        </div>
    )
}
