/**
 * Anchored columns — `ViewLayerConfig.anchorUrn`.
 *
 * A column anchored to an entity IS that entity: its rows are the entity's
 * children, not the entity itself. The anchor keeps its own assignment (so an
 * older client still renders it the previous way) and its children keep
 * resolving through containment at read time, so the column reflects whatever
 * the source currently holds.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerAssignment } from '../useLayerAssignment'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

type TestNode = { id: string; data: Record<string, unknown> }
const node = (id: string): TestNode => ({ id, data: { urn: id, type: 'obj', label: id } })
const layer = (id: string, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
  ({ id, name: id, order: 0, entityTypes: [], ...extra })
const assign = (layerId: string): LayerAssignmentEntry => ({ layerId, inheritsChildren: true })

/** Finance holds Payments and Ledger; Payments holds Cards. */
const nodes = [node('finance'), node('payments'), node('ledger'), node('cards')]
const parentMap = new Map([['payments', 'finance'], ['ledger', 'finance'], ['cards', 'payments']])
const childMap = new Map([['finance', ['payments', 'ledger']], ['payments', ['cards']]])

function render(layers: ViewLayerConfig[], assignments: Record<string, LayerAssignmentEntry>) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const { result } = renderHook(() =>
    useLayerAssignment({
      nodes,
      sortedLayers: layers,
      nodeEdgeFingerprint: nodes.map(n => n.id).join(','),
      instanceAssignments: new Map(),
      effectiveAssignments: new Map(),
      nodeMap,
      childMap,
      parentMap,
      assignments,
    }),
  )
  return result.current
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} })
})

describe('useLayerAssignment — anchored columns', () => {
  it('without an anchor, the assigned entity is the column\'s only row', () => {
    const out = render([layer('l1')], { finance: assign('l1') })
    expect(out.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['finance'])
  })

  it('with an anchor, the entity\'s children become the rows', () => {
    const out = render([layer('l1', { anchorUrn: 'finance' })], { finance: assign('l1') })
    expect(out.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['ledger', 'payments'])
  })

  it('keeps each row\'s own subtree beneath it', () => {
    const out = render([layer('l1', { anchorUrn: 'finance' })], { finance: assign('l1') })
    const payments = out.nodesByLayer.get('l1')?.find(n => n.name === 'payments')
    expect(payments?.children.map(c => c.name)).toEqual(['cards'])
  })

  it('does not report the anchor as rendering nowhere', () => {
    // It renders AS the column, so warning that it is missing would be a lie.
    const out = render([layer('l1', { anchorUrn: 'finance' })], { finance: assign('l1') })
    expect(out.unassignedNodes.map(n => n.id)).not.toContain('finance')
  })

  it('orders the rows by the column\'s sort mode', () => {
    const out = render(
      [layer('l1', { anchorUrn: 'finance', nodeSortMode: 'alpha-desc' })],
      { finance: assign('l1') },
    )
    expect(out.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['payments', 'ledger'])
  })

  it('renders an anchor with no children as an empty column, not as itself', () => {
    const out = render([layer('l1', { anchorUrn: 'cards' })], { cards: assign('l1') })
    expect(out.nodesByLayer.get('l1')).toEqual([])
  })

  it('ignores an anchor naming an entity that is not in this column', () => {
    const out = render([layer('l1', { anchorUrn: 'nobody' })], { finance: assign('l1') })
    expect(out.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['finance'])
  })
})

describe('useLayerAssignment — anchors bigger than one page', () => {
  /** Finance reports 5000 children; hydration only holds the first page. */
  const partial = [
    { id: 'finance', data: { urn: 'finance', type: 'obj', label: 'finance', childCount: 5000 } },
    node('payments'), node('ledger'),
  ]

  function renderPartial(layers: ViewLayerConfig[]) {
    const nodeMap = new Map(partial.map(n => [n.id, n]))
    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes: partial,
        sortedLayers: layers,
        nodeEdgeFingerprint: 'partial',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap,
        childMap: new Map([['finance', ['payments', 'ledger']]]),
        parentMap: new Map([['payments', 'finance'], ['ledger', 'finance']]),
        assignments: { finance: assign('l1') },
      }),
    )
    return result.current
  }

  it('flattens the page it holds — the column pages for the rest', () => {
    // The column carries its own Load more (anchorMore), so a partial set is a
    // first page, not a truncation.
    const out = renderPartial([layer('l1', { anchorUrn: 'finance' })])
    expect(out.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['ledger', 'payments'])
  })

  it('falls back to the anchor row when it holds NONE of them', () => {
    // A failed or not-yet-run fetch: flattening would draw an empty column with
    // nothing to click. The row states its count and pages on expand.
    const nodesOnly = [
      { id: 'finance', data: { urn: 'finance', type: 'obj', label: 'finance', childCount: 5000 } },
    ]
    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes: nodesOnly,
        sortedLayers: [layer('l1', { anchorUrn: 'finance' })],
        nodeEdgeFingerprint: 'none',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap: new Map(nodesOnly.map(n => [n.id, n])),
        childMap: new Map(),
        parentMap: new Map(),
        assignments: { finance: assign('l1') },
      }),
    )
    expect(result.current.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['finance'])
  })

  it('promotes as soon as the whole set is held', () => {
    const whole = [
      { id: 'finance', data: { urn: 'finance', type: 'obj', label: 'finance', childCount: 2 } },
      node('payments'), node('ledger'),
    ]
    const nodeMap = new Map(whole.map(n => [n.id, n]))
    const { result } = renderHook(() =>
      useLayerAssignment({
        nodes: whole,
        sortedLayers: [layer('l1', { anchorUrn: 'finance' })],
        nodeEdgeFingerprint: 'whole',
        instanceAssignments: new Map(),
        effectiveAssignments: new Map(),
        nodeMap,
        childMap: new Map([['finance', ['payments', 'ledger']]]),
        parentMap: new Map([['payments', 'finance'], ['ledger', 'finance']]),
        assignments: { finance: assign('l1') },
      }),
    )
    expect(result.current.nodesByLayer.get('l1')?.map(n => n.name)).toEqual(['ledger', 'payments'])
  })
})
