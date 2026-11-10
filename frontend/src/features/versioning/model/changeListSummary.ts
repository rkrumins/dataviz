/** What a change list's summary says by kind and by type, for the surfaces that narrow the list. */
import type { ChangeListCounts, ChangeListKind, ChangeListSummary } from '@/services/versioningApiService'

export const KIND_LABEL: Record<ChangeListKind, string> = {
  node: 'Entities', edge: 'Relationships', structure: 'Structure',
}

export const changeTotal = (c?: ChangeListCounts | null) => (c ? c.added + c.modified + c.removed : 0)

export function kindCounts(s: ChangeListSummary, kind: ChangeListKind): ChangeListCounts | null | undefined {
  return kind === 'node' ? s.entityCounts : kind === 'edge' ? s.edgeCounts : s.structureCounts
}

/** The kinds a change list holds changes of, entities first. */
export function kindsOf(s: ChangeListSummary): ChangeListKind[] {
  return (['node', 'edge', 'structure'] as const).filter((k) => changeTotal(kindCounts(s, k)) > 0)
}

/** The narrowing by type a kind offers: its types, most changed first. */
export function typeOptionsOf(s: ChangeListSummary | null, kind: ChangeListKind | undefined) {
  return (s?.byType ?? []).filter((t) => t.kind === kind)
    .map((t) => ({ type: t.type ?? '', n: t.added + t.modified + t.removed }))
    .sort((a, b) => b.n - a.n)
}
