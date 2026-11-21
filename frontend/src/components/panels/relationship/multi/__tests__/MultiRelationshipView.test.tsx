/**
 * The relationship drawer on several relationships: it reads them as they are stored (never the
 * canvas copy), says for each property whether they hold it alike, differently or only some do,
 * and lists the ones it leaves out and why — roll-ups, ones deleted in the draft, ones not saved
 * yet. In a draft a change is made for all of them and staged as each relationship's own edit, in
 * one step that Undo takes back; more than it compares are changed on the server instead.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type EdgeMemberRef, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { useNotificationStore } from '@/components/ui/notifications'
import { stagedChangesToOps } from '@/features/versioning/model/stagedChangesToOps'
import { targetFromMembers } from '@/lib/drawerEdgeTarget'
import type { RelationshipRecordOf } from '@/hooks/useRelationshipRecords'

const h = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  deleted: new Set<string>(),
  missing: new Set<string>(),
  versioned: true,
  asked: [] as string[][],
  editing: { offered: true, blocked: null as string | null },
}))

vi.mock('@/hooks/useRelationshipRecords', () => ({
  useRelationshipRecords: (refs: Array<{ id: string }>) => {
    h.asked.push(refs.map((r) => r.id))
    return { records: h.records, deleted: h.deleted, missing: h.missing, versioned: h.versioned,
      isLoading: false, isError: false, refetch: vi.fn() }
  },
}))
vi.mock('../../../useDrawerHistoryScope', () => ({
  useDrawerHistoryScope: () => ({ wsId: 'ws', graphId: 'g', mainBranchId: 'main', branchId: 'd1' }),
}))
vi.mock('@/features/versioning/hooks/useEntityEditing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/hooks/useEntityEditing')>()),
  useEntityEditing: () => h.editing,
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeEntry: () => ({ data: undefined }),
  useEntitySummary: () => ({ data: undefined, isLoading: false }),
  useBranches: () => ({ data: [] }),
  useProjectionWatermark: () => ({ data: undefined }),
}))
vi.mock('@/providers/GraphProviderContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProviderIfAvailable: () => null,
}))
vi.mock('@/features/versioning/components/EntityHistory', () => ({ EntityHistory: () => null }))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewRelationshipTypes: () => [],
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
}))

import { RelationshipDrawer } from '../../../RelationshipDrawer'

const node = (id: string, label: string): LineageNode =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label, type: 'dataset', urn: id } }) as unknown as LineageNode
const member = (id: string, source: string, target: string, edgeType = 'FLOWS_TO', rollup = false): EdgeMemberRef =>
  ({ id, source, target, edgeType, rollup })
const record = (entityId: string, properties: Record<string, unknown>, edgeType = 'FLOWS_TO'): RelationshipRecordOf =>
  ({ entityId, edgeType, properties, version: `v-${entityId}` })

const MEMBERS = [
  member('e1', 'a', 'b'), member('e2', 'b', 'c'), member('e3', 'a', 'c'),
  member('agg', 'a', 'c', 'AGGREGATED', true), member('gone', 'c', 'a'), member('new', 'c', 'b'), member('kids', 'a', 'b', 'CONTAINS'),
]
const changes = () => useStagedChangesStore.getState().changes
/** The updates a save would send (the fixture's drawn relationship is a create). */
const ops = () => (stagedChangesToOps(changes()) as unknown as Array<{ op: string; id: string; kind: string; payload: { properties?: Record<string, unknown> }; unsetProperties?: string[]; baseVersion?: string }>)
  .filter((o) => o.op === 'update')
const rowOf = (key: string) => document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!

function open(members = MEMBERS) {
  useCanvasStore.getState().openEdgeDrawer(targetFromMembers(members))
}

beforeEach(() => {
  h.records = new Map<string, unknown>([
    ['e1', record('e1', { owner: 'ana', sla: '1h' })],
    ['e2', record('edge:e2', { owner: 'ana', sla: '4h' })],
    ['e3', record('e3', { owner: 'ana', sla: '1h', tier: 'gold' })],
    ['kids', record('kids', {}, 'CONTAINS')],
  ])
  h.deleted = new Set(['gone'])
  h.missing = new Set()
  h.versioned = true
  h.asked = []
  h.editing = { offered: true, blocked: null }
  useCanvasStore.setState({
    nodes: [node('a', 'Orders'), node('b', 'Revenue'), node('c', 'Refunds')],
    edges: [], _nodeIndex: new Set(['a', 'b', 'c']), _edgeIndex: new Set(),
    drawerNodeId: null, drawerNodeIds: null, drawerEdge: null, drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 }, selectedNodeIds: [], selectedEdgeIds: [],
    drawerDirty: false, pendingDrawerMove: null,
  } as never)
  useStagedChangesStore.setState({
    changes: [{ id: 's-new', type: 'create_edge', targetId: 'new', after: {}, summary: 'Draw', timestamp: 1 }],
    past: [], redoStack: [],
  } as never)
  useNotificationStore.setState({ notifications: [] } as never)
  useFeaturesStore.setState({ values: { versioningEnabled: true, editModeEnabled: true } } as never)
  usePropertyJobsStore.setState({ request: null, requestSeq: 0 })
  open()
})

describe('several relationships in the relationship drawer', () => {
  it('compares the ones it can, as stored, and lists the rest with why', async () => {
    const user = userEvent.setup()
    render(<RelationshipDrawer canEdit />)
    expect(screen.getByRole('heading', { name: '7 relationships' })).toBeInTheDocument()
    // Read once — never the roll-up, nor the one not saved yet.
    expect(h.asked.at(-1)).toEqual(['e1', 'e2', 'e3', 'gone', 'kids'])
    expect(within(rowOf('owner')).getByText('Same')).toBeInTheDocument()
    expect(within(rowOf('sla')).getByText('Differs · 2 values')).toBeInTheDocument()
    expect(within(rowOf('tier')).getByText('On 1 of 3')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /4 left out/ }))
    const leftOut = screen.getByRole('list', { name: 'Relationships left out' })
    expect(within(leftOut).getByText('A roll-up — read-only')).toBeInTheDocument()
    expect(within(leftOut).getByText('Deleted in this draft')).toBeInTheDocument()
    expect(within(leftOut).getByText('Not saved yet')).toBeInTheDocument()
    expect(within(leftOut).getByText('Hierarchy — read-only')).toBeInTheDocument()
    expect(within(leftOut).getByRole('button', { name: 'Refunds → Orders' })).toBeInTheDocument()
  })

  it('sets a value for all, staged as each relationship\'s own edit against what was read — one Undo takes it back', async () => {
    const user = userEvent.setup()
    render(<RelationshipDrawer canEdit />)
    await user.click(screen.getByRole('button', { name: 'Edit sla for all' }))
    await user.type(screen.getByRole('textbox', { name: 'sla for all' }), '2h{Enter}')
    expect(screen.getByText(/1 change · 3 relationships · 3 replaced/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stage for 3' }))
    expect(ops().map((o) => [o.kind, o.id, o.payload.properties, o.baseVersion])).toEqual([
      ['edge', 'e1', { sla: '2h' }, 'v-e1'], ['edge', 'edge:e2', { sla: '2h' }, 'v-edge:e2'], ['edge', 'e3', { sla: '2h' }, 'v-e3'],
    ])
    expect(changes().find((c) => c.targetId === 'e1')!.summary).toBe("Edit relationship 'Orders' → 'Revenue'")
    expect(within(rowOf('sla')).getByText('Same')).toBeInTheDocument()

    const notice = useNotificationStore.getState().notifications.at(-1)!
    expect(notice.message).toMatch(/Staged 1 change on 3 relationships/)
    act(() => notice.action!.onClick())
    expect(changes().map((c) => c.type)).toEqual(['create_edge'])
  })

  it('removes a property only where it is held, and builds on a relationship\'s staged edit', async () => {
    useStagedChangesStore.getState().stage({
      type: 'edit_edge', targetId: 'e3', summary: 'earlier',
      before: { properties: { owner: 'ana', sla: '1h', tier: 'gold' }, version: 'v-e3' },
      after: { properties: { owner: 'bo', sla: '1h', tier: 'gold' } },
    })
    const user = userEvent.setup()
    render(<RelationshipDrawer canEdit />)
    // What is staged is what is shown.
    expect(within(rowOf('owner')).getByText('Differs · 2 values')).toBeInTheDocument()
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Remove tier from all' }))
    await user.click(screen.getByRole('button', { name: 'Stage for 1' }))
    const edits = changes().filter((c) => c.type === 'edit_edge')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.before).toEqual({ properties: { owner: 'ana', sla: '1h', tier: 'gold' }, version: 'v-e3' })
    expect(ops().find((o) => o.id === 'e3')).toMatchObject({ payload: { properties: { owner: 'bo' } }, unsetProperties: ['tier'], baseVersion: 'v-e3' })
  })

  it('holds a move of the drawer while a change is not staged', async () => {
    const user = userEvent.setup()
    render(<RelationshipDrawer canEdit />)
    await user.click(within(rowOf('tier')).getByRole('button', { name: 'Remove tier from all' }))
    act(() => useCanvasStore.getState().openNodeDrawer('a'))
    expect(useCanvasStore.getState().drawerEdge?.kind).toBe('relationships')
    expect(useCanvasStore.getState().pendingDrawerMove).not.toBeNull()
  })

  it('outside a draft it compares, read-only, and offers the way into one', () => {
    h.editing = { offered: true, blocked: 'Switch to a draft to make changes' }
    const startEditing = vi.fn()
    render(<RelationshipDrawer canEdit={false} onStartEditing={startEditing} />)
    expect(within(rowOf('sla')).getByText('Differs · 2 values')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit sla for all' })).toBeNull()
    expect(screen.getByText('Switch to a draft to make changes')).toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'Edit in a draft' }).click())
    expect(startEditing).toHaveBeenCalled()
  })

  it('in a draft this person can only view, says so — not that changes are kept in a draft', () => {
    h.editing = { offered: true, blocked: null }
    render(<RelationshipDrawer canEdit={false} onStartEditing={vi.fn()} />)
    expect(screen.getByText(/You can view this draft but not change it/)).toBeInTheDocument()
    expect(screen.queryByText(/kept in a draft/)).toBeNull()
  })

  it('more than it compares are changed on the server, every one of them', () => {
    const many = Array.from({ length: 1001 }, (_, i) => member(`m${i}`, 'a', 'b'))
    h.records = new Map(many.map((m) => [m.id, record(m.id, { owner: 'ana' })]))
    act(() => open(many))
    render(<RelationshipDrawer canEdit />)
    expect(h.asked.at(-1)).toHaveLength(1000)
    expect(screen.queryByRole('button', { name: /^Stage for/ })).toBeNull()
    act(() => screen.getByRole('button', { name: 'Change all 1,001 on the server' }).click())
    const request = usePropertyJobsStore.getState().request
    expect(request?.target).toEqual({ kind: 'relationships', ids: many.map((m) => m.id) })
  })
})
