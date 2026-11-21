/**
 * Review & Save offers "Save & publish" on the server's word when it gives one: the maker of a
 * Playground graph publishes it without the publish permission. Without that word, the
 * permission decides, as before.
 */
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: index, start: index * 52, size: 52 })),
    getTotalSize: () => opts.count * 52,
    scrollToIndex: () => undefined,
  }),
}))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeSummary: () => ({ data: { counts: { added: 1, modified: 0, removed: 0 } }, isLoading: false, isFetching: false }),
  useDataSourceDraftsPolicy: () => ({ data: undefined }),
  usePublishBranch: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
}))
const { access } = vi.hoisted(() => ({ access: { canPublish: undefined as boolean | undefined } }))
vi.mock('@/features/versioning/hooks/useActiveDraftAccess', () => ({
  useActiveDraftAccess: () => ({ draft: null, canWrite: true, canManage: true, canPublish: access.canPublish }),
}))
// A Playground member: manages their graphs, holds no publish permission.
vi.mock('@/store/auth', () => ({ usePermission: (perm: string) => perm !== 'workspace:datasource:publish' }))

import { StagedChangesPanel } from '../StagedChangesPanel'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'

const edit: StagedChange = {
  id: 'c1', type: 'update_entity', targetId: 'urn:orders', targetUrn: 'urn:orders', timestamp: 1, summary: "Edit 'Orders'",
  before: { label: 'Orders', urn: 'urn:orders', properties: { owner: 'ana' } },
  after: { label: 'Orders', urn: 'urn:orders', properties: { owner: 'bea' } },
}

function openPanel() {
  render(
    <MemoryRouter>
      <StagedChangesPanel onConfirm={async () => true} wsId="ws_play" graphId="g1" dataSourceId="ds1" viewId="v1" />
    </MemoryRouter>,
  )
  act(() => useStagedChangesStore.getState().openReviewPanel())
}

beforeEach(() => {
  useStagedChangesStore.setState({
    changes: [edit], past: [], redoStack: [], isReviewPanelOpen: false, reviewIntent: null, applyStatus: 'idle', lastApplyResult: null,
  } as never)
  useBranchStore.setState({ currentBranchId: 'br1', activeChangeSet: null } as never)
  useCanvasStore.setState({ nodes: [{ id: 'urn:orders', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'Orders', urn: 'urn:orders', type: 'dataset' } }] } as never)
})

describe('Review & Save — publishing for makers', () => {
  it('offers Save & publish to the graph’s maker, on the server’s word', () => {
    access.canPublish = true
    openPanel()
    expect(screen.getByRole('radio', { name: /Save & publish/ })).toBeEnabled()
  })

  it('without the server’s word, the publish permission decides', () => {
    access.canPublish = undefined
    openPanel()
    expect(screen.getByRole('radio', { name: /Save & publish/ })).toBeDisabled()
  })
})
