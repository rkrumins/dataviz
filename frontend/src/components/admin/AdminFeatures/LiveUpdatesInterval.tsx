/**
 * How often browsers check for changes — the Live updates switch's setting.
 *
 * It sits in the switch's detail pane because the two are one decision. The
 * switch says whether changes are pushed the moment they happen; this says how
 * often every browser checks anyway, which is the only mechanism while the
 * switch is off and the safety net while it is on. The server returns the
 * interval with every check, so a change reaches each browser at its next
 * check, with no reload.
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, RotateCcw } from 'lucide-react'
import {
    platformSettingsService,
    type LiveUpdatesSettings,
} from '@/services/platformSettingsService'
import { useAppNotifications } from '@/components/ui/notifications'

export function LiveUpdatesInterval() {
    const { notify } = useAppNotifications()
    const [settings, setSettings] = useState<LiveUpdatesSettings | null>(null)
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        let cancelled = false
        platformSettingsService.getLiveUpdates()
            .then((loaded) => {
                if (cancelled) return
                setSettings(loaded)
                setDraft(String(loaded.checkIntervalSeconds ?? loaded.defaultCheckIntervalSeconds))
            })
            .catch(() => {
                if (!cancelled) notify('error', 'Could not load the check interval.')
            })
        return () => {
            cancelled = true
        }
    }, [notify])

    if (!settings) return null

    const min = settings.minCheckIntervalSeconds
    const max = settings.maxCheckIntervalSeconds
    const current = settings.checkIntervalSeconds ?? settings.defaultCheckIntervalSeconds
    const value = Number(draft)
    const valid = draft.trim() !== '' && Number.isInteger(value) && value >= min && value <= max

    const save = async (next: number | null) => {
        setSaving(true)
        try {
            const updated = await platformSettingsService.setLiveUpdates({ checkIntervalSeconds: next })
            setSettings(updated)
            const seconds = updated.checkIntervalSeconds ?? updated.defaultCheckIntervalSeconds
            setDraft(String(seconds))
            notify('success', `Browsers check every ${seconds} seconds from their next check.`)
        } catch (err) {
            notify('error', err instanceof Error && err.message ? err.message : 'Could not save the check interval.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="rounded-2xl border border-glass-border p-4">
            <label htmlFor="live-updates-interval" className="block text-sm font-medium text-ink-secondary">
                Check for changes every
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                    id="live-updates-interval"
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    step={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-invalid={!valid}
                    aria-describedby="live-updates-interval-help"
                    className="w-28 px-3 py-2 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                />
                <span className="text-sm text-ink-muted">seconds</span>
                <button
                    type="button"
                    onClick={() => void save(value)}
                    disabled={!valid || value === current || saving}
                    className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium shadow-md hover:shadow-indigo-500/30 transition-colors duration-150 disabled:opacity-50 flex items-center gap-2"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Save
                </button>
                {settings.checkIntervalSeconds !== null && (
                    <button
                        type="button"
                        onClick={() => void save(null)}
                        disabled={saving}
                        className="px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Reset to {settings.defaultCheckIntervalSeconds}s
                    </button>
                )}
            </div>
            {!valid && (
                <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
                    Enter a whole number of seconds from {min} to {max}.
                </p>
            )}
            <p id="live-updates-interval-help" className="mt-2 text-xs text-ink-muted leading-relaxed">
                Between {min} seconds and {Math.round(max / 60)} minutes. Covers announcements,
                notifications, permissions, feature switches, invite activity, and provider health
                and status. Each browser checks once for all of its tabs, not at all while none of
                them is visible, and picks up a new value at its next check. Provider outages are
                rechecked every minute regardless.
            </p>
        </div>
    )
}
