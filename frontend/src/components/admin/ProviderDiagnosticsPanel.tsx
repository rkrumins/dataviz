/**
 * ProviderDiagnosticsPanel — surfaces provider-specific diagnostic signals
 * via the generic `GET /admin/providers/{id}/diagnostics` endpoint.
 *
 * Generic by design: the endpoint dispatches through the
 * ``GraphDataProvider.get_diagnostics()`` optional method, which any
 * future provider can override. The panel hides itself for providers
 * that return an empty payload (or report ``supported=false``), so
 * mounting this component unconditionally is safe.
 *
 * Today, only the Spanner Graph provider populates these fields:
 * edition, dialect, region, session pool, latency p50/p95, last query
 * time, schema fingerprint + drift, IAM checks, capabilities.
 */
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Gauge,
  KeyRound,
  RefreshCw,
  Shield,
  Sparkles,
  XCircle,
} from 'lucide-react'

import { providerService, type ProviderDiagnosticsResponse } from '@/services/providerService'

interface Props {
  providerId: string
  /** Optional auto-refresh interval in ms (default 30s). Set to 0 to disable. */
  refreshIntervalMs?: number
  className?: string
}

function formatMs(value?: number | null): string {
  if (value == null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${value} ms`
}

function formatRelative(epoch?: number | null): string {
  if (!epoch) return 'never'
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - epoch))
  if (ageS < 60) return `${ageS}s ago`
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`
  return `${Math.floor(ageS / 3600)}h ago`
}

function CapabilityChip({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
        enabled
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-black/5 text-ink-muted dark:bg-white/5'
      }`}
    >
      {enabled ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

function IamRow({ permission, granted }: { permission: string; granted: boolean }) {
  return (
    <li className="flex items-center justify-between rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5">
      <span className="font-mono text-ink-secondary">{permission}</span>
      {granted ? (
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> granted
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> missing
        </span>
      )}
    </li>
  )
}

export function ProviderDiagnosticsPanel({
  providerId,
  refreshIntervalMs = 30_000,
  className,
}: Props) {
  const [data, setData] = useState<ProviderDiagnosticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const res = await providerService.getDiagnostics(providerId)
      setData(res)
    } catch (exc: any) {
      setError(exc?.message ?? 'Failed to load diagnostics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await load()
      if (cancelled) return
    })()
    if (refreshIntervalMs > 0) {
      const handle = window.setInterval(load, refreshIntervalMs)
      return () => {
        cancelled = true
        window.clearInterval(handle)
      }
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, refreshIntervalMs])

  // Provider doesn't override get_diagnostics — auto-hide the panel.
  if (!loading && data && !data.supported) return null
  // Provider returned an empty diagnostics dict — also auto-hide.
  if (!loading && data && Object.keys(data.diagnostics ?? {}).length === 0) return null

  const d = data?.diagnostics ?? {}
  const caps = d.capabilities ?? {}
  const iam = d.iam_permissions ?? {}
  const drift = Boolean(d.schema_drift_detected)

  return (
    <section
      className={`rounded-2xl border border-glass-border bg-canvas-elevated p-5 ${className ?? ''}`}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-sky-500" />
          <div>
            <h3 className="text-sm font-semibold text-ink">Provider diagnostics</h3>
            <p className="text-xs text-ink-muted">
              Live signals from the back-end. Auto-refresh every {Math.round(refreshIntervalMs / 1000)}s.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-black/5 px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {drift && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Schema drift detected</p>
              <p className="mt-0.5 text-xs">
                The remote schema has changed since this provider was first connected. Re-running
                schema discovery on dependent data sources is recommended.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-muted">
            <Database className="h-3 w-3" /> Edition
          </div>
          <div className="mt-1 text-sm font-semibold text-ink">{d.edition ?? '—'}</div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Dialect</div>
          <div className="mt-1 text-sm font-semibold text-ink">{d.dialect ?? '—'}</div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Region</div>
          <div className="mt-1 text-sm font-semibold text-ink">{d.region ?? 'auto'}</div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-muted">
            <Gauge className="h-3 w-3" /> Pool size
          </div>
          <div className="mt-1 text-sm font-semibold text-ink">
            {d.session_pool?.size ?? '—'}
          </div>
        </div>

        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Query p50</div>
          <div className="mt-1 text-sm font-semibold text-ink">{formatMs(d.last_query_p50_ms)}</div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Query p95</div>
          <div className="mt-1 text-sm font-semibold text-ink">{formatMs(d.last_query_p95_ms)}</div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Last successful query</div>
          <div className="mt-1 text-sm font-semibold text-ink">
            {formatRelative(d.last_successful_query_at)}
          </div>
        </div>
        <div className="rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/5">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted">Schema fingerprint</div>
          <div className="mt-1 truncate font-mono text-xs text-ink" title={d.schema_fingerprint ?? ''}>
            {d.schema_fingerprint ?? '—'}
          </div>
        </div>
      </div>

      {Object.keys(caps).length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Sparkles className="h-3.5 w-3.5 text-sky-500" /> Capabilities
          </div>
          <div className="flex flex-wrap gap-2">
            <CapabilityChip label="Time travel (PITR)" enabled={!!caps.time_travel} />
            <CapabilityChip label="Vector search" enabled={!!caps.vector_search} />
            <CapabilityChip label="Full-text search" enabled={!!caps.full_text_search} />
            <CapabilityChip label="Change streams" enabled={!!caps.change_streams} />
          </div>
        </div>
      )}

      {Object.keys(iam).length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <KeyRound className="h-3.5 w-3.5 text-indigo-500" /> IAM permissions
          </div>
          <ul className="space-y-1.5">
            {Object.entries(iam).map(([p, v]) => (
              <IamRow key={p} permission={p} granted={Boolean(v)} />
            ))}
          </ul>
          {Object.values(iam).some((v) => !v) && (
            <p className="mt-2 inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <Shield className="h-3.5 w-3.5" />
              Missing permissions may surface only when the provider needs them (e.g. first
              aggregation requires <span className="font-mono">spanner.databases.updateDdl</span>).
            </p>
          )}
        </div>
      )}
    </section>
  )
}
