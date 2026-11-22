/**
 * PreferencesPage — how the app works for you, beyond your account.
 *
 * Whether the Dashboard shows **Needs attention**, the worst open profiling
 * findings. It is off by default, because the Dashboard is where business users
 * land; the people who look after data sources turn it on here.
 *
 * Whether selecting an entity opens its details, for each view: on in the
 * Technical view, which inspects as it clicks, and off in the Business view,
 * where details open when asked for (Details, Enter, the context menu).
 *
 * The depth a new lineage trace opens on, each way: one hop by default, what an
 * entity feeds and what feeds it; up to every hop the trace walks.
 *
 * Preferences live in this browser (the preferences store persists locally),
 * and the page says so rather than implying they follow you to another device.
 */
import { AlertTriangle, ArrowDown, ArrowUp, Briefcase, Code2, LayoutDashboard, PanelRightOpen, Workflow } from 'lucide-react'

import { AccountCard, AccountShell } from '@/components/account/AccountShell'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { FULL_WALK_INITIAL_DEPTH } from '@/hooks/useLensWalk'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { usePreferencesStore } from '@/store/preferences'

export function PreferencesPage() {
    useDocumentTitle('Preferences')
    const showNeedsAttention = usePreferencesStore((s) => s.showNeedsAttention)
    const setShowNeedsAttention = usePreferencesStore((s) => s.setShowNeedsAttention)
    const canReadProfiling = useCanReadProfiling()
    const openDetailsOnSelect = usePreferencesStore((s) => s.openDetailsOnSelect)
    const setOpenDetailsOnSelect = usePreferencesStore((s) => s.setOpenDetailsOnSelect)
    const traceDepth = usePreferencesStore((s) => s.defaultTraceDepth)
    const setTraceDepth = usePreferencesStore((s) => s.setDefaultTraceDepth)

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

            <AccountCard icon={PanelRightOpen} title="Entity details"
                         blurb="Whether selecting an entity on a canvas opens its details beside it. Open details always follow what you select.">
                <div className="space-y-4">
                    {([
                        ['business', Briefcase, 'In the Business view', 'Off by default: a click picks an entity out, and Details (or Enter) opens it.'],
                        ['technical', Code2, 'In the Technical view', 'On by default: the details follow every click.'],
                    ] as const).map(([mode, Icon, label, hint]) => (
                        <div key={mode} className="flex items-start justify-between gap-4">
                            <label htmlFor={`pref-details-${mode}`} className="min-w-0 cursor-pointer">
                                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                                    <Icon className="w-4 h-4 text-ink-muted" aria-hidden />
                                    {label}
                                </span>
                                <span className="block text-xs text-ink-muted mt-1 max-w-xl">{hint}</span>
                            </label>
                            <ToggleSwitch
                                id={`pref-details-${mode}`}
                                size="sm"
                                aria-label={`Open details when selecting an entity, ${label.toLowerCase()}`}
                                checked={openDetailsOnSelect[mode]}
                                onChange={(on) => setOpenDetailsOnSelect(mode, on)}
                            />
                        </div>
                    ))}
                </div>
            </AccountCard>

            <AccountCard icon={Workflow} title="Lineage trace"
                         blurb="How many hops a new trace opens on, each way. Any trace can go further; a shared link opens on its sender's.">
                <div className="grid gap-4 sm:grid-cols-2">
                    {([
                        ['up', ArrowUp, 'Upstream', 'What feeds it (Root Cause)', 'text-lineage-in'],
                        ['down', ArrowDown, 'Downstream', 'What it feeds (Impact)', 'text-lineage-out'],
                    ] as const).map(([side, Icon, label, hint, tint]) => {
                        const hops = traceDepth[side]
                        return (
                            <div key={side}>
                                <label htmlFor={`pref-trace-${side}`} className="flex items-center gap-2 text-sm font-semibold text-ink">
                                    <Icon className={`w-4 h-4 ${tint}`} aria-hidden />
                                    {label}
                                </label>
                                <span className="block text-xs text-ink-muted mt-1">{hint}</span>
                                <div className="mt-2 flex items-center gap-2">
                                    <input
                                        id={`pref-trace-${side}`}
                                        type="number"
                                        min={0}
                                        max={FULL_WALK_INITIAL_DEPTH}
                                        value={hops}
                                        onChange={(e) => {
                                            if (e.target.value === '') return
                                            const n = Math.max(0, Math.min(FULL_WALK_INITIAL_DEPTH, Math.round(Number(e.target.value))))
                                            if (Number.isFinite(n)) setTraceDepth({ ...traceDepth, [side]: n })
                                        }}
                                        className="w-20 px-2.5 py-1.5 rounded-lg border border-glass-border bg-transparent text-sm text-ink tabular-nums focus:outline-none focus:border-accent-lineage"
                                    />
                                    <span className="text-xs text-ink-muted">
                                        {hops === 0 ? 'Hidden' : hops >= FULL_WALK_INITIAL_DEPTH ? 'Every hop'
                                            : hops === 1 ? 'hop' : 'hops'}
                                    </span>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </AccountCard>
        </AccountShell>
    )
}
