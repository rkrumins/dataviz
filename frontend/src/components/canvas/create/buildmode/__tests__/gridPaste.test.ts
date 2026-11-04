/**
 * Pasting a spreadsheet block into a Grid cell: its cells land across the Grid's columns (Name,
 * Type, Parent, Layer, Description) from the one pasted into, its lines fill the rows below and then
 * add rows up to the Build limit, and what it leaves out — lines past the limit, cells past the last
 * column, values that name no type, row or layer here — is counted for the Grid to say so.
 */
import { describe, it, expect } from 'vitest'
import { planGridPaste, applyGridPaste, BUILD_ROW_LIMIT } from '../gridPaste'
import { makeRow, type BuildRow } from '../buildRow'

const rows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
  makeRow({ id: 'd', name: 'D', parentId: 'a' }),
  makeRow({ id: 'e', name: 'E', parentId: null }),
]

describe('planGridPaste (a spreadsheet block pasted into a cell)', () => {
  const ids = ['a', 'b', 'c']
  const at = (over: Partial<Parameters<typeof planGridPaste>[1]> = {}) =>
    ({ ids, startId: 'b', column: 'name' as const, rowCount: 3, mintId: (() => { let n = 0; return () => `new${++n}` })(), ...over })

  it('lays tab-separated cells across the Grid’s columns from the one pasted into', () => {
    const p = planGridPaste('Orders\tTable\tSales\tWarehouse\tAll orders', at())!
    expect(p.rows).toEqual([{ id: 'b', cells: { name: 'Orders', type: 'Table', parent: 'Sales', layer: 'Warehouse', description: 'All orders' } }])
    expect(planGridPaste('Orders\tTable', at({ column: 'description' }))!.rows[0].cells).toEqual({ description: 'Orders' })
  })

  it('fills the rows below, then adds rows — ignoring the newline a spreadsheet copy ends with', () => {
    const p = planGridPaste('B2\r\nC2\r\nN1\r\nN2\r\n', at())!
    expect(p.rows.map((r) => [r.id, r.cells.name])).toEqual([['b', 'B2'], ['c', 'C2'], ['new1', 'N1'], ['new2', 'N2']])
    expect(p.added).toEqual(['new1', 'new2'])
    expect(p.skippedLines).toBe(0)
  })

  it('stops adding rows at the Build limit, and counts what it left out', () => {
    const p = planGridPaste('B2\nC2\nN1\nN2\nN3', at({ rowCount: 4, limit: 5 }))!
    expect(p.rows.map((r) => r.id)).toEqual(['b', 'c', 'new1'])
    expect(p.skippedLines).toBe(2)
    expect(BUILD_ROW_LIMIT).toBe(2000)
  })

  it('counts cells past the Grid’s last column instead of dropping them silently', () => {
    expect(planGridPaste('x\ty\tz', at({ column: 'layer' }))!.skippedCells).toBe(1)
  })

  it('leaves a single plain cell to the input', () => {
    expect(planGridPaste('Orders', at())).toBeNull()
    expect(planGridPaste('Orders\n', at())).toBeNull()
  })
})

describe('applyGridPaste', () => {
  const names = {
    typeId: (v: string) => ({ table: 'table', domain: 'domain' } as Record<string, string>)[v.toLowerCase()],
    layerId: (v: string) => (v.toLowerCase() === 'warehouse' ? 'L-wh' : undefined),
  }

  it('sets text verbatim, and a type, parent or layer only when it names one here', () => {
    const before = rows()
    const paste = planGridPaste('E2\tTable\tA\tWarehouse\nNew\tNope\tE2\tNowhere\n', {
      ids: ['e'], startId: 'e', column: 'name', rowCount: before.length, mintId: () => 'n1',
    })!
    const { rows: after, unmatched } = applyGridPaste(before, paste, names)
    expect(after.find((r) => r.id === 'e')).toMatchObject({ name: 'E2', typeId: 'table', parentId: 'a', layerId: 'L-wh', depth: 1 })
    // A parent named by a line above is found; a type and a layer that name nothing are counted.
    expect(after.find((r) => r.id === 'n1')).toMatchObject({ name: 'New', typeId: null, parentId: 'e', depth: 2 })
    expect(unmatched).toBe(2)
  })

  it('never makes a row its own ancestor', () => {
    const paste = planGridPaste('A\t\tC', { ids: ['a'], startId: 'a', column: 'name', rowCount: 5 })!
    const { rows: after, unmatched } = applyGridPaste(rows(), paste, names)
    expect(after.find((r) => r.id === 'a')?.parentId).toBeNull()   // C sits under A
    expect(unmatched).toBe(1)
  })
})
