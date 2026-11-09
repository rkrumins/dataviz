/**
 * What the canvas may do at a past revision of Published, in one place.
 *
 * A revision is read-only, and only some reads can be answered as the graph was then: the server
 * answers name search and lineage closures exactly, and refuses everything that reads the graph as
 * it is now — Advanced Search and the display rules built on it, subset views and Narrow, rolled-up
 * traces. Every surface asks here rather than testing `asOfSeq` itself, so they agree; the provider
 * refuses the rest before sending it (`providers/revisionReads.ts`).
 */
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'

export interface RevisionCapabilities {
  /** The canvas reads a past revision. */
  atRevision: boolean
  /** Search by name or qualified name — at a revision, as the names were then. */
  nameSearch: boolean
  /** Lineage closures (the canvas trace, the Lens, a panel's neighbours), as the flows ran then. */
  lineageTrace: boolean
  /** Off at a revision: they read the graph as it is now. */
  advancedSearch: boolean
  displayRules: boolean
  subsetViews: boolean
  narrow: boolean
  rolledUpTraces: boolean
  /** Off at a revision: it is read-only. */
  editing: boolean
}

const NOW: RevisionCapabilities = {
  atRevision: false, nameSearch: true, lineageTrace: true, advancedSearch: true,
  displayRules: true, subsetViews: true, narrow: true, rolledUpTraces: true, editing: true,
}
const THEN: RevisionCapabilities = {
  atRevision: true, nameSearch: true, lineageTrace: true, advancedSearch: false,
  displayRules: false, subsetViews: false, narrow: false, rolledUpTraces: false, editing: false,
}

/** What a read at ``asOfSeq`` allows (none: the graph as it is now, where nothing is held back). */
export function revisionCapabilities(asOfSeq: number | null | undefined): RevisionCapabilities {
  return asOfSeq == null ? NOW : THEN
}

/** What the canvas being read allows: its revision is the view's read context's. */
export function useRevisionCapabilities(): RevisionCapabilities {
  return revisionCapabilities(useViewExecutionContext()?.asOfSeq)
}
