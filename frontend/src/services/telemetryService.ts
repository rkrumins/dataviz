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

export type TelemetryType =
  | 'docs.feedback'
  | 'docs.search_miss'
  | 'tour.completed'
  | 'tour.skipped'
  | 'onboarding.step'

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
