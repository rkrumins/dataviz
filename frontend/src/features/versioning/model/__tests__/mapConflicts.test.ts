/** A refused save's conflicts land on the staged changes that caused them, with the current value. */
import { describe, expect, it } from 'vitest'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { CONFLICT_MESSAGE, mapConflicts, markConflicts } from '../mapConflicts'

const sc = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c', type: 'update_entity', targetId: 't', after: {}, summary: '', timestamp: 0, ...over,
})
const nodeNow = { kind: 'node' as const, version: 'v9', node: { urn: 'urn:n', entityType: 'd', displayName: 'N', properties: {} } }
const edgeNow = { kind: 'edge' as const, version: 'e9', edge: { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'T', properties: {} } }

describe('mapConflicts', () => {
  it('maps node and edge conflicts to their changes, one entry per field', () => {
    const changes = [
      sc({ id: 'n', type: 'update_entity', targetId: 'urn:n', targetUrn: 'urn:n' }),
      sc({ id: 'e', type: 'edit_edge', targetId: 'e1' }),
      sc({ id: 'x', type: 'delete_edge', targetId: 'e1' }),
    ]
    const out = mapConflicts({
      conflicts: [
        { entity_id: 'urn:n', path: ['properties', 'owner'], base: 'a', ours: 'b', theirs: 'c' },
        { entity_id: 'urn:n', path: ['properties', 'owner'], base: 'a', ours: 'b', theirs: 'c' },
        { entity_id: 'urn:n', path: ['displayName'], base: 'N0', ours: 'N1', theirs: 'N2' },
        { entity_id: 'e1', path: ['properties', 'sla'], base: 1, ours: 2, theirs: 3 },
        { entity_id: 'elsewhere', path: ['x'], base: 1, ours: 2, theirs: 3 },
      ],
      current: { 'urn:n': nodeNow, e1: edgeNow },
    }, changes)
    expect([...out.keys()].sort()).toEqual(['e', 'n'])
    expect(out.get('n')!.fields.map((f) => f.key)).toEqual(['properties.owner', 'displayName'])
    expect(out.get('n')!.fields[0]).toMatchObject({ mine: 'b', theirs: 'c', base: 'a' })
    expect(out.get('e')!.current).toBe(edgeNow)
  })

  it('addresses a gv:-prefixed id as the entity itself', () => {
    const out = mapConflicts({
      conflicts: [{ entity_id: 'ent_1', path: ['displayName'], base: 1, ours: 2, theirs: 3 }],
      current: { ent_1: nodeNow },
    }, [sc({ id: 'n', targetId: 'gv:ent_1' })])
    expect(out.has('n')).toBe(true)
  })
})

describe('markConflicts', () => {
  it('puts each conflict on its change with the reason, and counts the changes', () => {
    useStagedChangesStore.setState({ changes: [
      sc({ id: 'n', targetId: 'urn:n', targetUrn: 'urn:n' }), sc({ id: 'other', targetId: 'urn:o' }),
    ] })
    const n = markConflicts({
      conflicts: [{ entity_id: 'urn:n', path: ['displayName'], base: 1, ours: 2, theirs: 3 }],
      current: { 'urn:n': nodeNow },
    })
    expect(n).toBe(1)
    const [a, b] = useStagedChangesStore.getState().changes
    expect(a.error).toBe(CONFLICT_MESSAGE)
    expect(a.conflict?.fields).toHaveLength(1)
    expect(b.conflict).toBeUndefined()
  })
})
