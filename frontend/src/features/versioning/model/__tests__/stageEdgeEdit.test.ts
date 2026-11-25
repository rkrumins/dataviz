/**
 * stageEdgeEdits keeps ONE staged edit per relationship, whichever surface made it: the properties
 * as first read (and their token) stay the diff base, a later edit joins the staged one, an edit
 * put back the way it was leaves nothing to save, and a batch is one Undo step.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stageEdgeEdits, type EdgeEdit } from '../stageEdgeEdit'
import { stagedChangesToOps } from '../stagedChangesToOps'

const changes = () => useStagedChangesStore.getState().changes
const edit = (edgeId: string, after: Record<string, unknown>, properties: Record<string, unknown> = { owner: 'ana', sla: '1h' }): EdgeEdit =>
  ({ edgeId, current: { properties, version: `v-${edgeId}` }, after, summary: `Edit ${edgeId}` })

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], past: [], redoStack: [], _scopeKey: null, _byScope: {} } as never)
})

describe('stageEdgeEdits', () => {
  it('stages each relationship\'s edit against what was read, saved as a patch with its token', () => {
    stageEdgeEdits([edit('e1', { owner: 'bo', sla: '1h' }), edit('e2', { owner: 'ana' })])
    expect(changes().map((c) => [c.type, c.targetId, c.before])).toEqual([
      ['edit_edge', 'e1', { properties: { owner: 'ana', sla: '1h' }, version: 'v-e1' }],
      ['edit_edge', 'e2', { properties: { owner: 'ana', sla: '1h' }, version: 'v-e2' }],
    ])
    expect(stagedChangesToOps(changes())).toEqual([
      { op: 'update', kind: 'edge', id: 'e1', payload: { properties: { owner: 'bo' } }, baseVersion: 'v-e1' },
      { op: 'update', kind: 'edge', id: 'e2', payload: {}, unsetProperties: ['sla'], baseVersion: 'v-e2' },
    ])
  })

  it('a later edit joins the staged one, keeping the first read; put back, nothing is left to save', () => {
    stageEdgeEdits([edit('e1', { owner: 'bo', sla: '1h' })])
    const first = changes()[0]!
    // Read again after the first edit: what is read now is the staged state, not the base.
    stageEdgeEdits([edit('e1', { owner: 'bo', sla: '2h' }, { owner: 'bo', sla: '1h' })])
    expect(changes()).toHaveLength(1)
    expect(changes()[0]!.id).toBe(first.id)
    expect(changes()[0]!.before).toEqual(first.before)
    expect(changes()[0]!.after).toEqual({ properties: { owner: 'bo', sla: '2h' } })

    stageEdgeEdits([edit('e1', { sla: '1h', owner: 'ana' }, { owner: 'bo', sla: '2h' })])
    expect(changes()).toEqual([])
    // An edit that changes nothing stages nothing.
    expect(stageEdgeEdits([edit('e2', { owner: 'ana', sla: '1h' })])).toBeUndefined()
    expect(changes()).toEqual([])
  })

  it('a relationship not saved yet — drawn, or reversed — keeps its properties on the change that makes it', () => {
    useStagedChangesStore.getState().stage({ type: 'create_edge', targetId: 'tmp1', after: { edgeType: 'FLOWS_TO', source: 'a', target: 'b' }, summary: 'Create' })
    useStagedChangesStore.getState().stage({ type: 'reverse_edge', targetId: 'tmp2', before: { edge: { id: 'e9' } },
      after: { edge: { id: 'tmp2', source: 'c', target: 'a' }, properties: { owner: 'ana' } }, summary: 'Reverse' })
    stageEdgeEdits([
      { edgeId: 'tmp1', current: { properties: {} }, after: { owner: 'bo' }, summary: 'Edit' },
      { edgeId: 'tmp2', current: { properties: { owner: 'ana' } }, after: { owner: 'ana', tier: 'gold' }, summary: 'Edit' },
    ])
    expect(changes().map((c) => [c.type, c.targetId, c.after, c.summary])).toEqual([
      ['create_edge', 'tmp1', { edgeType: 'FLOWS_TO', source: 'a', target: 'b', properties: { owner: 'bo' } }, 'Create'],
      ['reverse_edge', 'tmp2', { edge: { id: 'tmp2', source: 'c', target: 'a' }, properties: { owner: 'ana', tier: 'gold' } }, 'Reverse'],
    ])
    // One Undo step takes both back.
    useStagedChangesStore.getState().undo()
    expect(changes().map((c) => (c.after as { properties?: unknown }).properties)).toEqual([undefined, { owner: 'ana' }])
  })

  it('a batch is one Undo step, and Undo puts back what each relationship had staged', () => {
    stageEdgeEdits([edit('e1', { owner: 'bo', sla: '1h' })])
    const before = changes()
    stageEdgeEdits([edit('e1', { owner: 'cy', sla: '1h' }), edit('e2', { owner: 'cy', sla: '1h' }), edit('e3', { owner: 'cy', sla: '1h' })])
    expect(changes()).toHaveLength(3)
    useStagedChangesStore.getState().undo()
    expect(changes()).toEqual(before)
  })
})
