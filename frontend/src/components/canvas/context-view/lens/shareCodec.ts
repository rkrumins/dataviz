/**
 * shareCodec — serialize a Lens exploration into a URL-safe token.
 *
 * A walked path is a finding; this lets an analyst hand a colleague the
 * exact picture (focus history + cursor, body mode, and the current
 * focal's group/frontier expansions) as a link instead of a narration.
 * Versioned JSON → UTF-8 → base64url. Decoding is defensive: anything
 * malformed — bad base64, bad JSON, wrong version, wrong shapes —
 * returns null and the app simply opens normally (a share link must
 * never be able to break the canvas).
 */

export interface LensShareState {
  v: 1
  /** Focus history entries (urns) and cursor position. */
  entries: string[]
  cursor: number
  mode: 'graph' | 'list'
  /** Current focal's expanded group keys (`${dir}:${parentUrn}`). */
  groups: string[]
  /** Current focal's expanded frontier keys (`${dir}:${urn}`). */
  frontier: string[]
  /** Current focal's opened containers (`${dir}:${urn}`). Absent in
   *  links written before containers existed — decodes to []. */
  containers: string[]
  /** Of those, the ones switched to "everything inside". Absent in
   *  older links — decodes to []. */
  frameAll: string[]
  /** Contains-stack rows opened, by urn. Without these a link to an
   *  entity whose structure you had unfolded opened it collapsed. */
  contains: string[]
  /** Per-frame page index and search text, so a link to "page 7,
   *  filtered to revenue" does not open on page 1 unfiltered. */
  framePages: Array<[string, number]>
  frameQueries: Array<[string, string]>
}

export function encodeLensShare(state: Omit<LensShareState, 'v'>): string {
  const json = JSON.stringify({ v: 1, ...state })
  // UTF-8-safe base64url (labels/urns can contain any unicode).
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeLensShare(raw: string): LensShareState | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null) return null
    const s = parsed as Record<string, unknown>
    if (s.v !== 1) return null
    if (!Array.isArray(s.entries) || !s.entries.every(e => typeof e === 'string') || s.entries.length === 0) return null
    if (typeof s.cursor !== 'number' || s.cursor < 0 || s.cursor >= s.entries.length) return null
    if (s.mode !== 'graph' && s.mode !== 'list') return null
    if (!Array.isArray(s.groups) || !s.groups.every(e => typeof e === 'string')) return null
    if (!Array.isArray(s.frontier) || !s.frontier.every(e => typeof e === 'string')) return null
    // Optional so links written before these existed still open.
    const containers = s.containers === undefined ? [] : s.containers
    if (!Array.isArray(containers) || !containers.every(e => typeof e === 'string')) return null
    const frameAll = s.frameAll === undefined ? [] : s.frameAll
    if (!Array.isArray(frameAll) || !frameAll.every(e => typeof e === 'string')) return null
    const contains = s.contains === undefined ? [] : s.contains
    if (!Array.isArray(contains) || !contains.every(e => typeof e === 'string')) return null
    const pairs = (raw: unknown, valueOk: (v: unknown) => boolean) => {
      if (raw === undefined) return []
      if (!Array.isArray(raw)) return null
      if (!raw.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && valueOk(e[1]))) return null
      return raw
    }
    const framePages = pairs(s.framePages, v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (framePages === null) return null
    const frameQueries = pairs(s.frameQueries, v => typeof v === 'string')
    if (frameQueries === null) return null
    return {
      v: 1,
      entries: s.entries as string[],
      cursor: s.cursor,
      mode: s.mode,
      groups: s.groups as string[],
      frontier: s.frontier as string[],
      containers: containers as string[],
      frameAll: frameAll as string[],
      contains: contains as string[],
      framePages: framePages as Array<[string, number]>,
      frameQueries: frameQueries as Array<[string, string]>,
    }
  } catch {
    return null
  }
}
