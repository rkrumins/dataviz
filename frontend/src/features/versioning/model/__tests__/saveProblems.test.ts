import { describe, expect, it } from 'vitest'
import { mapSaveProblems } from '../saveProblems'
import { liveProblems } from '@/store/saveProblemsStore'
import type { StagedChange } from '@/store/stagedChangesStore'

const ch = (id: string, type: StagedChange['type'], targetId: string, extra: Partial<StagedChange> = {}): StagedChange =>
  ({ id, type, targetId, after: {}, summary: `${type} ${targetId}`, timestamp: 0, ...extra }) as StagedChange

describe('why a save was refused, on the changes that caused it', () => {
  const changes = [
    ch('c1', 'rename_entity', 'gv:urn:x:1', { targetUrn: 'gv:urn:x:1' }),                  // an urn-less node
    ch('c2', 'move_entity', 'urn:x:2', { after: { childId: 'urn:x:2' } }),
    ch('c3', 'rename_entity', 'urn:x:3'),
  ]

  it('matches a violation to its change — by id, stand-in id, or moved entity — with name + reason', () => {
    const problems = mapSaveProblems([
      { entity_id: 'urn:x:1', name: 'New Domain Yada', reason: "'New Domain Yada' has no entity type." },
      { entity_id: 'urn:x:2', reason: "A Node can't be at the top level." },
    ], changes)
    expect(problems).toEqual([
      { name: 'New Domain Yada', reason: "'New Domain Yada' has no entity type.", changeIds: ['c1'] },
      { name: 'move_entity urn:x:2', reason: "A Node can't be at the top level.", changeIds: ['c2'] },
    ])
  })

  it('still reports a violation it cannot tie to a change', () => {
    const [p] = mapSaveProblems([{ entity_id: 'urn:elsewhere', reason: 'Loop.' }], changes)
    expect(p.changeIds).toEqual([])
    expect(liveProblems([p], new Set())).toEqual([p])
  })

  it('a problem goes away with the change that caused it', () => {
    const problems = mapSaveProblems([{ entity_id: 'urn:x:3', reason: 'r' }], changes)
    expect(liveProblems(problems, new Set(['c1', 'c2']))).toEqual([])
  })
})
