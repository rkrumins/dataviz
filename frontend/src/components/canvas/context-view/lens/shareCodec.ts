/**
 * shareCodec — serialize a Lens exploration into a URL-safe token.
 *
 * A walked path is a finding; this lets an analyst hand a colleague the
 * exact picture — the focus history, and every gesture made on the
 * current focal (lineage expansions, containment opens, rollup drills)
 * so the receiving lens can replay them. Versioned JSON → UTF-8 →
 * base64url. Decoding is defensive: anything malformed — bad base64,
 * bad JSON, wrong version, wrong shapes — returns null and the app
 * simply opens normally. A share link must never be able to break the
 * canvas.
 *
 * v2 speaks the rewritten lens's state model (three gesture namespaces
 * keyed by urn/record). v1 tokens belonged to the pre-rewrite lens that
 * never shipped; they decode to null and open the lens fresh.
 */
export interface LensShareState {
  v: 2
  /** Focus history entries (urns) and cursor position. */
  entries: string[]
  cursor: number
  /** Lineage expansions made on the current focal's board (`dir:urn`). */
  expansions: string[]
  /** Containment opens (urns whose children were opened). */
  children: string[]
  /** Rollup drills (record ids) to replay once their record exists —
   *  in insertion order, so a walked chain replays parent-first. */
  drills: string[]
  /** Which side each drill opened (record id → anchor urn). Without it
   *  a replay could descend the wrong end of the pair. */
  anchors: Record<string, string>
  /** Anchor urns whose frames open in connected-only mode. */
  connected: string[]
}

export function encodeLensShare(state: Omit<LensShareState, 'v'>): string {
  const json = JSON.stringify({ v: 2, ...state })
  // UTF-8-safe base64url (labels/urns can contain any unicode).
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string')

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every(x => typeof x === 'string')

export function decodeLensShare(raw: string): LensShareState | null {
  if (!raw || typeof raw !== 'string' || raw.length > 16384) return null
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null) return null
    const p = parsed as Record<string, unknown>
    if (p.v !== 2) return null
    if (!isStringArray(p.entries) || p.entries.length === 0) return null
    if (typeof p.cursor !== 'number' || !Number.isInteger(p.cursor)) return null
    const cursor = Math.max(0, Math.min(p.cursor, p.entries.length - 1))
    return {
      v: 2,
      entries: p.entries,
      cursor,
      expansions: isStringArray(p.expansions) ? p.expansions : [],
      children: isStringArray(p.children) ? p.children : [],
      drills: isStringArray(p.drills) ? p.drills : [],
      anchors: isStringRecord(p.anchors) ? p.anchors : {},
      connected: isStringArray(p.connected) ? p.connected : [],
    }
  } catch {
    return null
  }
}
