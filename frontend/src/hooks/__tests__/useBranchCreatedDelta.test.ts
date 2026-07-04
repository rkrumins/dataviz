/**
 * Unit tests for the PURE `branchCreatedUrns` selector — the branch-created
 * delta that drives leak-safe closed-scope placement of just-created entities.
 *
 * The delta is the set of target URNs of `create_entity` staged changes for the
 * active scope. It must include ONLY `create_entity` targets — never renames,
 * updates, edges, or deletes — so that in a closed-scope Context Model view we
 * honour the node's global `layerAssignment` strictly for entities this branch
 * actually created (see useLayerAssignment.resolve.test.ts for the leak-safety
 * constraint this feeds).
 */
import { describe, it, expect } from 'vitest'
import { branchCreatedUrns } from '../useBranchCreatedDelta'
import type { StagedChange, StagedChangeType } from '@/store/stagedChangesStore'

const change = (type: StagedChangeType, targetUrn: string | undefined): StagedChange => ({
  id: `c-${type}-${targetUrn ?? 'none'}`,
  type,
  targetId: targetUrn ?? 'no-urn',
  targetUrn,
  after: {},
  summary: '',
  timestamp: 0,
})

describe('branchCreatedUrns', () => {
  it('extracts exactly the create_entity target urns and ignores all other change types', () => {
    const changes: StagedChange[] = [
      change('create_entity', 'urn:staged:a'),
      change('create_entity', 'urn:staged:b'),
      change('rename_entity', 'urn:existing:c'),
      change('update_entity', 'urn:existing:d'),
      change('create_edge', 'urn:edge:e'),
      change('delete_entity', 'urn:existing:f'),
      change('assign_layer', 'urn:existing:g'),
      change('move_to_layer', 'urn:existing:h'),
    ]
    const result = branchCreatedUrns(changes)
    expect([...result].sort()).toEqual(['urn:staged:a', 'urn:staged:b'])
  })

  it('returns an empty set when there are no create_entity changes', () => {
    const changes: StagedChange[] = [
      change('rename_entity', 'x'),
      change('create_edge', 'y'),
    ]
    expect(branchCreatedUrns(changes).size).toBe(0)
  })

  it('returns an empty set for an empty change list', () => {
    expect(branchCreatedUrns([]).size).toBe(0)
  })

  it('ignores create_entity changes that have no targetUrn', () => {
    const changes: StagedChange[] = [
      change('create_entity', undefined),
      change('create_entity', 'urn:staged:z'),
    ]
    expect([...branchCreatedUrns(changes)]).toEqual(['urn:staged:z'])
  })
})
