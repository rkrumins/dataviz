/**
 * traceHistoryStack — browser-style back/forward over the user's traces,
 * per view, with localStorage round-tripping.
 *
 * The Lens's lensHistory semantics (entries + cursor; push truncates the
 * forward side; back/forward/jump never drop entries), over RICH entries:
 * each records the focal AND the view it was traced with (direction
 * toggles, hop depths, and WHICH CARDS WERE OPEN), so "back" restores the
 * trace AS IT WAS VIEWED — the same picture, not just the same focus.
 *
 * One deliberate rule: pushing the CURRENT focal again never adds an
 * entry — it updates the current entry's view params in place. A Root
 * Cause → Impact flip on the same node is one trace, not two; without
 * this, back/forward degenerates into stepping through direction flips.
 *
 * Pure module: no React, no storage access — serialize/hydrate work on
 * strings, the caller owns localStorage (and, later, a server mirror).
 */

export interface TraceViewParams {
    showUpstream: boolean
    showDownstream: boolean
    depthUp: number
    depthDown: number
    /** WHICH CARDS WERE OPEN — sorted and deduped, so two identical
     *  pictures serialize identically. EMPTY means "as the trace opened":
     *  a restore then lets the overlay's own seed decide, which is right
     *  for a trace the reader never expanded (and is the only sane reading
     *  of history written before this field existed). */
    traceExpansion: string[]
}

export interface TraceHistoryEntryRecord {
    /** The traced entity's urn — what a restore re-traces. */
    urn: string
    /** Canvas node id at trace time (display-name resolution in the dock). */
    focusId: string
    /** How the user was viewing this trace when they left it. */
    view: TraceViewParams
    /** Wall-clock ms of the trace (updated on same-focal re-push). */
    timestamp: number
}

export interface TraceHistoryStack {
    entries: TraceHistoryEntryRecord[]
    /** Index of the current entry; -1 when empty. */
    cursor: number
}

/** Stored-entry cap per view — oldest pruned at serialize time. */
export const TRACE_HISTORY_CAP = 50

const STORAGE_VERSION = 1

/** The reader's open cards as a stable value. Sorted + deduped so the same
 *  picture always compares and serializes the same. */
export function normalizeTraceExpansion(ids: readonly string[] | undefined): string[] {
    return ids && ids.length > 0 ? [...new Set(ids)].sort() : []
}

/** Every write goes through here, so no caller has to remember the rule. */
function normalizeView(view: TraceViewParams): TraceViewParams {
    return { ...view, traceExpansion: normalizeTraceExpansion(view.traceExpansion) }
}

export function emptyTraceHistory(): TraceHistoryStack {
    return { entries: [], cursor: -1 }
}

export function currentTraceEntry(h: TraceHistoryStack): TraceHistoryEntryRecord | null {
    return h.entries[h.cursor] ?? null
}

/** Push a focal: truncates the forward side; a re-push of the CURRENT
 *  focal updates its view/timestamp in place instead. */
export function pushTraceFocal(h: TraceHistoryStack, entry: TraceHistoryEntryRecord): TraceHistoryStack {
    const current = currentTraceEntry(h)
    if (current && current.urn === entry.urn) {
        const entries = [...h.entries]
        entries[h.cursor] = { ...current, view: normalizeView(entry.view), timestamp: entry.timestamp }
        return { entries, cursor: h.cursor }
    }
    const entries = [...h.entries.slice(0, h.cursor + 1), { ...entry, view: normalizeView(entry.view) }]
    return { entries, cursor: entries.length - 1 }
}

/** Record the view params the user leaves behind on the current entry. */
export function updateCurrentTraceView(h: TraceHistoryStack, view: TraceViewParams): TraceHistoryStack {
    const current = currentTraceEntry(h)
    if (!current) return h
    const entries = [...h.entries]
    entries[h.cursor] = { ...current, view: normalizeView(view) }
    return { entries, cursor: h.cursor }
}

export function traceHistoryBack(h: TraceHistoryStack): TraceHistoryStack {
    return h.cursor > 0 ? { entries: h.entries, cursor: h.cursor - 1 } : h
}

export function traceHistoryForward(h: TraceHistoryStack): TraceHistoryStack {
    return h.cursor < h.entries.length - 1 ? { entries: h.entries, cursor: h.cursor + 1 } : h
}

export function traceHistoryJump(h: TraceHistoryStack, index: number): TraceHistoryStack {
    return index >= 0 && index < h.entries.length && index !== h.cursor
        ? { entries: h.entries, cursor: index }
        : h
}

/** Serialize for storage, pruning to the cap (oldest first) and keeping
 *  the cursor on the same entry (clamped if it was pruned away). */
export function serializeTraceHistory(h: TraceHistoryStack): string {
    const overflow = Math.max(0, h.entries.length - TRACE_HISTORY_CAP)
    const entries = overflow > 0 ? h.entries.slice(overflow) : h.entries
    const cursor = Math.max(0, Math.min(h.cursor - overflow, entries.length - 1))
    return JSON.stringify({ v: STORAGE_VERSION, entries, cursor: entries.length === 0 ? -1 : cursor })
}

function isValidEntry(e: unknown): e is TraceHistoryEntryRecord {
    if (typeof e !== 'object' || e === null) return false
    const r = e as Record<string, unknown>
    const v = r.view as Record<string, unknown> | undefined
    return typeof r.urn === 'string'
        && typeof r.focusId === 'string'
        && typeof r.timestamp === 'number'
        && typeof v === 'object' && v !== null
        && typeof v.showUpstream === 'boolean'
        && typeof v.showDownstream === 'boolean'
        && typeof v.depthUp === 'number'
        && typeof v.depthDown === 'number'
        // Absent is fine — entries written before the expansion picture
        // existed. A WRONG shape is not: half-loading it would restore a
        // picture nobody left.
        && (v.traceExpansion === undefined
            || (Array.isArray(v.traceExpansion) && v.traceExpansion.every(id => typeof id === 'string')))
}

/** Hydrate from storage. Junk, version drift, or malformed shapes start
 *  empty — history is a convenience, never worth an error state. */
export function hydrateTraceHistory(raw: string | null): TraceHistoryStack {
    if (!raw) return emptyTraceHistory()
    try {
        const parsed = JSON.parse(raw) as { v?: number; entries?: unknown; cursor?: unknown }
        if (parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.entries)) return emptyTraceHistory()
        const valid = parsed.entries.filter(isValidEntry)
        if (valid.length !== parsed.entries.length) return emptyTraceHistory()
        const entries = valid.map(e => ({
            ...e,
            view: { ...e.view, traceExpansion: normalizeTraceExpansion(e.view.traceExpansion) },
        }))
        const cursor = typeof parsed.cursor === 'number' ? parsed.cursor : -1
        if (entries.length === 0) return emptyTraceHistory()
        return { entries, cursor: Math.max(0, Math.min(cursor, entries.length - 1)) }
    } catch {
        return emptyTraceHistory()
    }
}
