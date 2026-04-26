/**
 * RefreshControl — Provider-level refresh affordance for RegistryAssets.
 *
 * Visual stack (left → right):
 *   1. Cadence pill: "Auto · every 30m"          (configured interval)
 *   2. Last-refresh-ago: "· last refresh 4m ago" (from /discovery/status)
 *   3. Refresh button:  "Refresh"                (force-refreshes this provider)
 *   4. Overflow caret:  ⋯                        (advanced ops actions)
 *
 * Behaviour:
 *  - Primary click force-refreshes every cached asset for the selected
 *    provider, then reloads the asset list. Same logic as the previous
 *    plain "Refresh" button — wrapped here for richer presentation.
 *  - The overflow menu offers one extra ops action: "Run discovery tick
 *    now" — fires `POST /admin/insights/discovery/trigger`, which kicks
 *    the global scheduler immediately. Useful for verifying scheduler
 *    wiring or after a bulk provider edit.
 *  - During in-flight work, the spinner overlays the icon, the button
 *    stays mounted (no layout shift), and the rest of the control
 *    remains interactive (the overflow menu, etc).
 *
 * The component is purely presentational + delegates the heavy lifting
 * to the parent: the parent owns `onRefreshProvider` so it can sequence
 * the refresh + listAssets + cache invalidation in one place.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { RefreshCw, MoreHorizontal, Zap, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { useDiscoveryStatus } from '@/hooks/useDiscoveryStatus'
import { useInsightsConfig } from '@/hooks/useInsightsConfig'
import { insightsAdminService } from '@/services/insightsAdminService'

interface RefreshControlProps {
    /** Force-refresh every cached asset for the currently selected provider.
     *  Parent sequences: enqueue → invalidate React Query → reload listAssets. */
    onRefreshProvider: () => Promise<void> | void
    /** Disable everything (e.g. while the parent is still loading). */
    disabled?: boolean
    /** Extra classes for the outermost container. */
    className?: string
}

const formatInterval = (secs: number): string => {
    if (secs >= 3600) {
        const h = Math.round((secs / 3600) * 10) / 10
        return `${h}h`
    }
    if (secs >= 60) {
        const m = Math.round(secs / 60)
        return `${m}m`
    }
    return `${secs}s`
}

const formatAgo = (iso: string | null): string | null => {
    if (!iso) return null
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return null
    const ageSecs = Math.max(0, Math.floor((Date.now() - t) / 1000))
    if (ageSecs < 30) return 'just now'
    if (ageSecs < 90) return '1m ago'
    if (ageSecs < 3600) return `${Math.floor(ageSecs / 60)}m ago`
    if (ageSecs < 86400) return `${Math.floor(ageSecs / 3600)}h ago`
    return `${Math.floor(ageSecs / 86400)}d ago`
}

export function RefreshControl({
    onRefreshProvider,
    disabled = false,
    className,
}: RefreshControlProps) {
    const { showToast } = useToast()
    const config = useInsightsConfig()
    const status = useDiscoveryStatus()

    const [refreshing, setRefreshing] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [tickInFlight, setTickInFlight] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    // Click-outside to close the overflow menu.
    useEffect(() => {
        if (!menuOpen) return
        const onClick = (e: MouseEvent) => {
            if (!menuRef.current) return
            if (!menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [menuOpen])

    const lastRefreshAgo = formatAgo(status.data?.last_tick_at ?? null)
    const cadenceLabel = formatInterval(config.discovery_refresh_interval_secs)

    const handlePrimaryRefresh = useCallback(async () => {
        if (refreshing || disabled) return
        setRefreshing(true)
        try {
            await onRefreshProvider()
        } finally {
            setRefreshing(false)
        }
    }, [refreshing, disabled, onRefreshProvider])

    const handleTriggerGlobalTick = useCallback(async () => {
        setMenuOpen(false)
        if (tickInFlight) return
        setTickInFlight(true)
        try {
            const result = await insightsAdminService.triggerDiscoveryTick()
            const enqueued = (result.list_jobs ?? 0) + (result.asset_jobs ?? 0)
            showToast(
                'success',
                `Discovery tick fired — ${enqueued} job(s) enqueued across ${result.providers ?? 0} provider(s).`,
            )
        } catch (err: any) {
            showToast(
                'error',
                `Discovery tick failed: ${err?.message ?? 'unknown error'}`,
            )
        } finally {
            setTickInFlight(false)
        }
    }, [tickInFlight, showToast])

    return (
        <div
            ref={menuRef}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-xl border border-glass-border bg-canvas/60 p-1 pl-2.5',
                className,
            )}
        >
            {/* ── Cadence + last-refresh badge ─────────────────────── */}
            <div
                className="flex items-center gap-1.5 text-[11px] text-ink-muted pr-1"
                title={
                    `Background scheduler runs every ${cadenceLabel}.`
                    + (status.data?.last_tick_at
                        ? ` Last completed tick at ${new Date(status.data.last_tick_at).toLocaleString()}.`
                        : ' No tick has completed yet — the scheduler may still be in its bootstrap delay.')
                    + (status.data && status.data.list_jobs !== null
                        ? ` Last tick enqueued ${(status.data.list_jobs ?? 0) + (status.data.asset_jobs ?? 0)} job(s) across ${status.data.providers ?? 0} provider(s).`
                        : '')
                }
            >
                <Clock className="w-3 h-3 shrink-0" />
                <span className="font-medium">Auto · every {cadenceLabel}</span>
                {lastRefreshAgo && (
                    <span className="text-ink-muted/70">· last {lastRefreshAgo}</span>
                )}
            </div>

            {/* ── Primary refresh button ───────────────────────────── */}
            <button
                onClick={handlePrimaryRefresh}
                disabled={disabled || refreshing}
                title="Force-refresh every asset for this provider now"
                className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold',
                    'text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/20',
                    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                )}
            >
                {refreshing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                )}
                <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>

            {/* ── Overflow menu (advanced ops actions) ─────────────── */}
            <div className="relative">
                <button
                    onClick={() => setMenuOpen(v => !v)}
                    disabled={disabled}
                    title="Advanced refresh actions"
                    className={cn(
                        'flex items-center justify-center w-7 h-7 rounded-lg',
                        'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                        menuOpen && 'bg-black/5 dark:bg-white/5 text-ink',
                    )}
                >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                </button>

                {menuOpen && (
                    <div
                        className={cn(
                            'absolute right-0 top-full mt-1.5 z-30 w-72 rounded-xl',
                            'border border-glass-border bg-canvas-elevated shadow-xl',
                            'animate-in fade-in slide-in-from-top-1 duration-100',
                        )}
                    >
                        <div className="px-3 pt-3 pb-2 border-b border-glass-border/60">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                                Scheduler
                            </div>
                            <div className="text-[11px] text-ink-muted mt-0.5">
                                Refreshes every {cadenceLabel}.
                                {lastRefreshAgo
                                    ? ` Last tick ${lastRefreshAgo}.`
                                    : ' First tick pending.'}
                            </div>
                        </div>

                        <button
                            onClick={handleTriggerGlobalTick}
                            disabled={tickInFlight}
                            className={cn(
                                'flex items-start gap-2.5 w-full px-3 py-2.5 text-left',
                                'hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                                'disabled:opacity-60 disabled:cursor-not-allowed',
                            )}
                        >
                            <div className="shrink-0 mt-0.5">
                                {tickInFlight ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                                ) : (
                                    <Zap className="w-3.5 h-3.5 text-indigo-500" />
                                )}
                            </div>
                            <div>
                                <div className="text-xs font-semibold text-ink">
                                    Run global discovery tick
                                </div>
                                <div className="text-[11px] text-ink-muted mt-0.5">
                                    Fires the scheduler for every active provider, not just this one. Dedup applies.
                                </div>
                            </div>
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
