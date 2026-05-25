import { beforeEach, describe, expect, it } from 'vitest'
import { useGraphEditorStore } from './graphEditorStore'

const S = () => useGraphEditorStore.getState()

const addNode = (id: string, name = id) => ({
  changeType: 'add_node' as const,
  objectKind: 'node' as const,
  objectId: id,
  payload: { key: id, display_name: name },
  summary: `add ${id}`,
})

describe('graphEditorStore', () => {
  beforeEach(() => S().reset())

  it('starts clean and init pins base commit', () => {
    S().init('g1', 'main', 'gcmt_base')
    expect(S().syncState).toBe('clean')
    expect(S().baseCommitId).toBe('gcmt_base')
    expect(S().ops).toEqual([])
  })

  it('applyOp adds an op and goes dirty', () => {
    S().init('g1', 'main', null)
    S().applyOp(addNode('urn:a'))
    expect(S().ops).toHaveLength(1)
    expect(S().syncState).toBe('dirty')
  })

  it('coalesces repeated edits to the same object (one op, original before kept)', () => {
    S().init('g1', 'main', null)
    S().applyOp({
      changeType: 'update_node', objectKind: 'node', objectId: 'urn:a',
      payload: { key: 'urn:a', display_name: 'v1' },
      before: { display_name: 'committed' }, summary: 'e1',
    })
    S().applyOp({
      changeType: 'update_node', objectKind: 'node', objectId: 'urn:a',
      payload: { key: 'urn:a', display_name: 'v2' },
      before: { display_name: 'IGNORED' }, summary: 'e2',
    })
    expect(S().ops).toHaveLength(1)
    expect(S().ops[0].payload.display_name).toBe('v2')
    // original before preserved across coalescing
    expect(S().ops[0].before).toEqual({ display_name: 'committed' })
  })

  it('add-then-delete of an uncommitted object cancels out', () => {
    S().init('g1', 'main', null)
    S().applyOp(addNode('urn:tmp'))
    S().applyOp({
      changeType: 'delete_node', objectKind: 'node',
      objectId: 'urn:tmp', payload: { key: 'urn:tmp' }, summary: 'del',
    })
    expect(S().ops).toHaveLength(0)
    expect(S().syncState).toBe('clean')
  })

  it('undo/redo move the last op and toggle clean/dirty', () => {
    S().init('g1', 'main', null)
    S().applyOp(addNode('urn:a'))
    expect(S().undo()).toBe(true)
    expect(S().ops).toHaveLength(0)
    expect(S().syncState).toBe('clean')
    expect(S().redo()).toBe(true)
    expect(S().ops).toHaveLength(1)
    expect(S().syncState).toBe('dirty')
    // nothing left to undo past empty
    S().undo()
    expect(S().undo()).toBe(false)
  })

  it('reconcileTempIds rewrites temp ids in objectId and payload.key', () => {
    S().init('g1', 'main', null)
    S().applyOp(addNode('staged_1', 'Fresh'))
    S().reconcileTempIds({ staged_1: 'urn:real' })
    expect(S().ops[0].objectId).toBe('urn:real')
    expect(S().ops[0].payload.key).toBe('urn:real')
  })

  it('onRefMoved enters conflict with the server head', () => {
    S().init('g1', 'main', 'gcmt_old')
    S().applyOp(addNode('urn:a'))
    S().onRefMoved('gcmt_new')
    expect(S().syncState).toBe('conflict')
    expect(S().conflictHead).toBe('gcmt_new')
    // local ops are retained (non-destructive rebase)
    expect(S().ops).toHaveLength(1)
  })

  it('clearAfterCommit empties ops and advances base', () => {
    S().init('g1', 'main', 'gcmt_old')
    S().applyOp(addNode('urn:a'))
    S().clearAfterCommit('gcmt_new')
    expect(S().ops).toEqual([])
    expect(S().baseCommitId).toBe('gcmt_new')
    expect(S().syncState).toBe('clean')
  })

  it('summary counts ops by change type', () => {
    S().init('g1', 'main', null)
    S().applyOp(addNode('urn:a'))
    S().applyOp(addNode('urn:b'))
    S().applyOp({
      changeType: 'add_edge', objectKind: 'edge', objectId: 'e1',
      payload: { key: 'e1' }, summary: 'add e1',
    })
    const sum = S().summary()
    expect(sum.add_node).toBe(2)
    expect(sum.add_edge).toBe(1)
    expect(sum.delete_node).toBe(0)
  })

  describe('onRemoteCommit (SSE-driven)', () => {
    it('clean → remote_advanced and records remoteHead', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteCommit('gcmt_new')
      expect(S().syncState).toBe('remote_advanced')
      expect(S().remoteHead).toBe('gcmt_new')
    })

    it('ignores an echo of our own latest commit', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().clearAfterCommit('gcmt_mine')
      S().onRemoteCommit('gcmt_mine')
      expect(S().syncState).toBe('clean')
      expect(S().remoteHead).toBeNull()
    })

    it('ignores a duplicate notification for the same remoteHead', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteCommit('gcmt_new')
      // Calling again must not re-set or churn state.
      S().onRemoteCommit('gcmt_new')
      expect(S().syncState).toBe('remote_advanced')
      expect(S().remoteHead).toBe('gcmt_new')
    })

    it('while dirty: preserves dirty state but records remoteHead', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyOp(addNode('urn:a'))
      expect(S().syncState).toBe('dirty')
      S().onRemoteCommit('gcmt_new')
      expect(S().syncState).toBe('dirty')
      expect(S().remoteHead).toBe('gcmt_new')
    })

    it('clearAfterCommit clears remoteHead', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteCommit('gcmt_new')
      S().applyOp(addNode('urn:a'))
      S().clearAfterCommit('gcmt_latest')
      expect(S().remoteHead).toBeNull()
      expect(S().syncState).toBe('clean')
    })

    it('init resets remoteHead', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteCommit('gcmt_new')
      S().init('g1', 'main', 'gcmt_old')
      expect(S().remoteHead).toBeNull()
    })
  })

  describe('onRemoteWorkingSetAdvanced (same-user two-tab)', () => {
    it('records the latest ws_change_version', () => {
      S().init('g1', 'main', 'gcmt_old')
      expect(S().remoteWsVersion).toBeNull()
      S().onRemoteWorkingSetAdvanced(3)
      expect(S().remoteWsVersion).toBe(3)
    })

    it('ignores out-of-order or duplicate notifications', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteWorkingSetAdvanced(5)
      S().onRemoteWorkingSetAdvanced(3) // older — ignored
      expect(S().remoteWsVersion).toBe(5)
      S().onRemoteWorkingSetAdvanced(5) // duplicate — ignored
      expect(S().remoteWsVersion).toBe(5)
    })

    it('does not affect syncState directly', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyOp(addNode('urn:a'))
      expect(S().syncState).toBe('dirty')
      S().onRemoteWorkingSetAdvanced(2)
      // The store records the signal; reaction (refetch) is the page's
      // responsibility. syncState is unchanged.
      expect(S().syncState).toBe('dirty')
    })

    it('clearAfterCommit and init both reset remoteWsVersion', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRemoteWorkingSetAdvanced(2)
      S().clearAfterCommit('gcmt_latest')
      expect(S().remoteWsVersion).toBeNull()
      S().onRemoteWorkingSetAdvanced(3)
      S().init('g1', 'main', 'gcmt_old')
      expect(S().remoteWsVersion).toBeNull()
    })
  })

  describe('V1-6 pull / applyPullResult', () => {
    it('clean pull (no conflicts, no ops) → state stays clean and base advances', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyPullResult({
        new_base: 'gcmt_new',
        rebased: 0, dropped: 0, conflicts: [],
      })
      expect(S().baseCommitId).toBe('gcmt_new')
      expect(S().syncState).toBe('clean')
      expect(S().pendingConflicts).toEqual([])
    })

    it('pull with conflicts → syncState becomes conflict, list populated', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyPullResult({
        new_base: 'gcmt_new',
        rebased: 0, dropped: 0,
        conflicts: [
          {
            objectKind: 'node', objectId: 'urn:n1',
            conflictClass: 'edit_edit',
            baseContentHash: 'h_BASE',
            currentContentHash: 'h_NEW',
            stagedChangeType: 'update_node',
          },
        ],
      })
      expect(S().syncState).toBe('conflict')
      expect(S().pendingConflicts).toHaveLength(1)
      expect(S().pendingConflicts[0].objectId).toBe('urn:n1')
    })

    it('pull clears remoteHead and conflictHead markers', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().onRefMoved('gcmt_remote')  // sets conflictHead + remoteHead
      S().applyPullResult({
        new_base: 'gcmt_remote',
        rebased: 0, dropped: 0, conflicts: [],
      })
      expect(S().conflictHead).toBeNull()
      expect(S().remoteHead).toBeNull()
    })

    it('pull with conflicts AND ops still goes to conflict (ops take backseat)', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyOp(addNode('urn:a'))
      expect(S().syncState).toBe('dirty')
      S().applyPullResult({
        new_base: 'gcmt_new',
        rebased: 1, dropped: 0,
        conflicts: [
          {
            objectKind: 'node', objectId: 'urn:b',
            conflictClass: 'edit_edit',
            baseContentHash: 'h0',
            currentContentHash: 'h1',
            stagedChangeType: 'update_node',
          },
        ],
      })
      expect(S().syncState).toBe('conflict')
      // The pre-pull ops are still in the working set.
      expect(S().ops).toHaveLength(1)
    })

    it('dismissConflict removes one entry; last one returns to dirty/clean', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyPullResult({
        new_base: 'gcmt_new',
        rebased: 0, dropped: 0,
        conflicts: [
          {
            objectKind: 'node', objectId: 'urn:n1',
            conflictClass: 'edit_edit',
            baseContentHash: 'h0', currentContentHash: 'h1',
            stagedChangeType: 'update_node',
          },
          {
            objectKind: 'edge', objectId: 'urn:e1',
            conflictClass: 'delete_edit',
            baseContentHash: 'h2', currentContentHash: 'h3',
            stagedChangeType: 'delete_edge',
          },
        ],
      })
      S().dismissConflict('node', 'urn:n1')
      expect(S().pendingConflicts).toHaveLength(1)
      expect(S().pendingConflicts[0].objectId).toBe('urn:e1')
      expect(S().syncState).toBe('conflict')
      S().dismissConflict('edge', 'urn:e1')
      expect(S().pendingConflicts).toEqual([])
      // No ops + no conflicts → clean.
      expect(S().syncState).toBe('clean')
    })

    it('reset and init both clear pendingConflicts', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyPullResult({
        new_base: 'gcmt_new', rebased: 0, dropped: 0,
        conflicts: [
          {
            objectKind: 'node', objectId: 'urn:n1',
            conflictClass: 'add_add',
            baseContentHash: null, currentContentHash: 'h',
            stagedChangeType: 'add_node',
          },
        ],
      })
      S().reset()
      expect(S().pendingConflicts).toEqual([])
      S().init('g1', 'main', 'gcmt_old')
      expect(S().pendingConflicts).toEqual([])
    })

    it('clearAfterCommit clears any leftover pendingConflicts', () => {
      S().init('g1', 'main', 'gcmt_old')
      S().applyPullResult({
        new_base: 'gcmt_new', rebased: 0, dropped: 0,
        conflicts: [
          {
            objectKind: 'node', objectId: 'urn:n1',
            conflictClass: 'edit_edit',
            baseContentHash: 'a', currentContentHash: 'b',
            stagedChangeType: 'update_node',
          },
        ],
      })
      S().clearAfterCommit('gcmt_after')
      expect(S().pendingConflicts).toEqual([])
    })
  })
})
