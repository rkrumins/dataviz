/**
 * Circuit Breaker — fail-fast pattern for provider requests.
 *
 * When a provider is known-dead (3+ consecutive failures), immediately reject
 * requests instead of waiting for the full 12s timeout.  After 15s, allow
 * one probe request through (half-open).  If it succeeds, close the circuit.
 *
 * Keyed per (workspaceId, dataSourceId) so one dead provider doesn't block others.
 */

export type CircuitState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private consecutiveFailures = 0
  private lastFailureTime = 0
  private halfOpenPending = false

  constructor(
    private readonly failureThreshold = 3,
    private readonly resetTimeoutMs = 15_000,
  ) {}

  /** Check whether a request should be allowed through. */
  canRequest(): boolean {
    if (this.state === 'closed') return true

    if (this.state === 'open') {
      const effectiveReset = this.dynamicResetMs ?? this.resetTimeoutMs
      // Check if enough time has passed to try a probe
      if (Date.now() - this.lastFailureTime >= effectiveReset) {
        this.state = 'half-open'
        this.halfOpenPending = false
        this.dynamicResetMs = undefined // reset to default for next cycle
      } else {
        return false
      }
    }

    // half-open: allow exactly one request through
    if (this.state === 'half-open') {
      if (this.halfOpenPending) return false // another probe is already in flight
      this.halfOpenPending = true
      return true
    }

    return true
  }

  /** Record a successful response — closes the circuit. */
  recordSuccess(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.halfOpenPending = false
  }

  /** Record a failed response — may open the circuit.
   *  @param retryAfterMs  Optional server-provided retry delay (from Retry-After header).
   *                       When provided and the breaker opens, overrides the default resetTimeoutMs
   *                       so the frontend waits at least as long as the backend suggests. */
  recordFailure(retryAfterMs?: number): void {
    this.consecutiveFailures++
    this.lastFailureTime = Date.now()
    this.halfOpenPending = false

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open'
      // Honor the backend's Retry-After hint if longer than our default
      if (retryAfterMs && retryAfterMs > this.resetTimeoutMs) {
        this.dynamicResetMs = retryAfterMs
      }
    }
  }

  /** Effective reset timeout — may be extended by a Retry-After hint. */
  private dynamicResetMs: number | undefined

  /** Force-reset to closed (e.g. on health recovery). */
  reset(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.halfOpenPending = false
  }

  /** Current state — useful for UI indicators. */
  getState(): CircuitState {
    // Re-evaluate open → half-open on read
    const effectiveReset = this.dynamicResetMs ?? this.resetTimeoutMs
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= effectiveReset) {
      this.state = 'half-open'
      this.halfOpenPending = false
      this.dynamicResetMs = undefined
    }
    return this.state
  }
}

/**
 * Global registry of circuit breakers, keyed by provider scope.
 * Survives across React re-renders (module-level singleton).
 */
const circuits = new Map<string, CircuitBreaker>()

export function getCircuitBreaker(workspaceId?: string, dataSourceId?: string): CircuitBreaker {
  const key = `${workspaceId ?? ''}:${dataSourceId ?? ''}`
  let cb = circuits.get(key)
  if (!cb) {
    cb = new CircuitBreaker()
    circuits.set(key, cb)
  }
  return cb
}

/** Reset all circuit breakers (call on health recovery). */
export function resetAllCircuitBreakers(): void {
  circuits.forEach(cb => cb.reset())
}
