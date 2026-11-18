/**
 * useViewedChanges — a reviewer's own "Viewed" ticks on a review's changes, so a long review is
 * worked through and where they got to is kept. Each tick holds what the change said when it was
 * viewed (its status and what it changed): a change that moved on since reads "changed since you
 * viewed it", unticked. Kept in this browser, per review — a convenience, never a record; storage
 * that is unavailable just means nothing is remembered.
 */
import { useCallback, useState } from 'react'
import type { ChangeListRow } from '@/services/versioningApiService'

const keyOf = (prId: string) => `nexus-viewed:${prId}`

/** What a change said, in short: a tick holds while it still says the same. */
export function fingerprint(row: ChangeListRow): string {
  const f = row.fields
  const top = f ? f.top.map((t) => `${t.kind}:${t.label}:${JSON.stringify(t.after ?? null)}`).join('|') : ''
  return `${row.status}#${f?.total ?? ''}#${top}`
}

function read(prId: string | undefined): Record<string, string> {
  if (!prId) return {}
  try {
    const raw = window.localStorage.getItem(keyOf(prId))
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function useViewedChanges(prId: string | undefined) {
  const [seen, setSeen] = useState<Record<string, string>>(() => read(prId))
  const [readFor, setReadFor] = useState(prId)
  if (readFor !== prId) {
    setReadFor(prId)
    setSeen(read(prId))
  }
  const write = useCallback((next: Record<string, string>) => {
    setSeen(next)
    if (!prId) return
    try { window.localStorage.setItem(keyOf(prId), JSON.stringify(next)) } catch { /* not remembered */ }
  }, [prId])

  const isViewed = useCallback((row: ChangeListRow) => seen[row.entityId] === fingerprint(row), [seen])
  const changedSince = useCallback((row: ChangeListRow) => !!seen[row.entityId] && seen[row.entityId] !== fingerprint(row), [seen])
  const toggle = useCallback((row: ChangeListRow, on?: boolean) => {
    const viewed = seen[row.entityId] === fingerprint(row)
    const next = { ...seen }
    if (on ?? !viewed) next[row.entityId] = fingerprint(row)
    else delete next[row.entityId]
    write(next)
  }, [seen, write])
  return { isViewed, changedSince, toggle, enabled: !!prId }
}
