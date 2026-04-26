/**
 * Per-provider admission-control editor.
 *
 * Surfaces the token-bucket and circuit-breaker knobs the insights
 * worker reads before each provider IO call, plus the rolling-window
 * counters so the operator can see the effect of a change without
 * leaving the page.
 */
import { useEffect, useState } from 'react'
import { Loader2, Save, RefreshCw, Activity } from 'lucide-react'
import {
    insightsAdminService,
    type ProviderAdmissionConfig,
    type ProviderAdmissionConfigResponse,
} from '@/services/insightsAdminService'
import { cn } from '@/lib/utils'

interface Props {
    providerId: string
    /** Hide the section heading when nesting inside another titled card. */
    embedded?: boolean
}

const DEFAULTS: ProviderAdmissionConfig = {
    bucket_capacity: 8,
    refill_per_sec: 2,
}

// Circuit-breaker knobs were removed when admission's in-memory circuit
// was deleted in favour of the provider-proxy circuit. The two layers
// here are now: (a) Redis GCRA bucket (cluster-wide rate cap), (b)
// rolling-window observability counters surfaced below.
const FIELDS: Array<{
    key: keyof ProviderAdmissionConfig
    label: string
    hint: string
    min: number
    max: number
}> = [
    {
        key: 'bucket_capacity',
        label: 'Bucket capacity',
        hint: 'Max simultaneous IO calls (1–200).',
        min: 1, max: 200,
    },
    {
        key: 'refill_per_sec',
        label: 'Refill per second',
        hint: 'Sustained calls/sec (1–100).',
        min: 1, max: 100,
    },
]

export function ProviderAdmissionEditor({ providerId, embedded }: Props) {
    const [draft, setDraft] = useState<ProviderAdmissionConfig>(DEFAULTS)
    const [server, setServer] = useState<ProviderAdmissionConfigResponse | null>(null)
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [savedAt, setSavedAt] = useState<number | null>(null)

    const load = async () => {
        setLoading(true)
        setError(null)
        try {
            const cfg = await insightsAdminService.getAdmissionConfig(providerId)
            setServer(cfg)
            setDraft({
                bucket_capacity: cfg.bucket_capacity,
                refill_per_sec: cfg.refill_per_sec,
            })
        } catch (e: any) {
            setError(e?.message ?? 'Failed to load admission config')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [providerId])

    const dirty = server == null || FIELDS.some(f => draft[f.key] !== server[f.key])

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const cfg = await insightsAdminService.putAdmissionConfig(providerId, draft)
            setServer(cfg)
            setSavedAt(Date.now())
        } catch (e: any) {
            setError(e?.message ?? 'Failed to save admission config')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className={cn(!embedded && 'rounded-xl border border-glass-border bg-canvas-elevated p-4')}>
            {!embedded && (
                <div className="flex items-center gap-2 mb-3">
                    <Activity className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-sm font-bold text-ink">Admission control</h4>
                    <button
                        onClick={load}
                        disabled={loading}
                        title="Reload current values"
                        className="ml-auto text-ink-muted hover:text-ink p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5"
                    >
                        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    </button>
                </div>
            )}

            {server && (
                <div className="grid grid-cols-3 gap-2 mb-3 text-[11px]">
                    <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1.5">
                        <div className="text-emerald-600 dark:text-emerald-400 font-semibold">Successes</div>
                        <div className="font-mono text-ink mt-0.5">{server.success_count.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-2 py-1.5">
                        <div className="text-red-600 dark:text-red-400 font-semibold">Failures</div>
                        <div className="font-mono text-ink mt-0.5">{server.failure_count.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-2 py-1.5">
                        <div className="text-amber-600 dark:text-amber-400 font-semibold">Consec. fails</div>
                        <div className="font-mono text-ink mt-0.5">{server.consecutive_failures}</div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3">
                {FIELDS.map(f => (
                    <label key={f.key} className="flex flex-col gap-1">
                        <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
                            {f.label}
                        </span>
                        <input
                            type="number"
                            min={f.min}
                            max={f.max}
                            value={draft[f.key]}
                            onChange={(e) => {
                                const v = parseInt(e.target.value, 10)
                                if (Number.isNaN(v)) return
                                setDraft(d => ({ ...d, [f.key]: v }))
                            }}
                            className="w-full px-2 py-1 rounded-md border border-glass-border bg-canvas text-sm text-ink focus:ring-2 focus:ring-indigo-500/50 outline-none"
                            disabled={loading || saving}
                        />
                        <span className="text-[10px] text-ink-muted/70">{f.hint}</span>
                    </label>
                ))}
            </div>

            {error && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
                    {error}
                </div>
            )}

            <div className="flex items-center justify-between mt-3">
                <span className="text-[10px] text-ink-muted">
                    {server?.updated_at
                        ? `Last saved ${new Date(server.updated_at).toLocaleString()}`
                        : 'Using module defaults'}
                    {savedAt && Date.now() - savedAt < 5000 ? ' · saved' : ''}
                </span>
                <button
                    onClick={save}
                    disabled={saving || !dirty}
                    className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                        dirty && !saving
                            ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                    )}
                >
                    {saving ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                        <Save className="w-3 h-3" />
                    )}
                    Save
                </button>
            </div>
        </div>
    )
}
