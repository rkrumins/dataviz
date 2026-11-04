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
 *
 * Whether the revision exists and can be opened is the banner's to say (`useRevision`): it asks
 * before anything is drawn, and guides the reader when it can't be.
 */
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { OpenRevision } from '@/store/branchStore'

export function useRevisionDeepLink({
  enabled,
  headSeq,
  revisionSeq,
  scopeViewId,
  activeViewId,
  openRevision,
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
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlRev = searchParams.get('rev')
  const handledRef = useRef<string | null>(null)
  const wasOpenRef = useRef(false)
  const viewResolved = scopeViewId === activeViewId

  // URL → store.
  useEffect(() => {
    if (!enabled || !urlRev || !viewResolved || headSeq == null) return
    if (handledRef.current === urlRev) return
    handledRef.current = urlRev
    const seq = /^\d+$/.test(urlRev) ? Number(urlRev) : NaN
    if (Number.isSafeInteger(seq) && seq < headSeq) {
      if (seq !== revisionSeq) openRevision({ seq })
      if (searchParams.has('branch')) {
        setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('branch'); return n }, { replace: true })
      }
      return
    }
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('rev'); return n }, { replace: true })
  }, [enabled, urlRev, viewResolved, headSeq, revisionSeq, openRevision, searchParams, setSearchParams])

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
