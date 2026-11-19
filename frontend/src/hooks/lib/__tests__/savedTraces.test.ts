/**
 * Saved traces — kept on purpose, named, one per question, and read back
 * defensively. Their results pack into a few columns and come back exactly.
 */
import { describe, it, expect } from 'vitest'
import {
  addSavedTrace,
  diffSinceSaved,
  findSavedTrace,
  hydrateSavedTraces,
  removeSavedTrace,
  renameSavedTrace,
  SAVED_TRACES_CAP,
  serializeSavedTraces,
  type SavedTrace,
} from '../savedTraces'
import { packTraceSnapshot, unpackTraceSnapshot } from '../traceSnapshot'
import type { TraceExportRow } from '../traceExport'

const trace = (id: string, urns: string[], over: Partial<SavedTrace> = {}): SavedTrace => ({
  id,
  name: urns.join(' + '),
  savedAt: 1,
  recipe: {
    urn: urns[0]!, ...(urns.length > 1 ? { urns } : {}), focusId: urns[0]!,
    view: { showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 3, traceExpansion: [] }, timestamp: 1,
  },
  seedLabels: urns,
  counts: { nodes: 3, upstream: 1, downstream: 1, edges: 2 },
  hasResults: true,
  partial: false,
  ...over,
})

describe('the saved list', () => {
  it('newest first, and saving the same seeds again replaces rather than duplicates', () => {
    const a = trace('a', ['x', 'y'])
    const b = trace('b', ['z'])
    let { list } = addSavedTrace([], a)
    ;({ list } = addSavedTrace(list, b))
    expect(list.map(t => t.id)).toEqual(['b', 'a'])
    const again = addSavedTrace(list, trace('a2', ['y', 'x']))
    expect(again.list.map(t => t.id)).toEqual(['a2', 'b'])
    expect(again.dropped.map(t => t.id)).toEqual(['a'])
  })

  it('past the cap the oldest go, and are returned so their results can be deleted', () => {
    let list: SavedTrace[] = []
    for (let i = 0; i < SAVED_TRACES_CAP; i += 1) list = addSavedTrace(list, trace(`t${i}`, [`u${i}`])).list
    const { list: next, dropped } = addSavedTrace(list, trace('new', ['fresh']))
    expect(next).toHaveLength(SAVED_TRACES_CAP)
    expect(dropped.map(t => t.id)).toEqual(['t0'])
  })

  it('renames (trimmed, never to nothing), removes, and finds by seed set', () => {
    const list = [trace('a', ['x', 'y'])]
    expect(renameSavedTrace(list, 'a', '  Finance feed  ')[0]!.name).toBe('Finance feed')
    expect(renameSavedTrace(list, 'a', '   ')[0]!.name).toBe('x + y')
    expect(removeSavedTrace(list, 'a')).toEqual([])
    expect(findSavedTrace(list, ['y', 'x'])?.id).toBe('a')
    expect(findSavedTrace(list, ['x'])).toBeUndefined()
  })

  it('reads back what it wrote, and drops what it cannot read', () => {
    const list = [trace('a', ['x', 'y']), trace('b', ['z'], { hasResults: false })]
    expect(hydrateSavedTraces(JSON.parse(JSON.stringify(serializeSavedTraces(list))))).toEqual(list)
    expect(hydrateSavedTraces(null)).toEqual([])
    expect(hydrateSavedTraces({ v: 2, items: list })).toEqual([])
    expect(hydrateSavedTraces({ v: 1, items: [{ id: 'bad' }, list[1]] })).toEqual([list[1]])
  })

  it('says what changed since it was saved', () => {
    expect(diffSinceSaved(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ added: ['d'], removed: ['a'] })
  })
})

describe('the results it keeps', () => {
  const rows: TraceExportRow[] = Array.from({ length: 2000 }, (_, i) => ({
    urn: `urn:li:dataset:table_${i}`,
    name: `table_${i}`,
    type: i % 2 ? 'dataset' : 'schemaField',
    role: i === 0 ? 'seed' : i % 3 ? 'upstream' : 'both',
    hops: i === 0 ? 0 : (i % 7) + 1,
    hopsUp: i === 0 ? 0 : (i % 7) + 1,
    hopsDown: i % 3 ? null : (i % 7) + 1,
    layer: 'Warehouse',
    parentUrn: i % 5 ? 'urn:li:container:analytics' : null,
    parentName: i % 5 ? 'ANALYTICS' : null,
    parentType: i % 5 ? 'container' : null,
    path: i % 5 ? ['snowflake', 'ANALYTICS'] : [],
    pathUrns: i % 5 ? ['urn:li:dataPlatform:snowflake', 'urn:li:container:analytics'] : [],
    reachedFrom: i % 2 ? ['urn:seed:a'] : ['urn:seed:a', 'urn:seed:b'],
  }))
  const edges = rows.slice(1).map((r, i) => ({ source: r.urn, target: rows[i]!.urn, type: i % 2 ? 'TRANSFORMS' : null }))

  it('round-trips every row and edge exactly', async () => {
    const snap = await packTraceSnapshot(rows, edges)
    expect(snap).toMatchObject({ v: 1, rows: rows.length, edges: edges.length })
    expect(await unpackTraceSnapshot(snap)).toEqual({ rows, edges })
  })

  it('packs far smaller than the rows themselves', async () => {
    const snap = await packTraceSnapshot(rows, edges)
    expect(snap.bytes.byteLength).toBeLessThan(JSON.stringify({ rows, edges }).length / 5)
  })

  it('a record saved before rows kept their parent still reads, with no parent rather than a guess', async () => {
    const v1 = {
      v: 1, urns: ['urn:a'], names: ['a'], types: [['dataset'], [0]], roles: [2], hopsUp: [1], hopsDown: [null],
      layers: [['Warehouse'], [0]], paths: [['snowflake\u0000ANALYTICS'], [0]], seeds: [], reached: [0],
      edges: [], edgeTypes: [[], []],
    }
    const bytes = new TextEncoder().encode(JSON.stringify(v1))
    const out = await unpackTraceSnapshot({ v: 1, encoding: 'none', bytes: bytes.buffer, rows: 1, edges: 0 })
    expect(out?.rows[0]).toMatchObject({
      urn: 'urn:a', path: ['snowflake', 'ANALYTICS'], pathUrns: [], parentUrn: null, parentName: null, parentType: null,
    })
  })

  it('a record it cannot read is no results, never an error', async () => {
    expect(await unpackTraceSnapshot(null)).toBeNull()
    expect(await unpackTraceSnapshot({ v: 1, encoding: 'none', bytes: new TextEncoder().encode('{"v":1}').buffer })).toBeNull()
    expect(await unpackTraceSnapshot({ v: 9 })).toBeNull()
  })
})
