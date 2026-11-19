import { describe, expect, it } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'
import { buildReviewGroups } from '../reviewModel'
import { stagedCsvLines } from '../reviewCsv'

const lookup = { nameOf: (id: string) => id.replace('urn:', ''), typeOf: () => 'Table' }
const edit = (i: number): StagedChange => ({
  id: `c${i}`, type: 'update_entity', targetId: `urn:t${i}`, targetUrn: `urn:t${i}`, timestamp: i, summary: 's',
  before: { label: `t${i}`, properties: { owner: 'ana' } }, after: { label: `t${i}`, properties: { owner: '=bo' } },
})

describe('stagedCsvLines', () => {
  it('writes one row per thing changed, or one per field it sends — defused', async () => {
    const groups = buildReviewGroups([edit(1)], lookup)
    const changes = await stagedCsvLines(groups, 'changes')
    expect(changes[0]).toBe('Kind,Change,Type,Name,What it does,Changes,Id\r\n')
    expect(changes[1]).toBe('Entity,Edited,Table,t1,Changed 1 field on t1,1,urn:t1\r\n')
    const fields = await stagedCsvLines(groups, 'properties')
    expect(fields[1]).toBe("Entity,Edited,Table,t1,Changed 1 field on t1,1,urn:t1,owner,,ana,'=bo\r\n")
  })

  it('exports 50,000 staged changes without holding the page for long', async () => {
    const groups = buildReviewGroups(Array.from({ length: 50_000 }, (_, i) => edit(i)), lookup)
    const t = performance.now()
    const lines = await stagedCsvLines(groups, 'changes')
    expect(lines).toHaveLength(50_001)
    expect(performance.now() - t).toBeLessThan(3000)
  })
})
