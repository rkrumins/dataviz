/**
 * The frontend's field rules and the server's (`change_csv.field_summary`) must agree on what a
 * change did and which fields come first: the same cases, from one fixture, checked on both sides.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entityFieldChanges, keyDifferences, summarizeFields } from '../fieldDiff'

interface Case {
  name: string
  kind: 'node' | 'edge'
  before: unknown
  after: unknown
  expect: { changed: number; added: number; removed: number; total: number; top: string[] }
}

const cases = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../../../backend/tests/fixtures/field_summary_parity.json'), 'utf8')) as Case[]

describe('field summary parity with the server', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const fields = entityFieldChanges(c.before ?? undefined, c.after ?? undefined, c.kind)
    const s = summarizeFields(fields)
    expect({ changed: s.changed, added: s.added, removed: s.removed, total: s.total })
      .toEqual({ changed: c.expect.changed, added: c.expect.added, removed: c.expect.removed, total: c.expect.total })
    expect(keyDifferences(fields, 5).map((f) => f.label)).toEqual(c.expect.top)
  })
})
