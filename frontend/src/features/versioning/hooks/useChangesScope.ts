/**
 * useChangesScope — what a review lists, resolved against where the canvas is.
 *
 * - **A draft open:** its changes (`{branchId}`).
 * - **A past revision #N open:** what changed since it, up to the head it was opened at
 *   (`{N, headAtOpen}`), or what #N itself changed (`{N−1, N}`).
 * - **Two revisions compared on the canvas:** that range (`{from, to}`).
 * - **Published, nothing open:** what the latest revision changed (`{H−1, H}`).
 *
 * `options` are the scopes the review offers there, the default first. The review's own choice
 * wins while it is one of them, so a draft opened or a revision closed under a review falls back to
 * the new default rather than listing what the canvas no longer shows.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { ChangeListOrigin } from '@/services/versioningApiService'
import { useBranchStore, useEffectiveBranchId, type OpenRevision, type RevisionHighlight } from '@/store/branchStore'
import { useReviewStore, type ReviewScope } from '@/store/reviewStore'

export interface ScopeOption {
  scope: ReviewScope
  origin: ChangeListOrigin
  /** Its name, as the review's title says it. */
  label: string
  /** The two revisions to highlight so the canvas draws it, where that keeps the canvas where it
   *  is; absent where the canvas draws it already, or can't without moving in time. */
  highlight?: RevisionHighlight
}

const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)

export function resolveScopes({ branchId, revision, highlight, head, chosen }: {
  branchId: string | null
  revision: OpenRevision | null
  highlight: RevisionHighlight | null
  head: number
  chosen: ReviewScope | null
}): { options: ScopeOption[]; current: ScopeOption | null } {
  const options: ScopeOption[] = []
  // One list, offered once: a highlight of what #N changed is "Changed in #N".
  const add = (o: ScopeOption) => { if (!options.some((x) => same(x.origin, o.origin))) options.push(o) }
  // Each range offered is the highlight already drawn, or ends at the revision open (at the head,
  // with none open): highlighting it draws it without moving the canvas in time.
  const range = (fromSeq: number, toSeq: number): ScopeOption => {
    const drawn = !!highlight && highlight.fromSeq === fromSeq && highlight.toSeq === toSeq
    const single = toSeq === fromSeq + 1
    return {
      scope: single ? { kind: 'in', seq: toSeq } : { kind: 'between', fromSeq, toSeq },
      origin: { fromSeq, toSeq },
      label: !single ? `#${fromSeq} → #${toSeq}`
        : !revision && toSeq === head ? `The latest revision · #${toSeq}` : `Changed in #${toSeq}`,
      ...(drawn ? {} : { highlight: { fromSeq, toSeq } }),
    }
  }
  if (branchId) {
    add({ scope: { kind: 'draft' }, origin: { branchId }, label: 'This draft' })
  } else {
    if (highlight && highlight.fromSeq < highlight.toSeq) add(range(highlight.fromSeq, highlight.toSeq))
    if (revision) {
      const { seq, headAtOpen } = revision
      if (seq < headAtOpen) {
        add({ scope: { kind: 'since', seq }, origin: { fromSeq: seq, toSeq: headAtOpen }, label: `Since #${seq}` })
      }
      if (seq >= 1) add(range(seq - 1, seq))
    } else if (head >= 1) {
      add(range(head - 1, head))
    }
  }
  const current = (chosen && options.find((o) => same(o.scope, chosen))) || options[0] || null
  return { options, current }
}

/**
 * While a review is open, the canvas draws its scope wherever a highlight can (`highlight`): what
 * the revision open changed, or the latest revision on Published. The highlight it set goes when
 * the review ends or moves to another scope — unless something else has replaced it by then.
 */
export function useDrawScope(current: ScopeOption | null, open: boolean) {
  const ours = useRef<RevisionHighlight | null>(null)
  const shown = open && current ? JSON.stringify(current.origin) : null
  const want = open ? current?.highlight ?? null : null
  const wantKey = want ? JSON.stringify(want) : null
  useEffect(() => {
    const { highlight, setHighlight } = useBranchStore.getState()
    if (ours.current && JSON.stringify(ours.current) !== shown) {
      if (highlight && same(highlight, ours.current)) setHighlight(null)
      ours.current = null
    }
    if (want) {
      ours.current = want
      setHighlight(want)
    }
    // `want` is read through its key: a new object for the same range is the same ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, wantKey])
  useEffect(() => () => {
    const { highlight, setHighlight } = useBranchStore.getState()
    if (ours.current && highlight && same(highlight, ours.current)) setHighlight(null)
  }, [])
}

/** What a review lists on the canvas of `viewId` (the active view's), and what else it offers. */
export function useChangesScope(viewId?: string | null) {
  const wsId = useBranchStore((s) => s.workspaceId)
  const dataSourceId = useBranchStore((s) => s.dataSourceId)
  const graphId = useBranchStore((s) => s.graphId)
  const branchId = useEffectiveBranchId(wsId ?? '', dataSourceId, viewId)
  const revision = useBranchStore((s) => s.revision)
  const highlight = useBranchStore((s) => s.highlight)
  const head = useBranchStore((s) => s.mainHeadCommitSeq)
  const chosen = useReviewStore((s) => s.scope)
  const resolved = useMemo(
    () => resolveScopes({ branchId, revision, highlight, head, chosen }),
    [branchId, revision, highlight, head, chosen],
  )
  return { wsId, graphId, ...resolved }
}
