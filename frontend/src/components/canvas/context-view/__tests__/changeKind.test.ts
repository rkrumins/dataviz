/**
 * The two kinds of change a move makes, said the same way on every surface: a DATA change (the
 * entity moves under another parent — every view that has it follows) or a VIEW change (only where
 * this view shows it). Who a data change reaches is counted from the views the reader can see.
 */
import { describe, expect, it } from 'vitest'
import {
  columnChoices, dataNoticeTail, dataReachDetail, dataTagText, moveDialogBody, moveDialogReach, moveFooter,
  moveReachLine, reachNote, viewNotice, type DataReach,
} from '../changeKind'
import type { MoveVerdict } from '../useReparentNode'

const alone: DataReach = { otherViews: 0, inDraft: true }
const one: DataReach = { otherViews: 1, source: 'Retail data pipeline', sourceId: 'ds-retail', inDraft: true }
const three: DataReach = { ...one, otherViews: 3 }
const onMain: DataReach = { ...three, inDraft: false }

describe('who a data change reaches', () => {
  it('every view, when no other view on the data source is known', () => {
    expect(dataReachDetail(alone)).toBe('every view')
    expect(dataTagText(alone)).toBe('Changes the data · every view')
  })

  it('this view and the others on its data source, counted', () => {
    expect(dataTagText(one)).toBe('Changes the data · this view and 1 other on Retail data pipeline')
    expect(dataTagText(three)).toBe('Changes the data · this view and 3 others on Retail data pipeline')
  })

  it('says only what is counted: a note that private views follow too, the id in the Technical view', () => {
    expect(reachNote(alone, 'business')).toBeUndefined()
    expect(reachNote(three, 'business')).toBe('Counted from the views you can see — others’ private views follow too.')
    expect(reachNote(three, 'technical')).toBe('Counted from the views you can see — others’ private views follow too. Data source: ds-retail')
  })

  it('a move’s notice: once published in a draft, once saved on main', () => {
    expect(dataNoticeTail(alone)).toBe('A data change — every view that shows it, once published.')
    expect(dataNoticeTail(one)).toBe('A data change — this view now, and 1 other view on Retail data pipeline once published.')
    expect(dataNoticeTail(three)).toBe('A data change — this view now, and 3 other views on Retail data pipeline once published.')
    expect(dataNoticeTail(onMain)).toBe('A data change — this view now, and 3 other views on Retail data pipeline once saved.')
  })

  it('the move dialog: what moves, and every other view that follows', () => {
    expect(moveDialogBody('CRM', alone)).toBe('This changes the data: CRM and everything inside it move under the parent you pick — in every view that shows it, once published. Its lineage stays as it is.')
    expect(moveDialogReach('CRM', alone)).toBeUndefined()
    expect(moveDialogReach('CRM', three)).toBe('Retail data pipeline has 3 other views. Each one that shows CRM will show it under the new parent once published.')
    expect(moveDialogReach('CRM', { ...one, inDraft: false })).toBe('Retail data pipeline has 1 other view. Each one that shows CRM will show it under the new parent once saved.')
  })

  it('the drawer’s line and the Move to Layer footer', () => {
    expect(moveReachLine(alone)).toBe('It and everything inside it move — in every view that shows it, once published.')
    expect(moveReachLine(three)).toBe('It and everything inside it move — in this view now, and in 3 other views on Retail data pipeline once published.')
    expect(moveFooter(alone)).toBe('Only this view: the data doesn’t change. Changes the data: it moves in every view once published.')
    expect(moveFooter(three)).toBe('Only this view: the data doesn’t change. Changes the data: it moves in this view and every other view on Retail data pipeline once published.')
  })
})

describe('a view change, said as one', () => {
  it('names where it shows now, that the data is unchanged — and what follows it', () => {
    expect(viewNotice('CRM now shows in Apps.')).toBe('CRM now shows in Apps. Only this view — the data is unchanged.')
    expect(viewNotice('CRM now shows in Apps.', 1)).toBe('CRM now shows in Apps. Only this view — the data is unchanged. 1 placed inside it now follows it.')
    expect(viewNotice('CRM now shows in Apps.', 3)).toBe('CRM now shows in Apps. Only this view — the data is unchanged. 3 placed inside it now follow it.')
  })
})

describe('Move to Layer: what each column would do', () => {
  const layers = [
    { id: 'fin', name: 'Finance', color: '#111', entityTypes: [], anchorUrn: 'Finance' },
    { id: 'domains', name: 'Domains', color: '#222', entityTypes: ['domain'] },
    { id: 'apps', name: 'Apps', color: '#333', entityTypes: ['app'] },
    { id: 'picked', name: 'Picked', color: '#444', entityTypes: [] },
  ]
  const anchorOf = (l: { anchorUrn?: string }) => (l.anchorUrn === 'Finance' ? { id: 'Finance', name: 'Money' } : undefined)
  const data: MoveVerdict = { kind: 'data', edgeType: 'CONTAINS' }
  const rows = (verdict: MoveVerdict, shownIn = 'domains', entityId = 'CRM') =>
    columnChoices(layers, { entityId, shownIn, anchorOf, verdict: () => verdict })
      .map((c) => [c.layerId, c.column, c.change, c.label, c.hint ?? null])

  it('a mapped column offers both: move inside its entity (data), or show in the column (view)', () => {
    expect(rows(data)).toEqual([
      ['fin', 'mapped', 'data', 'Move inside Money', null],
      ['fin', 'mapped', 'view', 'Show in Finance column', null],
      ['domains', 'byType', 'view', 'Show in Domains', 'Shown here'],
      ['apps', 'byType', 'view', 'Show in Apps', null],
      ['picked', 'handPicked', 'view', 'Show in Picked', null],
    ])
    expect(columnChoices(layers, { entityId: 'CRM', shownIn: 'domains', anchorOf, verdict: () => data })[0].parentId).toBe('Finance')
  })

  it('a move refused says why; one already inside says so', () => {
    expect(rows({ kind: 'blocked', hint: 'A trace is read-only', message: '', tone: 'info' })[0]).toEqual(
      ['fin', 'mapped', 'data', 'Move inside Money', 'A trace is read-only'])
    expect(rows({ kind: 'none' }, 'fin')[0]).toEqual(['fin', 'mapped', 'data', 'Move inside Money', 'Already inside Money'])
    expect(rows({ kind: 'view' })[0]).toEqual(['fin', 'mapped', 'data', 'Move inside Money', 'Already inside Money'])
    expect(rows({ kind: 'none' }, 'fin')[1]).toEqual(['fin', 'mapped', 'view', 'Show in Finance column', 'Shown here'])
  })

  it('the column’s own entity is not offered a move inside itself', () => {
    expect(rows(data, 'fin', 'Finance').filter((r) => r[0] === 'fin')).toEqual([['fin', 'mapped', 'view', 'Show in Finance column', 'Shown here']])
  })
})
