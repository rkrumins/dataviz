/**
 * Product telemetry — fire-and-forget usage signals.
 *
 * Records "was this helpful?", searches that found nothing, and tour
 * completion so the Admin telemetry view can show what's working and where the
 * content gaps are. Deliberately best-effort: a failed or unauthenticated POST
 * is swallowed (anonymous /docs readers keep their localStorage-only vote), so
 * calling this never affects the user's flow.
 */
import { authFetch } from './apiClient'

/**
 * Mirrors ``ALLOWED_EVENT_TYPES`` in
 * ``backend/app/api/v1/endpoints/telemetry.py`` — the server rejects anything
 * else with a 400, so the union is the compile-time half of that allowlist.
 *
 * The `docs.` / `tour.` / `onboarding.` types measure whether we explained
 * ourselves. The rest measure whether anyone got VALUE out of the product —
 * traced lineage, searched the graph, published a revision. Analytics needs
 * both: the first family alone can only prove people showed up.
 */
export type TelemetryType =
  | 'docs.feedback'
  | 'docs.search_miss'
  | 'tour.completed'
  | 'tour.skipped'
  | 'onboarding.step'
  | 'lineage.trace'
  | 'lineage.trace_empty'
  | 'graph.search'
  | 'graph.search_miss'
  | 'graph.export'
  | 'version.published'
  | 'ontology.published'

const ENDPOINT = '/api/v1/telemetry/events'

export function recordEvent(type: TelemetryType, payload?: Record<string, unknown>): void {
  void authFetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
    silent403: true,
  }).catch(() => {
    /* best-effort telemetry — never surface to the user */
  })
}
