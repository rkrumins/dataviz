/**
 * UnsavedWorkGuard — covers both leave paths from a canvas:
 *  - beforeunload armed/disarmed by the REAL staged-changes store (not a
 *    hardcoded boolean), mirroring useUnsavedChangesWarning.test.ts.
 *  - in-app navigation blocked via react-router's data-router `useBlocker`,
 *    driven through an actual createMemoryRouter/RouterProvider harness so
 *    the real router seam is exercised — "Stay" cancels, "Leave anyway"
 *    proceeds, Escape stays.
 */
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { UnsavedWorkGuard } from '../UnsavedWorkGuard'

const resetStore = () =>
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })

const stageChange = (id: string) =>
  useStagedChangesStore.getState().stage({
    type: 'rename_entity',
    targetId: id,
    after: { name: id },
    summary: `rename ${id}`,
  })

function renderGuard(initialPath = '/views/v1') {
  const router = createMemoryRouter(
    [
      { path: '/views/v1', element: <UnsavedWorkGuard /> },
      { path: '/dashboard', element: <div>Dashboard landed</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('UnsavedWorkGuard', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetStore()
    addSpy = vi.spyOn(window, 'addEventListener')
    removeSpy = vi.spyOn(window, 'removeEventListener')
  })

  afterEach(() => {
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  const beforeUnloadCalls = (spy: typeof addSpy) =>
    spy.mock.calls.filter(([event]) => event === 'beforeunload')

  describe('beforeunload (browser-level unload)', () => {
    it('does not arm the prompt when the staged-changes store is empty', () => {
      renderGuard()
      expect(beforeUnloadCalls(addSpy)).toHaveLength(0)
    })

    it('arms the prompt driven by the real staged-changes store', () => {
      stageChange('e1')
      renderGuard()
      expect(beforeUnloadCalls(addSpy)).toHaveLength(1)
    })

    it('disarms the prompt once the store empties', () => {
      stageChange('e1')
      renderGuard()
      expect(beforeUnloadCalls(addSpy)).toHaveLength(1)

      act(() => {
        useStagedChangesStore.getState().discardAll()
      })
      expect(beforeUnloadCalls(removeSpy)).toHaveLength(1)
    })
  })

  describe('in-app navigation blocker', () => {
    it('does not block navigation when there is no unsaved work', async () => {
      const router = renderGuard()
      await act(async () => {
        await router.navigate('/dashboard')
      })
      expect(await screen.findByText('Dashboard landed')).toBeInTheDocument()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('blocks navigation and renders the dialog when work is staged', async () => {
      stageChange('e1')
      const router = renderGuard()
      act(() => {
        router.navigate('/dashboard')
      })
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
      expect(screen.getByText('Leave without saving?')).toBeInTheDocument()
      expect(screen.getByText(/You have 1 unsaved change/)).toBeInTheDocument()
      expect(screen.queryByText('Dashboard landed')).not.toBeInTheDocument()
    })

    it('pluralizes the change count in the dialog body', async () => {
      stageChange('e1')
      stageChange('e2')
      const router = renderGuard()
      act(() => {
        router.navigate('/dashboard')
      })
      expect(await screen.findByText(/You have 2 unsaved changes/)).toBeInTheDocument()
    })

    it('"Stay and keep editing" cancels the navigation and preserves the staged changes', async () => {
      stageChange('e1')
      const router = renderGuard()
      act(() => {
        router.navigate('/dashboard')
      })
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Stay and keep editing' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(screen.queryByText('Dashboard landed')).not.toBeInTheDocument()
      expect(useStagedChangesStore.getState().changes).toHaveLength(1)
    })

    it('"Leave anyway" proceeds with the navigation', async () => {
      stageChange('e1')
      const router = renderGuard()
      act(() => {
        router.navigate('/dashboard')
      })
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Leave anyway' }))

      expect(await screen.findByText('Dashboard landed')).toBeInTheDocument()
    })

    it('Escape stays on the page (same as "Stay and keep editing")', async () => {
      stageChange('e1')
      const router = renderGuard()
      act(() => {
        router.navigate('/dashboard')
      })
      await screen.findByRole('alertdialog')

      const user = userEvent.setup()
      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(screen.queryByText('Dashboard landed')).not.toBeInTheDocument()
    })
  })
})
