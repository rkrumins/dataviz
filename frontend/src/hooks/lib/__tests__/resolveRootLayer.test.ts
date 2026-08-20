/**
 * resolveRootLayer — pure root-level layer priority chain extracted from
 * useLayerAssignment's traversal (browse-mode placement rule).
 *
 * Chain: instance drag → explicit (referenceLayout.assignments) →
 * curated (stamped layerAssignment only if branch-created, else undefined) →
 * open (backend → stamped → rule → inherited → showUnassigned fallback).
 * The `'__UNASSIGNED__'` sentinel always resolves to undefined, regardless
 * of which branch produced it.
 */
import { describe, it, expect } from 'vitest'
import { resolveRootLayer } from '../resolveRootLayer'

const base = {
  nodeId: 'n', nodeUrn: 'n', nodeLayerProp: undefined, instanceAssignment: undefined,
  explicitAssignment: undefined, viewIsCurated: false, branchCreated: false, backendAssignment: undefined,
  ruleAssignment: undefined, inheritedLayerId: undefined, unassignedFallbackLayerId: undefined,
}

describe('resolveRootLayer', () => {
  it('instance drag outranks everything', () => {
    expect(resolveRootLayer({ ...base, instanceAssignment: 'L9', explicitAssignment: 'L1' })).toBe('L9')
  })

  it('curated: rules NEVER place; stamped only for branch-created', () => {
    expect(resolveRootLayer({ ...base, viewIsCurated: true, ruleAssignment: 'L2', nodeLayerProp: 'L3' })).toBeUndefined()
    expect(resolveRootLayer({ ...base, viewIsCurated: true, nodeLayerProp: 'L3', branchCreated: true })).toBe('L3')
  })

  it('open scope: backend → stamped → rule → inherited → showUnassigned', () => {
    expect(resolveRootLayer({ ...base, backendAssignment: 'B', nodeLayerProp: 'S', ruleAssignment: 'R' })).toBe('B')
    expect(resolveRootLayer({ ...base, nodeLayerProp: 'S', ruleAssignment: 'R' })).toBe('S')
    expect(resolveRootLayer({ ...base, ruleAssignment: 'R', inheritedLayerId: 'I' })).toBe('R')
    expect(resolveRootLayer({ ...base, inheritedLayerId: 'I' })).toBe('I')
    expect(resolveRootLayer({ ...base, unassignedFallbackLayerId: 'U' })).toBe('U')
  })

  it('explicit assignment wins over a rule match', () => {
    expect(resolveRootLayer({ ...base, explicitAssignment: 'X', ruleAssignment: 'R' })).toBe('X')
  })

  it('__UNASSIGNED__ sentinel resolves to undefined, from whichever branch produced it', () => {
    // Discriminating: if the explicit branch didn't win (or didn't normalize the
    // sentinel), this would fall through the open chain to ruleAssignment 'R'.
    expect(resolveRootLayer({ ...base, explicitAssignment: '__UNASSIGNED__', ruleAssignment: 'R' })).toBeUndefined()
    expect(resolveRootLayer({ ...base, unassignedFallbackLayerId: '__UNASSIGNED__' })).toBeUndefined()
  })
})
