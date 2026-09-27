/**
 * On the published graph, Save used to "apply" a node edit by running its no-op hook and
 * dropping it — reported as saved, gone for good. With `graphWrites: false` every graph-data
 * change stays staged, marked with why, and only the view's own layout changes go through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLISHED_READ_ONLY, useStagedChangesStore } from '../stagedChangesStore'

const reset = () =>
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })

describe('applyAll({ graphWrites: false })', () => {
  beforeEach(reset)

  it('keeps every graph-data change, marked, and never runs its hook', async () => {
    const apply = vi.fn()
    const s = useStagedChangesStore.getState()
    s.stage({ type: 'update_entity', targetId: 'n1', after: {}, summary: 'edit', apply })
    s.stage({ type: 'delete_edge', targetId: 'e1', after: null, summary: 'delete' })
    s.stage({ type: 'layer_config', targetId: 'L', after: {}, summary: 'layers' })

    const res = await s.applyAll({} as never, 'ws', { graphWrites: false })

    expect(res).toEqual({ ok: 1, failed: 2 })
    expect(apply).not.toHaveBeenCalled()
    const left = useStagedChangesStore.getState().changes
    expect(left.map((c) => c.targetId).sort()).toEqual(['e1', 'n1'])
    expect(left.every((c) => c.error === PUBLISHED_READ_ONLY)).toBe(true)
  })

  it('without the option, applies as before', async () => {
    const apply = vi.fn()
    const s = useStagedChangesStore.getState()
    s.stage({ type: 'update_entity', targetId: 'n1', after: {}, summary: 'edit', apply })
    expect(await s.applyAll({} as never, 'ws')).toEqual({ ok: 1, failed: 0 })
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
