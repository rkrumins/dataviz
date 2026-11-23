/**
 * The sidebar's Playground row: the common area, for everyone, while it is switched on and set
 * up. It opens /playground, and the Playground's own workspace page lights it, not Workspaces.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ info: undefined as Record<string, unknown> | undefined }))
vi.mock('@/hooks/usePlayground', () => ({ usePlayground: () => ({ data: state.info }) }))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/store/auth', () => ({ useNavPermission: () => true, usePermissionsReady: () => true }))
vi.mock('@/hooks/useAnalyticsAccess', () => ({ useAnalyticsAccess: () => ({ allowed: false }) }))
vi.mock('@/hooks/useLayoutTemplates', () => ({ useLayoutTemplatesEnabled: () => false }))
vi.mock('@/hooks/useOnboardingProgress', () => ({ useOnboardingProgress: () => ({ isLoading: true }) }))
vi.mock('@/hooks/useWorkspaceContext', () => ({ useWorkspaceContext: () => ({ viewCount: 0, workspace: null }) }))

import { SidebarNav } from '../SidebarNav'

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
function renderSidebar(at = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Routes><Route path="*" element={<><SidebarNav /><Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const ON = { enabled: true, exists: true, workspaceId: 'ws_play', joined: false, graphQuota: 5, graphsUsed: 0, canSetUp: false }

beforeEach(() => { state.info = ON })

describe('the sidebar’s Playground row', () => {
  it('opens the Playground for anyone', async () => {
    renderSidebar()
    fireEvent.click(await screen.findByRole('button', { name: /^Playground/ }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/playground$/)
  })

  it('is not there while the Playground is off or not set up', async () => {
    state.info = { ...ON, enabled: false }
    const { unmount } = renderSidebar()
    await screen.findByRole('button', { name: /^Dashboard/ })
    expect(screen.queryByRole('button', { name: /^Playground/ })).not.toBeInTheDocument()
    unmount()
    state.info = { ...ON, exists: false, workspaceId: null }
    renderSidebar()
    await screen.findByRole('button', { name: /^Dashboard/ })
    expect(screen.queryByRole('button', { name: /^Playground/ })).not.toBeInTheDocument()
  })

  it('is lit on the Playground’s own page, and Workspaces is not', async () => {
    renderSidebar('/workspaces/ws_play')
    const row = await screen.findByRole('button', { name: /^Playground/ })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /^Workspaces/ })).not.toHaveAttribute('aria-current', 'page')
  })
})
