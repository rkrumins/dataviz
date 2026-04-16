import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphProvider } from './GraphProviderContext'

const {
  loadWorkspaces,
  setActiveWorkspace,
  setActiveDataSource,
  setGraph,
  reportFailure,
  subscribeHealth,
} = vi.hoisted(() => ({
  loadWorkspaces: vi.fn(async () => undefined),
  setActiveWorkspace: vi.fn(),
  setActiveDataSource: vi.fn(),
  setGraph: vi.fn(),
  reportFailure: vi.fn(),
  subscribeHealth: vi.fn(() => () => undefined),
}))

vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (selector: (state: any) => unknown) => selector({
    activeWorkspaceId: null,
    activeDataSourceId: null,
    loadWorkspaces,
    setActiveWorkspace,
    setActiveDataSource,
  }),
}))

vi.mock('@/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({ setGraph }),
  },
}))

vi.mock('@/store/health', () => ({
  useHealthStore: {
    getState: () => ({ reportFailure }),
    subscribe: subscribeHealth,
  },
}))

describe('GraphProvider workspace bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads workspaces on mount without requiring a legacy connections store', async () => {
    render(
      <GraphProvider>
        <div>child</div>
      </GraphProvider>,
    )

    await waitFor(() => {
      expect(loadWorkspaces).toHaveBeenCalledTimes(1)
    })
  })
})
