import { describe, it, expect, vi } from 'vitest'
import { orderCreatesTopologically, saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import type { StagedChange } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

vi.mock('@/services/versioningApiService', () => ({
  applyGraphChanges: vi.fn(async () => ({ commitId: 'commit-1', assigned: {} })),
}))

const create = (tempUrn: string, parentUrn?: string, over: Partial<StagedChange> = {}): StagedChange => ({
  id: `change-${tempUrn}`,
  type: 'create_entity',
  targetId: tempUrn,
  targetUrn: tempUrn,
  after: { entityType: 'dataset', displayName: tempUrn, parentUrn },
  summary: '',
  timestamp: 0,
  ...over,
})

describe('orderCreatesTopologically', () => {
  it('orders a parent create before its child regardless of staging order (redo reorder)', () => {
    const parent = create('urn:staged:p')
    const child = create('urn:staged:c', 'urn:staged:p')
    // redo() pushes a change to the END — child can precede parent in the array.
    const out = orderCreatesTopologically([child, parent])
    expect(out.map((c) => c.targetId)).toEqual(['urn:staged:p', 'urn:staged:c'])
  })

  it('orders a three-level hierarchy grandparent → parent → child', () => {
    const gp = create('urn:staged:gp')
    const p = create('urn:staged:p', 'urn:staged:gp')
    const c = create('urn:staged:c', 'urn:staged:p')
    const out = orderCreatesTopologically([c, p, gp])
    expect(out.map((x) => x.targetId)).toEqual(['urn:staged:gp', 'urn:staged:p', 'urn:staged:c'])
  })

  it('keeps chronological order for independent creates and ignores non-create changes', () => {
    const a = create('urn:staged:a')
    const b = create('urn:staged:b', 'urn:real:existing-parent') // parent not staged — no dependency
    const rename: StagedChange = { id: 'r1', type: 'rename_entity', targetId: 'n1', after: {}, summary: '', timestamp: 0 }
    const out = orderCreatesTopologically([a, rename, b])
    expect(out.map((c) => c.targetId)).toEqual(['urn:staged:a', 'urn:staged:b'])
  })

  it('survives a dependency cycle without dropping changes', () => {
    const a = create('urn:staged:a', 'urn:staged:b')
    const b = create('urn:staged:b', 'urn:staged:a')
    const out = orderCreatesTopologically([a, b])
    expect(out).toHaveLength(2)
  })
})

describe('saveStagedChangesToDraft phase 1 ordering', () => {
  it('applies a parent create before its child even when staged out of order', async () => {
    const applied: string[] = []
    const parent = create('urn:staged:p', undefined, {
      apply: async ({ registerTempIdResolution }) => {
        applied.push('urn:staged:p')
        registerTempIdResolution('urn:staged:p', 'urn:real:p')
      },
    })
    const child = create('urn:staged:c', 'urn:staged:p', {
      apply: async ({ resolveTempId }) => {
        // The child must see its parent's resolution — proof the parent ran first.
        expect(resolveTempId('urn:staged:p')).toBe('urn:real:p')
        applied.push('urn:staged:c')
      },
    })
    await saveStagedChangesToDraft([child, parent], {
      wsId: 'ws', dataSourceId: 'ds', branchId: 'br',
      provider: {} as GraphDataProvider,
    })
    expect(applied).toEqual(['urn:staged:p', 'urn:staged:c'])
  })
})
