/**
 * useRevisionDeepLink — two-way sync between the URL's `?rev=<seq>` and the past revision open on
 * the canvas, so the graph as it was is a link to share or bookmark (/views/view_abc?rev=128).
 *
 *   • URL → store: once the store has resolved the active view, a `?rev=` naming a revision before
 *     Published's head opens it. One at the head is Published itself, and one that isn't a number
 *     names nothing: the param is dropped and the canvas stays on Published. A revision is of
 *     Published, so a `?branch=` beside it goes.
 *   • store → URL: the open revision as `?rev=` (replace, no history spam); closing it clears the
 *     param. So "Copy link" is always the graph on screen.
 *   • `&hl=<from>` beside it, read once as the link opens: what changed after `from` up to that
 *     revision is highlighted on it (on Published, for one at the head), and the param goes. One
 *     without a revision, or not before it, names nothing and goes too.
 *
 * Whether the revision exists and can be opened is the banner's to say (`useRevision`): it asks
 * before anything is drawn, and guides the reader when it can't be.
 */
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { OpenRevision, RevisionHighlight } from '@/store/branchStore'

export function useRevisionDeepLink({
  enabled,
  headSeq,
  revisionSeq,
  scopeViewId,
  activeViewId,
  openRevision,
  setHighlight,
}: {
  /** The preview is on and the view's graph is version-controlled. */
  enabled: boolean
  /** Published's head, once resolved. */
  headSeq: number | null
  /** The revision open in this scope, or null. */
  revisionSeq: number | null
  /** The view the branch store has resolved (`setResolved`'s scope)… */
  scopeViewId?: string | null
  /** …and the active one: until they agree the store is mid view-switch, and the link waits. */
  activeViewId?: string | null
  openRevision: (revision: OpenRevision) => void
  setHighlight: (highlight: RevisionHighlight) => void
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlRev = searchParams.get('rev')
  const urlHl = searchParams.get('hl')
  const handledRef = useRef<string | null>(null)
  const wasOpenRef = useRef(false)
  const viewResolved = scopeViewId === activeViewId

  // URL → store. One URL edit per run: a second in the same run would start from the same params
  // as the first, and put back what it took out.
  useEffect(() => {
    if (!enabled || !viewResolved || headSeq == null) return
    if (!urlRev || handledRef.current === urlRev) {
      // A highlight is read only with the revision its link opens: without one, or back again after
      // it (the write below starts from the link's params when another revision was open), it goes.
      if (urlHl != null) {
        setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('hl'); return n }, { replace: true })
      }
      return
    }
    handledRef.current = urlRev
    const seq = /^\d+$/.test(urlRev) ? Number(urlRev) : NaN
    const from = urlHl != null && /^\d+$/.test(urlHl) ? Number(urlHl) : NaN
    if (Number.isSafeInteger(seq) && seq < headSeq) {
      if (seq !== revisionSeq) openRevision({ seq, headAtOpen: headSeq })
      if (from < seq) setHighlight({ fromSeq: from, toSeq: seq })
      if (searchParams.has('branch') || urlHl != null) {
        setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('branch'); n.delete('hl'); return n }, { replace: true })
      }
      return
    }
    // At the head the link names Published as it is, where the highlight is drawn — unless a
    // revision is open: that stays, and it isn't the graph the comparison ends at.
    if (seq === headSeq && from < seq && revisionSeq == null) setHighlight({ fromSeq: from, toSeq: seq })
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('rev'); n.delete('hl'); return n }, { replace: true })
  }, [enabled, urlRev, urlHl, viewResolved, headSeq, revisionSeq, openRevision, setHighlight, searchParams, setSearchParams])

  // store → URL.
  useEffect(() => {
    if (!enabled || !viewResolved) return
    if (revisionSeq != null) {
      wasOpenRef.current = true
      const want = String(revisionSeq)
      if (urlRev !== want) {
        handledRef.current = want
        setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('rev', want); return n }, { replace: true })
      }
    } else if (urlRev && wasOpenRef.current) {
      // Only once a revision was open and has closed: a link not applied yet keeps its param.
      wasOpenRef.current = false
      setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('rev'); return n }, { replace: true })
    }
  }, [enabled, viewResolved, revisionSeq, urlRev, setSearchParams])
}
