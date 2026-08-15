/**
 * shareCodec — serialize a Lens exploration into a URL-safe token.
 *
 * A walked path is a finding; this lets an analyst hand a colleague the
 * exact picture (focus history + cursor, body mode, the header's
 * direction/depth controls, and the current focal's LensViewState) as a
 * link instead of a narration. Versioned JSON → UTF-8 → base64url.
 * Decoding is defensive: anything malformed — bad base64, bad JSON,
 * wrong version, wrong shapes — returns null and the app simply opens
 * normally (a share link must never be able to break the canvas).
 *
 * v3 is the current shape (below) — T23 grew `LensViewState` by three
 * fields (`pinned`/`railWindow`/`condensedOpen`, the hub-triage
 * placements, the rail's own window position, and which condensed runs
 * are unfolded), and a v2 token has none of them. Bumped rather than
 * folded silently into v2, per the same reasoning `framePages`' own note
 * below already sets out: a NEW field a v2 encoder never wrote is
 * indistinguishable from one it wrote as empty, so a version bump is
 * what lets `decodeLensShare` tell "this link predates placements" apart
 * from "this link's reader placed nothing" — the first restores to
 * empty/null (a graceful, documented degrade, exactly v1→v2's own
 * pattern), the second is just what it says.
 *
 * v2 — written before T23 — carries everything v3 does except those
 * three fields; a v2 token still restores its FULL exploration (nothing
 * about it was wrong, it is simply from before the feature existed).
 * v1 — written before the walk-model swap (T10) — carried a state model
 * (`closed`/`frontier`/`containers`/`contains`) that no longer exists, so
 * decoding a v1 token restores only `entries`/`cursor`/`mode`: a
 * colleague's old link still lands on the same walked path, in the same
 * body mode, rather than failing outright.
 */

export type LensSharePreset = 'both' | 'in' | 'out'

export interface LensShareStateV1 {
  v: 1
  /** Focus history entries (urns) and cursor position. */
  entries: string[]
  cursor: number
  mode: 'graph' | 'list'
}

export interface LensShareStateV2 {
  v: 2
  /** Focus history entries (urns) and cursor position. */
  entries: string[]
  cursor: number
  mode: 'graph' | 'list'
  /** The header's direction preset in effect for the shared focal. */
  direction: LensSharePreset
  /** The initial-depth control's value in effect for the shared focal. */
  depth: number
  /** Current focal's LensViewState fields, verbatim (see focus-layout.ts):
   *  `revealed` → `${'in'|'out'}:${urn}` → pages; `opened`/`collapsed` →
   *  expanded/collapsed containment; `frameAll` → frames showing
   *  everything inside; `framePages`/`frameQueries` → where each frame is
   *  scrolled to and what it is searching. Selection is deliberately not
   *  carried — it is ephemeral UI state, not part of the exploration.
   *
   *  `framePages` KEEPS ITS WIRE NAME while frames no longer page: it is
   *  now read as a ROW OFFSET (see `LensViewState.frameOffsets`). Both
   *  are a non-negative position into a frame's row list, and the layout
   *  clamps it to the rows in hand, so a link written before the pagers
   *  died still lands its reader somewhere real — which renaming the
   *  field would not, because a v2 token missing it decodes to null and
   *  loses the whole walked path with it. */
  revealed: Array<[string, number]>
  opened: string[]
  collapsed: string[]
  frameAll: string[]
  framePages: Array<[string, number]>
  frameQueries: Array<[string, string]>
}

export interface LensShareStateV3 extends Omit<LensShareStateV2, 'v'> {
  v: 3
  /** T23 R3 — urns the reader placed on the board from a hub triage
   *  list, verbatim off `LensViewState.pinned`. */
  pinned: string[]
  /** T23 R1 — the hop rail's own window center (signed hop distance),
   *  or `null` for "centered on the focal" — `LensViewState.railWindow`
   *  verbatim. */
  railWindow: number | null
  /** T23 R2 — connector ids the reader explicitly unfolded, verbatim off
   *  `LensViewState.condensedOpen`. */
  condensedOpen: string[]
}

/** v3 → the full exploration; v2 → the same, minus placements/window/
 *  condensed-open (all three restore empty/null); v1 → the graceful
 *  subset described above. */
export type LensShareState = LensShareStateV1 | LensShareStateV2 | LensShareStateV3

export function encodeLensShare(state: Omit<LensShareStateV3, 'v'>): string {
  const json = JSON.stringify({ v: 3, ...state })
  // UTF-8-safe base64url (labels/urns can contain any unicode).
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const stringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(e => typeof e === 'string') ? v as string[] : null

const pairArray = (v: unknown, valueOk: (v: unknown) => boolean): Array<[string, unknown]> | null => {
  if (!Array.isArray(v)) return null
  if (!v.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && valueOk(e[1]))) return null
  return v
}

export function decodeLensShare(raw: string): LensShareState | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null) return null
    const s = parsed as Record<string, unknown>

    // The shape both versions share.
    if (!Array.isArray(s.entries) || !s.entries.every(e => typeof e === 'string') || s.entries.length === 0) return null
    if (typeof s.cursor !== 'number' || s.cursor < 0 || s.cursor >= s.entries.length) return null
    if (s.mode !== 'graph' && s.mode !== 'list') return null
    const entries = s.entries as string[]
    const cursor = s.cursor
    const mode = s.mode

    if (s.v === 1) {
      // The exploration fields (closed/frontier/containers/contains/
      // framePages/frameQueries) describe a state model that no longer
      // exists — nothing consumes them, and a malformed shape there must
      // not sink an otherwise-valid path + mode restore.
      return { v: 1, entries, cursor, mode }
    }
    if (s.v !== 2 && s.v !== 3) return null

    if (s.direction !== 'both' && s.direction !== 'in' && s.direction !== 'out') return null
    // Bounded to the depth control's own sanctioned maximum (1|2|3, see
    // LineageLens.tsx) — a hostile or corrupted token must not be able to
    // order a deeper walk than the UI itself can ever ask for. The server
    // additionally clamps upstreamDepth/downstreamDepth to 25 on its own
    // wire (TraceClosureRequest), so this is defense-in-depth for the UX,
    // not the only wall.
    if (typeof s.depth !== 'number' || !Number.isFinite(s.depth) || s.depth < 1 || s.depth > 3) return null

    const opened = stringArray(s.opened)
    if (opened === null) return null
    const collapsed = stringArray(s.collapsed)
    if (collapsed === null) return null
    const frameAll = stringArray(s.frameAll)
    if (frameAll === null) return null
    const revealed = pairArray(s.revealed, v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (revealed === null) return null
    const framePages = pairArray(s.framePages, v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (framePages === null) return null
    const frameQueries = pairArray(s.frameQueries, v => typeof v === 'string')
    if (frameQueries === null) return null

    const v2Shape: Omit<LensShareStateV2, 'v'> = {
      entries,
      cursor,
      mode,
      direction: s.direction,
      depth: s.depth,
      revealed: revealed as Array<[string, number]>,
      opened,
      collapsed,
      frameAll,
      framePages: framePages as Array<[string, number]>,
      frameQueries: frameQueries as Array<[string, string]>,
    }
    if (s.v === 2) return { v: 2, ...v2Shape }

    // v3 — T23's own three fields, absent from a v2 token by definition
    // (it predates them): validated the same defensive way as everything
    // else here, never assumed present.
    const pinned = stringArray(s.pinned)
    if (pinned === null) return null
    if (s.railWindow !== null && (typeof s.railWindow !== 'number' || !Number.isFinite(s.railWindow))) return null
    const condensedOpen = stringArray(s.condensedOpen)
    if (condensedOpen === null) return null

    return { v: 3, ...v2Shape, pinned, railWindow: s.railWindow, condensedOpen }
  } catch {
    return null
  }
}
