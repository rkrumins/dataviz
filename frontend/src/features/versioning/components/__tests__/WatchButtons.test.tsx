/**
 * The watch toggles. The graph's, in the view's page header: nothing without a versioned graph
 * with a first version, or with version control off; a toggle named "Watch this graph" whose
 * pressed state says whether you watch it, held until what you watch is known. An entity's, in
 * its panel: "Watch this entity", pressed when that urn is watched. Both share one query, a
 * failure keeps the state and says why. The API is mocked, the hooks are real.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '@/components/ui/notifications'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const resolved = vi.hoisted(() => ({ data: { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 9, kind: 'manual' } as unknown }))

vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  getGraphWatch: vi.fn(),
  watchGraph: vi.fn(),
  unwatchGraph: vi.fn(),
}))
vi.mock('../../hooks/useVersioning', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useVersioning')>()),
  useResolveGraph: () => resolved,
}))

import { getGraphWatch, unwatchGraph, watchGraph } from '@/services/versioningApiService'
import { EntityWatchButton, GraphWatchButton } from '../WatchButtons'
import { watching } from '../__fixtures__/digest'

const mockGet = vi.mocked(getGraphWatch)
const mockWatch = vi.mocked(watchGraph)
const mockUnwatch = vi.mocked(unwatchGraph)

function renderBoth() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <GraphWatchButton workspaceId="ws1" dataSourceId="ds1" viewId="v1" className="header-action" />
      <EntityWatchButton wsId="ws1" graphId="g1" urn="urn:li:dataset:orders" name="Orders" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useNotificationStore.setState({ notifications: [] } as never)
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never)
  resolved.data = { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 9, kind: 'manual' }
})

describe('GraphWatchButton', () => {
  it('is held until what you watch is known, then a toggle named for the graph', async () => {
    let answer: (w: ReturnType<typeof watching>) => void = () => {}
    mockGet.mockReturnValue(new Promise((r) => { answer = r }))
    renderBoth()
    const graph = screen.getByRole('button', { name: 'Watch this graph' })
    expect(graph).toBeDisabled()
    answer(watching())
    await waitFor(() => expect(graph).toBeEnabled())
    expect(graph).toHaveAttribute('aria-pressed', 'false')
    expect(graph).toHaveTextContent('Watch')
    expect(mockGet).toHaveBeenCalledOnce()                       // one query for both toggles
  })

  it('watches and stops watching the graph', async () => {
    mockGet.mockResolvedValue(watching())
    mockWatch.mockResolvedValue(watching({ graph: true }))
    mockUnwatch.mockResolvedValue(watching())
    renderBoth()
    const user = userEvent.setup()
    const graph = await screen.findByRole('button', { name: 'Watch this graph', pressed: false })
    await user.click(graph)
    expect(mockWatch).toHaveBeenCalledWith('ws1', 'g1', undefined)
    await waitFor(() => expect(graph).toHaveAttribute('aria-pressed', 'true'))
    expect(graph).toHaveTextContent('Watching')
    expect(screen.getByRole('button', { name: 'Watch this entity' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(graph)
    expect(mockUnwatch).toHaveBeenCalledWith('ws1', 'g1', undefined)
    await waitFor(() => expect(graph).toHaveAttribute('aria-pressed', 'false'))
  })

  it('keeps its state when the change fails, and says why', async () => {
    mockGet.mockResolvedValue(watching())
    mockWatch.mockRejectedValue(new Error('Version control is turned off for this deployment.'))
    renderBoth()
    const graph = await screen.findByRole('button', { name: 'Watch this graph', pressed: false })
    await userEvent.setup().click(graph)
    await waitFor(() => expect(useNotificationStore.getState().notifications.at(-1)).toMatchObject({
      type: 'error', message: 'Couldn’t change what you watch: Version control is turned off for this deployment.' }))
    expect(graph).toHaveAttribute('aria-pressed', 'false')
  })

  it('is held, and says why, when what you watch can’t be read', async () => {
    mockGet.mockRejectedValue(new Error('Service unavailable'))
    renderBoth()
    const user = userEvent.setup()
    const graph = screen.getByRole('button', { name: 'Watch this graph' })
    await user.hover(graph.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('What you watch couldn’t be read')
    expect(graph).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Watch this entity' })).toBeDisabled()
  })

  it('shows nothing without a versioned graph with a first version, or with version control off', () => {
    mockGet.mockResolvedValue(watching())
    resolved.data = { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 1, kind: 'manual' }
    const { unmount } = renderBoth()
    expect(screen.queryByRole('button', { name: 'Watch this graph' })).not.toBeInTheDocument()
    unmount()
    resolved.data = undefined
    const second = renderBoth()
    expect(screen.queryByRole('button', { name: 'Watch this graph' })).not.toBeInTheDocument()
    second.unmount()
    resolved.data = { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 9, kind: 'manual' }
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: false } } as never)
    renderBoth()
    expect(screen.queryByRole('button', { name: 'Watch this graph' })).not.toBeInTheDocument()
  })

  it('offers a hand-built model from its first version', async () => {
    mockGet.mockResolvedValue(watching())
    resolved.data = { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 1, kind: 'blank' }
    renderBoth()
    expect(await screen.findByRole('button', { name: 'Watch this graph' })).toBeInTheDocument()
  })
})

describe('EntityWatchButton', () => {
  it('is pressed when its urn is watched, and watches or stops watching it alone', async () => {
    mockGet.mockResolvedValue(watching({ graph: true, entities: [{ urn: 'urn:li:dataset:orders', since: '2026-11-15T10:00:00+00:00' }] }))
    mockUnwatch.mockResolvedValue(watching({ graph: true }))
    mockWatch.mockResolvedValue(watching({ graph: true, entities: [{ urn: 'urn:li:dataset:orders', since: '2026-11-16T10:00:00+00:00' }] }))
    renderBoth()
    const user = userEvent.setup()
    const entity = await screen.findByRole('button', { name: 'Watch this entity', pressed: true })
    expect(entity).toHaveTextContent('Watching')
    await user.click(entity)
    expect(mockUnwatch).toHaveBeenCalledWith('ws1', 'g1', 'urn:li:dataset:orders')
    await waitFor(() => expect(entity).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.getByRole('button', { name: 'Watch this graph' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(entity)
    expect(mockWatch).toHaveBeenCalledWith('ws1', 'g1', 'urn:li:dataset:orders')
    await waitFor(() => expect(entity).toHaveAttribute('aria-pressed', 'true'))
  })
})
