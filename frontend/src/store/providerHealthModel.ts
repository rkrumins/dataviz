/**
 * providerHealthModel — the ONE place provider health is resolved and presented.
 *
 * The app had five different provider-status signals (the `isActive` config flag,
 * the `providerStatus` breaker/warmup store, the per-provider `/test` sweep, the
 * `providerHealth` datasource poll, and the discovery-preflight `last_error`), and
 * each surface read a different one — so the same offline provider showed as green
 * "Active" in the view wizard, red "DOWN" in the provider list, and "unreachable"
 * only after selection in the asset browser.
 *
 * This module collapses that to a single resolution: every surface maps the
 * canonical, provider-id-keyed `providerStatus` signal (optionally overlaid with a
 * fresher local `/test` sweep) through {@link resolveProviderHealth}, and renders it
 * with {@link PROVIDER_HEALTH_META}. Resolution order, the visual language, and the
 * "may I build on this?" gate all live here — change them once, everywhere agrees.
 */
import { useProviderStatus } from './providerStatus'

/** The canonical health a surface renders. Deliberately smaller than the union of
 *  every upstream signal — surfaces should reason about these four states only. */
export type ProviderHealthState = 'online' | 'offline' | 'checking' | 'unknown'

/** Backend `providerStatus` values (from `/admin/providers/status`). */
type BackendStatus = 'ready' | 'unavailable' | 'unknown'
/** Local per-provider `/test` sweep values (`useProviderHealthSweep`). */
type SweepStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown'

export interface ResolvedProviderHealth {
  state: ProviderHealthState
  error?: string
}

function fromBackend(status: BackendStatus): ProviderHealthState {
  return status === 'ready' ? 'online' : status === 'unavailable' ? 'offline' : 'unknown'
}

function fromSweep(status: SweepStatus): ProviderHealthState {
  return status === 'healthy' ? 'online'
    : status === 'unhealthy' ? 'offline'
    : status === 'checking' ? 'checking'
    : 'unknown'
}

/**
 * Resolve a provider's effective health from its available signals.
 *
 * Precedence: a local `/test` sweep result (freshest, user-initiated truth) wins
 * when it is conclusive; otherwise the backend breaker/warmup status; otherwise
 * `unknown`. A sweep that is itself `unknown` defers to the backend rather than
 * masking it.
 */
export function resolveProviderHealth(opts: {
  backend?: { status: BackendStatus; error?: string } | null
  sweep?: { status: SweepStatus; error?: string } | null
}): ResolvedProviderHealth {
  const { backend, sweep } = opts
  if (sweep) {
    const state = fromSweep(sweep.status)
    if (state !== 'unknown') return { state, error: sweep.error }
  }
  if (backend) return { state: fromBackend(backend.status), error: backend.error }
  return { state: 'unknown' }
}

/** Presentation + policy for each state, shared by every surface. `selectable` is
 *  the single gate for "can a user build a new model/data source on this provider":
 *  only a CONFIRMED-offline provider is blocked, so a cold-start `unknown` (or a
 *  non-admin with no status feed) is never falsely locked out — the backend
 *  provisioning path is the authoritative gate for those. */
export const PROVIDER_HEALTH_META: Record<ProviderHealthState, {
  dot: string
  label: string
  selectable: boolean
}> = {
  online: {
    dot: 'bg-emerald-500',
    label: 'Online',
    selectable: true,
  },
  offline: {
    dot: 'bg-red-500',
    label: 'Offline — connection failed',
    selectable: false,
  },
  checking: {
    dot: 'bg-amber-400 animate-pulse',
    label: 'Checking…',
    selectable: true,
  },
  unknown: {
    dot: 'bg-slate-300 dark:bg-slate-600',
    label: 'Status unknown',
    selectable: true,
  },
}

/** Resolve a provider's health from the canonical `providerStatus` store (keyed by
 *  provider id, fed by the bounded `/admin/providers/status` poll). Pass a local
 *  sweep result too when a surface has one (e.g. the provider list's Test button). */
export function useProviderHealth(
  providerId: string | null | undefined,
  sweep?: { status: SweepStatus; error?: string } | null,
): ResolvedProviderHealth {
  const backend = useProviderStatus(providerId)
  return resolveProviderHealth({ backend, sweep })
}
