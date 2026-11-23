/**
 * A view in the Playground says so where its name is: a "Playground" chip, explaining that it
 * is an experiment and nothing in it is production data. A view anywhere else carries none.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>('@/services/viewApiService')
  return { ...actual, getView: vi.fn(), updateView: vi.fn() }
})
vi.mock('@/store/schema', () => ({
  useSchemaStore: (selector: (s: unknown) => unknown) => selector({ updateView: vi.fn() }),
}))
vi.mock('@/components/views/EditDetailsPanel', () => ({ EditDetailsPanel: () => null }))
vi.mock('@/components/views/ViewBuiltOn', () => ({ ViewBuiltOn: () => null }))
vi.mock('@/components/views/ViewActivityDrawer', () => ({ ViewActivityDrawer: () => null }))
vi.mock('@/features/versioning/components/ViewReviewsButton', () => ({ ViewReviewsButton: () => null }))
vi.mock('@/components/views/ShareViewDialog', () => ({ ShareViewDialog: () => null }))
const { playground } = vi.hoisted(() => ({ playground: { workspaceId: 'ws_play' as string | null } }))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: { workspaceId: playground.workspaceId } }) }))

import { ViewPageHeader } from '../ViewPageHeader'
import { getView, type View } from '@/services/viewApiService'
import { useAuthStore } from '@/store/auth'

const view = (over: Partial<View> = {}) => ({
  id: 'v_ctx', name: 'Retail data pipeline', viewType: 'context', workspaceId: 'ws_play', workspaceName: 'Playground',
  dataSourceId: 'ds_retail', dataSourceName: 'Retail data pipeline', visibility: 'workspace', config: {},
  createdBy: 'usr_me', isPinned: false, favouriteCount: 0, isFavourited: false, createdAt: '', updatedAt: '',
  ...over,
}) as View

function renderHeader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ViewPageHeader viewId="v_ctx" /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  playground.workspaceId = 'ws_play'
  useAuthStore.setState({ user: { id: 'usr_me' } as never })
})

describe('ViewPageHeader · the Playground chip', () => {
  it('marks a view in the Playground, and says what that means', async () => {
    vi.mocked(getView).mockResolvedValue(view())
    renderHeader()
    const chip = await screen.findByText('Playground', { selector: 'span' })
    await userEvent.setup().hover(chip)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Your experiment — nothing here is production data')
  })

  it('says it is someone else’s experiment on a view the reader didn’t make', async () => {
    vi.mocked(getView).mockResolvedValue(view({ createdBy: 'usr_ada' }))
    renderHeader()
    await userEvent.setup().hover(await screen.findByText('Playground', { selector: 'span' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('An experiment — nothing here is production data')
  })

  it('carries no chip anywhere else', async () => {
    vi.mocked(getView).mockResolvedValue(view({ workspaceId: 'ws_fin', workspaceName: 'Finance' }))
    renderHeader()
    await screen.findByRole('heading', { name: 'Retail data pipeline' })
    expect(screen.queryByText('Playground', { selector: 'span' })).toBeNull()
  })
})
