import { describe, it, expect } from 'vitest'
import { makeRow, type BuildRow } from '../buildRow'
import { filterStageableRows } from '../applyBuild'

const errored = (partial: Parameters<typeof makeRow>[0]): BuildRow => ({ ...makeRow(partial), status: 'error', issues: [{ message: 'bad' }] })
const fixed = (partial: Parameters<typeof makeRow>[0]): BuildRow => ({ ...makeRow(partial), status: 'fixed' })

describe('filterStageableRows', () => {
  it('passes everything through when nothing errored', () => {
    const rows: BuildRow[] = [
      makeRow({ id: '1', name: 'Domain', typeId: 'domain' }),
      fixed({ id: '2', name: 'Platform', typeId: 'dataPlatform', parentId: '1' }),
    ]
    expect(filterStageableRows(rows)).toEqual(rows)
  })

  it('skips a row with status: error', () => {
    const rows: BuildRow[] = [
      makeRow({ id: '1', name: 'Domain', typeId: 'domain' }),
      errored({ id: '2', name: 'Bad', typeId: null, parentId: '1' }),
    ]
    const result = filterStageableRows(rows)
    expect(result.map((r) => r.id)).toEqual(['1'])
  })

  it('skips an errored row AND all its descendants, even valid/fixed ones', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'root', name: 'Root', typeId: 'domain' }),
      errored({ id: 'bad', name: 'Bad', typeId: null, parentId: 'root' }),
      makeRow({ id: 'child', name: 'Child', typeId: 'dataPlatform', parentId: 'bad' }),
      fixed({ id: 'grandchild', name: 'Grandchild', typeId: 'container', parentId: 'child' }),
    ]
    const result = filterStageableRows(rows)
    expect(result.map((r) => r.id)).toEqual(['root'])
  })

  it('keeps a valid sibling of an errored row (not a descendant)', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'root', name: 'Root', typeId: 'domain' }),
      errored({ id: 'bad', name: 'Bad', typeId: null, parentId: 'root' }),
      makeRow({ id: 'good', name: 'Good', typeId: 'dataPlatform', parentId: 'root' }),
    ]
    const result = filterStageableRows(rows)
    expect(result.map((r) => r.id)).toEqual(['root', 'good'])
  })

  it('handles multiple independent errored subtrees', () => {
    const rows: BuildRow[] = [
      errored({ id: 'bad1', name: 'Bad1', typeId: null }),
      makeRow({ id: 'bad1-child', name: 'Bad1 Child', typeId: 'dataPlatform', parentId: 'bad1' }),
      errored({ id: 'bad2', name: 'Bad2', typeId: null }),
      makeRow({ id: 'ok', name: 'Ok', typeId: 'domain' }),
    ]
    const result = filterStageableRows(rows)
    expect(result.map((r) => r.id)).toEqual(['ok'])
  })

  it('returns an empty array when every row is errored', () => {
    const rows: BuildRow[] = [errored({ id: '1', name: 'Bad', typeId: null })]
    expect(filterStageableRows(rows)).toEqual([])
  })
})
