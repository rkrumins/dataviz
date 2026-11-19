import { describe, expect, it } from 'vitest'
import { byFolder, keyDifferences, summarizeFields, type FieldChange } from '../fieldDiff'
import { summaryWords } from '../../components/ChangeSummary'

const f = (label: string, kind: FieldChange['kind'], folder?: string): FieldChange => ({ label, kind, folder, before: 1, after: 2 })

describe('seeing a change at a glance', () => {
  it('puts the named fields first, then properties edited, added, removed', () => {
    const fields = [f('Name', 'changed'), f('steward', 'added'), f('tier', 'removed'), f('owner', 'changed', 'Biz'), f('Description', 'added')]
    expect(keyDifferences(fields, 4).map((x) => x.label)).toEqual(['Name', 'Description', 'owner', 'steward'])
  })

  it('counts and names the first few', () => {
    const s = summarizeFields([f('owner', 'changed'), f('tier', 'changed'), f('steward', 'added'), f('sla', 'removed'), f('pii', 'changed')])
    expect([s.changed, s.added, s.removed, s.total]).toEqual([3, 1, 1, 5])
    expect(s.top.map((x) => x.label)).toEqual(['owner', 'tier', 'pii'])
  })

  it('says it in words', () => {
    expect(summaryWords(summarizeFields([f('owner', 'changed'), f('tier', 'changed'), f('a', 'changed'), f('b', 'added')]), 'modified'))
      .toBe('Edited owner, tier, a and 1 more')
    expect(summaryWords(summarizeFields([f('owner', 'changed'), f('steward', 'added')]), 'modified')).toBe('Edited owner · added steward')
    expect(summaryWords(summarizeFields([f('x', 'added'), f('y', 'added')]), 'added')).toBe('New · 2 fields')
    expect(summaryWords(summarizeFields([]), 'removed', 'edge')).toBe('Link removed')
  })

  it('groups fields in sections, the unfoldered first', () => {
    const sections = byFolder([f('owner', 'changed', 'Biz'), f('Name', 'changed'), f('tier', 'added', 'Biz'), f('pii', 'changed', 'Compliance')])
    expect(sections.map((s) => [s.folder, s.fields.length])).toEqual([[null, 1], ['Biz', 2], ['Compliance', 1]])
    expect(sections[1].counts).toEqual({ added: 1, changed: 1, removed: 0 })
  })
})
