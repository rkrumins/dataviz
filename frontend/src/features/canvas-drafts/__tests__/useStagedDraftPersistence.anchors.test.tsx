/**
 * A column mapped to an entity created in this draft keeps it across a reload: the snapshot carries
 * the anchor of every pending create a column is mapped to (the view's own copy may not have reached
 * the server), and the restored mapping still takes back exactly what it touched when it — or the
 * create it names — is discarded.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot, useStagedDraftPersistence } from '../useStagedDraftPersistence'
import { writeSnapshot } from '../stagedDraftPersistence'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useCanvasStore } from '@/store/canvas'
import { registerLayoutWriter } from '@/store/canvasLayoutBridge'
import { layoutPart, mapLayerToEntity, touchedBy } from '@/components/canvas/context-view/layerMutations'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'

const KEY = 'ws1::ds1::br1'
const TEMP = 'urn:staged:domain:new-1'
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

/** The view's layout, as the canvas keeps it: read and written through the layout writer. */
let layout: NormalizedReferenceLayout
const unmappedLayout = (): NormalizedReferenceLayout => ({
  layers: [{ id: 'col', name: 'New layer', order: 0, entityTypes: [] }, { id: 'other', name: 'Other', order: 1, entityTypes: [] }],
  assignments: { [TEMP]: { layerId: 'col', inheritsChildren: true } },
})

/** The work before the reload: Treasury created, its column mapped to it — staged as the canvas does. */
function stageWork() {
  const before = unmappedLayout()
  const after = mapLayerToEntity(before, 'col', TEMP, { name: 'Treasury' })
  const touch = touchedBy(before, after)
  layout = after
  useCanvasStore.setState({
    nodes: [{ id: TEMP, type: 'generic', position: { x: 0, y: 0 }, data: { urn: TEMP, label: 'Treasury', type: 'domain', isPending: 'create' } }],
    edges: [], _nodeIndex: new Set([TEMP]), _edgeIndex: new Set(),
  } as never)
  const s = useStagedChangesStore.getState()
  s.stage({ type: 'create_entity', targetId: TEMP, targetUrn: TEMP, after: { entityType: 'domain', displayName: 'Treasury' }, summary: 'Create' })
  s.stage({
    type: 'layer_config', targetId: 'layer:col', summary: 'Mapped “New layer” to Treasury',
    before: { part: layoutPart(before, touch) }, after: { part: layoutPart(after, touch), action: 'map' },
  })
}

describe('useStagedDraftPersistence — a column mapped to a new entity, across a reload', () => {
  let unregister: () => void
  beforeEach(() => {
    localStorage.clear()
    useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], applyStatus: 'idle', lastApplyResult: null })
    unregister = registerLayoutWriter({ current: () => layout, persist: (next) => { layout = next } })
  })
  afterEach(() => {
    unregister()
    vi.useRealTimers()
  })

  it('the snapshot carries the anchor of a pending create', () => {
    stageWork()
    expect(buildSnapshot(KEY, 'br1')?.anchors).toEqual({ col: TEMP })
  })

  it('restores the anchor the view lost, and discarding the restored create unmaps the column', async () => {
    stageWork()
    writeSnapshot(buildSnapshot(KEY, 'br1')!)
    // The reload: the work and its node are gone from memory, and the layout save never landed.
    useStagedChangesStore.setState({ changes: [], redoStack: [], past: [] })
    useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
    layout = unmappedLayout()

    renderHook(() => useStagedDraftPersistence(KEY, 'br1', true))
    await settle()
    expect(layout.layers.find((l) => l.id === 'col')).toMatchObject({ anchorUrn: TEMP })
    expect(layout.assignments[TEMP]).toMatchObject({ layerId: 'col', inheritsChildren: true })

    const create = useStagedChangesStore.getState().changes.find((c) => c.type === 'create_entity')!
    act(() => useStagedChangesStore.getState().discard(create.id))
    expect(layout.layers.find((l) => l.id === 'col')?.anchorUrn).toBeUndefined()
    expect(layout.layers.find((l) => l.id === 'col')?.name).toBe('New layer')
    expect(useStagedChangesStore.getState().changes).toEqual([])
  })
})
