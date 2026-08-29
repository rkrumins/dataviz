/**
 * TopBar — what the header search box promises.
 *
 * The box has never searched anything: it opens the ⌘K palette. So a
 * placeholder that read "Search nodes in Quarterly revenue…" on a view was
 * an offer the click could not keep — the palette never looked inside a
 * view and still does not. One honest sentence, on every route.
 */
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSchemaStore } from '@/store/schema'
import type { WorkspaceSchema } from '@/types/schema'

// The header's popovers and bells each own a query of their own; none of
// them has an opinion about the search box.
vi.mock('@/components/layout/BookmarksPopover', () => ({ BookmarksPopover: () => null }))
vi.mock('@/components/layout/NotificationBell', () => ({ NotificationBell: () => null }))
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }))

import { TopBar } from '../TopBar'

beforeEach(() => {
  // An active view is exactly the state the old placeholder reacted to.
  useSchemaStore.setState({
    schema: { views: [{ id: 'v1', name: 'Quarterly revenue' }] } as unknown as WorkspaceSchema,
    activeViewId: 'v1',
  })
})

describe('TopBar search box', () => {
  it('says the same honest thing on a view as anywhere else', () => {
    render(
      <MemoryRouter initialEntries={['/views/v1']}>
        <TopBar onOpenCommandPalette={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Search pages, views, workspaces, docs…')).toBeInTheDocument()
    expect(screen.queryByText(/Search nodes in/)).not.toBeInTheDocument()
  })
})
