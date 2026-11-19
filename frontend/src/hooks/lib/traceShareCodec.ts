/**
 * traceShareCodec — a trace, as a link (2026-08-23).
 *
 * A Lens session is an exploration; a TRACE is a finding — "what feeds this
 * dashboard", "what breaks if I drop this column" — and findings get handed
 * to other people. Until now that meant a screenshot, which cannot be
 * re-read, re-directed or re-opened. This turns the trace on screen into a
 * `?trace=` token: the recipient lands on the same question, looking the same
 * way, and can carry on from there.
 *
 * WHAT TRAVELS is exactly what `traceHistoryStack` already records as "the
 * trace as it was viewed" — focus, direction, hop limits, and which cards
 * were open — plus the sender's NAME for the focus, so the recipient's
 * loading capsule can say what it is fetching rather than a urn tail. It is
 * the sender's name, so a renamed entity reads its old name for the second
 * or two before the walk lands and the real one replaces it.
 *
 * WHAT DOES NOT is anything the recipient owns: their preferences (card
 * counts, density), their canvas expansion, their layer widths. A link is a
 * finding, not a takeover of someone's workspace.
 *
 * A COMBINED trace (several seeds, 2026-11-18) travels as a `v:2` token that
 * carries every seed, so the recipient traces the whole picture; one seed is
 * still the `v:1` token it always was, so every link already handed out keeps
 * working, and an older client given a `v:2` link opens the view normally
 * rather than quietly tracing its first seed alone.
 *
 * The link re-runs the walk against LIVE data — it is a question, not a
 * frozen snapshot. Lineage that changed since the sender looked will show as
 * it is now, which is the honest behaviour for a lineage tool (and the
 * reason this needs no server-side storage at all).
 *
 * Decoding is defensive, exactly as `lens/shareCodec` is: a token arrives
 * from outside and must never be able to break the canvas. Bad base64, bad
 * JSON, wrong version, wrong shapes, a hostile depth → `null`, and the view
 * opens normally.
 */

/** The most open cards a link carries. Beyond this a URL stops being
 *  pasteable, and a picture that big is not the finding — the focus is. */
export const TRACE_SHARE_OPEN_CAP = 400

/** The most seeds a combined trace carries — the walk's own `MAX_TRACE_SEEDS`,
 *  restated (as `MAX_DEPTH` is) so the codec has no import cycle into the walk.
 *  A token naming more did not come from this UI and is refused. */
export const TRACE_SHARE_MAX_SEEDS = 25

/** The longest link a share hands out. nginx's default request line is 8 KB,
 *  and past it the recipient gets a 414 rather than the trace; the open cards
 *  are what a link gives up to stay under it — never the seeds. */
export const TRACE_SHARE_URL_MAX = 7000

/** The most label a capsule will ever show. A link cannot make the canvas
 *  render a novel. */
const LABEL_CAP = 200

/** The dock's own ceiling (`FULL_WALK_INITIAL_DEPTH`), restated here so the
 *  codec has no import cycle back into the walk. A token asking for more is
 *  refused rather than clamped: it did not come from this UI. */
const MAX_DEPTH = 25

export interface TraceShareStateV1 {
  v: 1
  /** The traced entity. */
  urn: string
  /** The sender's name for it, shown while the walk lands. */
  label?: string
  /** Which sides the sender was reading — the dock's Root Cause / Impact /
   *  Full Lineage. At least one is always true. */
  up: boolean
  down: boolean
  /** View-side hop limits (the walk itself fetched everything). */
  depthUp: number
  depthDown: number
  /** The cards the sender had open. EMPTY means "as the trace opens" — the
   *  overlay's own seed decides, which is also what a focus-only link says. */
  open: string[]
}

/** A COMBINED trace — every seed travels, so the recipient traces the whole
 *  picture rather than its first entity. On the wire it is `urns`; decoded,
 *  `urn` is its first seed, the same convention `traceHistoryStack` keeps, so
 *  `traceEntrySeeds` reads either. `label` is the sender's name for `urn`. */
export interface TraceShareStateV2 extends Omit<TraceShareStateV1, 'v'> {
  v: 2
  urns: string[]
}

export type TraceShareState = TraceShareStateV1 | TraceShareStateV2

/** What a sender hands the encoder: one seed (`urn`), or several (`urns`,
 *  `urn` first). One seed writes the v1 token, byte for byte as before. */
export type TraceShareInput = Omit<TraceShareStateV1, 'v'> & { urns?: readonly string[] }

const toBase64Url = (json: string) =>
  // UTF-8-safe base64url (labels and urns can carry any unicode).
  btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function encodeTraceShare(input: TraceShareInput): string {
  const { urns, ...state } = input
  const seeds = urns ? [...new Set(urns)].slice(0, TRACE_SHARE_MAX_SEEDS) : []
  if (seeds.length > 1) {
    return toBase64Url(JSON.stringify({
      v: 2,
      urns: seeds,
      ...(state.label ? { label: state.label.slice(0, LABEL_CAP) } : {}),
      up: state.up,
      down: state.down,
      depthUp: state.depthUp,
      depthDown: state.depthDown,
      open: state.open.slice(0, TRACE_SHARE_OPEN_CAP),
    }))
  }
  return toBase64Url(JSON.stringify({
    v: 1,
    ...state,
    ...(seeds.length === 1 ? { urn: seeds[0] } : {}),
    ...(state.label ? { label: state.label.slice(0, LABEL_CAP) } : {}),
    open: state.open.slice(0, TRACE_SHARE_OPEN_CAP),
  }))
}

/** The link itself: `href` with the trace in `?trace=` and any Lens token
 *  dropped (one link, one thing to open). When the open cards would carry it
 *  past `TRACE_SHARE_URL_MAX` they are left out, and the caller is told so it
 *  can say so — the recipient still lands on the same question. */
export function buildTraceShareLink(input: TraceShareInput, href: string): { url: string; pictureDropped: boolean } {
  const linkOf = (state: TraceShareInput) => {
    const url = new URL(href)
    url.searchParams.set('trace', encodeTraceShare(state))
    url.searchParams.delete('lens')
    return url.toString()
  }
  const url = linkOf(input)
  if (url.length <= TRACE_SHARE_URL_MAX || input.open.length === 0) return { url, pictureDropped: false }
  return { url: linkOf({ ...input, open: [] }), pictureDropped: true }
}

const depthOk = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DEPTH

export function decodeTraceShare(raw: string): TraceShareState | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const s = parsed as Record<string, unknown>

    if (s.v !== 1 && s.v !== 2) return null
    let urns: string[] | undefined
    if (s.v === 2) {
      // Every seed a real urn, each once, no more than the walk can trace.
      if (!Array.isArray(s.urns) || s.urns.length < 2 || s.urns.length > TRACE_SHARE_MAX_SEEDS) return null
      if (!s.urns.every(u => typeof u === 'string' && u !== '')) return null
      if (new Set(s.urns).size !== s.urns.length) return null
      urns = s.urns as string[]
    } else if (typeof s.urn !== 'string' || s.urn === '') return null
    if (typeof s.up !== 'boolean' || typeof s.down !== 'boolean') return null
    // A trace showing neither side is not a picture anyone sent on purpose.
    if (!s.up && !s.down) return null
    if (!depthOk(s.depthUp) || !depthOk(s.depthDown)) return null
    if (!Array.isArray(s.open) || !s.open.every(e => typeof e === 'string')) return null

    // A label is a courtesy, never load-bearing: a wrong-shaped one is
    // dropped and the urn still traces (the walk supplies the real name).
    const label = typeof s.label === 'string' && s.label !== ''
      ? s.label.slice(0, LABEL_CAP)
      : undefined

    const common = {
      ...(label ? { label } : {}),
      up: s.up,
      down: s.down,
      depthUp: s.depthUp,
      depthDown: s.depthDown,
      open: (s.open as string[]).slice(0, TRACE_SHARE_OPEN_CAP),
    }
    return urns
      ? { v: 2, urn: urns[0]!, urns, ...common }
      : { v: 1, urn: s.urn as string, ...common }
  } catch {
    return null
  }
}
