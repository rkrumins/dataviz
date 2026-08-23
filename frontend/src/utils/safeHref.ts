/**
 * Whether a stored URL is safe to put in an `href`.
 *
 * The announcement banner renders an admin-supplied CTA URL into an anchor
 * shown to every signed-in user. A `javascript:` URL there turns "edit an
 * announcement" into stored XSS against the whole platform — admin-only
 * write bounds who can try it, not what it would do.
 *
 * The authoritative check is server-side, on `AnnouncementCreateRequest` /
 * `AnnouncementUpdateRequest` (`backend/common/models/management.py`). This
 * is the second half: rows written before that validator existed are still
 * in the table, and they render through here.
 *
 * Keep the two rules identical. If they drift, the server's is the one that
 * decides what can be stored and this one decides what is shown.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  const lowered = trimmed.toLowerCase()
  if (lowered.startsWith('http://') || lowered.startsWith('https://')) {
    return trimmed
  }

  // Site-relative, but not protocol-relative ('//evil.com' inherits the page
  // scheme and leaves the origin) and not a backslash variant, which browsers
  // normalise to '/' in the relative-slash state.
  if (
    trimmed.startsWith('/') &&
    !trimmed.startsWith('//') &&
    !trimmed.includes('\\')
  ) {
    return trimmed
  }

  return null
}
