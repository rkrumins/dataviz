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
    return {
      v: 1,
      entries: s.entries as string[],
      cursor: s.cursor,
      mode: s.mode,
      groups: s.groups as string[],
      frontier: s.frontier as string[],
    }
  } catch {
    return null
  }
}
