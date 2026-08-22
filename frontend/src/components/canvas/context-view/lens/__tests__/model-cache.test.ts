/**
 * The model's own answers, computed once per model (2026-08-22).
 *
 * MEASURED on the wide table: `ancestorsOf` 98 ms and `subtreeOf` 66 ms
 * over one interaction window, because both caches were built inside
 * `buildFocusLayout` and thrown away with it — and the layout runs on
 * every expand, every density switch, every wave of the walk. The model
 * does not change between those runs, so neither do the answers.
 */
import { describe, it, expect } from 'vitest'
import { ancestorsFor, subtreeFor } from '../model-cache'

type Node = { parent: string | null; children: string[] }
const model = (rows: Record<string, [string | null, string[]]>): Map<string, Node> =>
  new Map(Object.entries(rows).map(([urn, [parent, children]]) => [urn, { parent, children }]))

const estate = () => model({
  root: [null, ['db']],
  db: ['root', ['t1', 't2']],
  t1: ['db', ['c1']],
  t2: ['db', []],
  c1: ['t1', []],
})

describe('ancestorsFor', () => {
  it('walks up to the root, outermost first', () => {
    expect(ancestorsFor(estate(), 'c1')).toEqual(['root', 'db', 't1'])
    expect(ancestorsFor(estate(), 'root')).toEqual([])
  })

  it('answers the same model once — the second call is the first call', () => {
    const m = estate()
    const first = ancestorsFor(m, 'c1')
    expect(ancestorsFor(m, 'c1')).toBe(first)
    // A different model has its own answers.
    expect(ancestorsFor(estate(), 'c1')).not.toBe(first)
  })

  it('a parent cycle terminates rather than hanging', () => {
    const m = model({ a: ['b', []], b: ['a', []] })
    expect(ancestorsFor(m, 'a')).toEqual(['b'])
  })
})

describe('subtreeFor', () => {
  it('is the entity plus every descendant in the model', () => {
    expect([...subtreeFor(estate(), 'db')].sort()).toEqual(['c1', 'db', 't1', 't2'])
    expect([...subtreeFor(estate(), 'c1')]).toEqual(['c1'])
  })

  it('answers the same model once', () => {
    const m = estate()
    const first = subtreeFor(m, 'db')
    expect(subtreeFor(m, 'db')).toBe(first)
    expect(subtreeFor(estate(), 'db')).not.toBe(first)
  })

  it('a child cycle terminates', () => {
    const m = model({ a: [null, ['b']], b: ['a', ['a']] })
    expect([...subtreeFor(m, 'a')].sort()).toEqual(['a', 'b'])
  })
})
