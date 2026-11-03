import { describe, expect, it } from 'vitest'

import type { MembershipResult } from '@/types/membership'

import { visibilityOf } from '../model'
import { narrowRows, type NarrowRow } from '../narrowRows'

function vis(partial: Partial<MembershipResult>) {
  return visibilityOf({
    specHash: 'h', members: [], wholeSubtree: [], chains: {},
    counts: { seeds: 0, inside: 0, upstream: 0, downstream: 0, partnerInside: 0, total: 0 },
    missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0, ...partial,
  })
}

const row = (id: string, depth: number, extra: Partial<NarrowRow> = {}): NarrowRow =>
  ({ node: { id, urn: id }, depth, ...extra })

const ids = (rows: NarrowRow[]) => rows.map((r) => (r.isLoadMore ? `more:${r.node.id}` : r.node.id))
const none = () => false

//   dom
//     tbl_a
//       col_a1      ← member
//       col_a2
//     tbl_b
//       col_b1
//   other
const TREE: NarrowRow[] = [
  row('dom', 0), row('tbl_a', 1), row('col_a1', 2), row('col_a2', 2),
  row('tbl_b', 1), row('col_b1', 2), row('other', 0),
]

describe('narrowRows', () => {
  it('keeps the members and the containers on the way to them', () => {
    const v = vis({ members: [{ urn: 'col_a1', via: 'seed' }], chains: { col_a1: ['tbl_a', 'dom'] } })
    expect(ids(narrowRows(TREE, v, none))).toEqual(['dom', 'tbl_a', 'col_a1'])
  })

  it('keeps everything inside a member whose whole inside is in scope', () => {
    const v = vis({ members: [{ urn: 'tbl_b', via: 'seed' }], chains: { tbl_b: ['dom'] }, wholeSubtree: ['tbl_b'] })
    expect(ids(narrowRows(TREE, v, none))).toEqual(['dom', 'tbl_b', 'col_b1'])
  })

  it('never draws a member without its parent, even when its chain is not known', () => {
    const v = vis({ members: [{ urn: 'col_b1', via: 'upstream', hops: 1 }] })   // no chain (chains cap)
    expect(ids(narrowRows(TREE, v, none))).toEqual(['dom', 'tbl_b', 'col_b1'])
  })

  it('keeps what the reader has selected', () => {
    const v = vis({ members: [{ urn: 'col_a1', via: 'seed' }], chains: { col_a1: ['tbl_a', 'dom'] } })
    expect(ids(narrowRows(TREE, v, (id) => id === 'other'))).toEqual(['dom', 'tbl_a', 'col_a1', 'other'])
  })

  it('pages a container only where its inside is in scope', () => {
    const rows = [
      row('dom', 0), row('tbl_a', 1), row('col_a1', 2), row('tbl_a', 2, { isLoadMore: true }),
      row('tbl_b', 1), row('tbl_b', 2, { isLoadMore: true }),
      row('feed:l1', 0, { isLoadMore: true, isFeedMore: true }),
    ]
    // tbl_a holds a member (more of them may be on the next page); tbl_b is a member with nothing inside in scope.
    const v = vis({
      members: [{ urn: 'col_a1', via: 'seed' }, { urn: 'tbl_b', via: 'downstream', hops: 1 }],
      chains: { col_a1: ['tbl_a', 'dom'], tbl_b: ['dom'] },
    })
    expect(ids(narrowRows(rows, v, none))).toEqual(['dom', 'tbl_a', 'col_a1', 'more:tbl_a', 'tbl_b', 'more:feed:l1'])
  })

  it('keeps an inline search hit only when it is in scope', () => {
    const hit = (urn: string) => row('tbl_a', 2, { isSearchHit: true, hit: { node: { urn } } })
    const rows = [row('dom', 0), row('tbl_a', 1), hit('col_a1'), hit('col_a2')]
    const v = vis({ members: [{ urn: 'col_a1', via: 'seed' }], chains: { col_a1: ['tbl_a', 'dom'] } })
    const kept = narrowRows(rows, v, none)
    expect(kept.filter((r) => r.isSearchHit).map((r) => r.hit!.node.urn)).toEqual(['col_a1'])
  })
})
