/**
 * PreferencesPage — how the app works for you, beyond your account.
 *
 * One setting so far: whether the Dashboard shows **Needs attention**, the
 * worst open profiling findings. It is off by default, because the Dashboard is
 * where business users land; the people who look after data sources turn it on
 * here.
 *
 * Preferences live in this browser (the preferences store persists locally),
 * and the page says so rather than implying they follow you to another device.
 */
import { AlertTriangle, LayoutDashboard } from 'lucide-react'

import { AccountCard, AccountShell } from '@/components/account/AccountShell'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { usePreferencesStore } from '@/store/preferences'

export function PreferencesPage() {
    useDocumentTitle('Preferences')
    const showNeedsAttention = usePreferencesStore((s) => s.showNeedsAttention)
    const setShowNeedsAttention = usePreferencesStore((s) => s.setShowNeedsAttention)
    const canReadProfiling = useCanReadProfiling()

    return (
        <AccountShell title="Preferences" blurb="How the app works for you. Saved in this browser.">
            <AccountCard icon={LayoutDashboard} title="Dashboard" blurb="What your Dashboard shows besides your own work.">
                <div className="flex items-start justify-between gap-4">
                    <label htmlFor="pref-needs-attention" className="min-w-0 cursor-pointer">
                        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                            <AlertTriangle className="w-4 h-4 text-rose-500" aria-hidden />
                            Needs attention
                        </span>
                        <span className="block text-xs text-ink-muted mt-1 max-w-xl">
                            The worst open profiling findings — a source far outside its usual
                            movement, an entity type that vanished, a source gone quiet — each with
                            Open and Mark seen. For people who look after data sources.
                        </span>
                        {!canReadProfiling && (
                            <span className="block text-xs text-amber-600 dark:text-amber-400 mt-1.5">
                                You can’t see profiling results, so there would be nothing to show.
                            </span>
                        )}
                    </label>
                    <ToggleSwitch
                        id="pref-needs-attention"
                        size="sm"
                        aria-label="Show Needs attention on the Dashboard"
                        checked={showNeedsAttention}
                        onChange={setShowNeedsAttention}
                        disabled={!canReadProfiling}
                    />
                </div>
            </AccountCard>
        </AccountShell>
    )
}
