/**
 * `/views/{id}?import=1` — "Add more data", from a Playground graph's card or the end of "New data
 * source from a file" — opens the Import dialog once the graph is known, in a draft: the open one,
 * or one opened then (`ensureDraftOpen`), after a pending layout edit is saved. The dialog reads
 * the draft as it renders, so it opens only once the draft is switched to. The param is then
 * forgotten. With no draft possible, the canvas says why and opens nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const updateViewLayoutMock = vi.fn()
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewApiService')>()),
  updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
}))
const ensureDraftOpenMock = vi.fn()
vi.mock('@/features/versioning/model/ensureDraftOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/versioning/model/ensureDraftOpen')>()),
  ensureDraftOpen: () => ensureDraftOpenMock(),
}))
// The dialog is tested on its own; here it only says which draft it imports into.
vi.mock('@/features/import-export/ImportDialog', () => ({
  ImportDialog: (p: { branchId?: string; types?: { entity: unknown[] } }) => (
    <div data-testid="import-dialog" data-branch={p.branchId ?? ''} data-types={p.types ? 'yes' : 'no'} />
  ),
}))

import { act, fireEvent, screen, within } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useFeaturesStore } from '@/store/features'
import { useNotificationStore } from '@/components/ui/notifications'

async function openCanvas(draft: boolean) {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft, search: '?import=1&tab=x' })
  act(() => {
    useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, versioningEnabled: true } } as never)
  })
  await h.settle()
  return h
}

/** The graph becomes known: what the effect waits for. */
async function graphKnown(h: { settle: () => Promise<void> }) {
  await act(async () => { useBranchStore.setState({ graphId: 'harness-graph' } as never) })
  await h.settle()
}

describe('?import=1 on the canvas', () => {
  beforeEach(() => {
    updateViewLayoutMock.mockReset().mockResolvedValue({})
    ensureDraftOpenMock.mockReset()
    useNotificationStore.setState({ notifications: [] })
    // The harness leaves the graph as the last test had it: here it is known only once a test says so.
    useBranchStore.setState({ graphId: null } as never)
  })

  it('waits for the graph, then opens the import in the open draft and forgets the param', async () => {
    const h = await openCanvas(true)
    expect(screen.queryByTestId('import-dialog')).toBeNull()
    await graphKnown(h)

    const dialog = screen.getByTestId('import-dialog')
    expect(dialog).toHaveAttribute('data-branch', 'harness-branch')
    expect(dialog).toHaveAttribute('data-types', 'yes')
    expect(ensureDraftOpenMock).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?tab=x')
  }, 30000)

  it('saves a pending layout edit before the dialog opens', async () => {
    const h = await openCanvas(true)
    act(() => { fireEvent.click(within(screen.getAllByRole('group', { name: /: actions$/ })[0]).getByRole('button', { name: /^Rename / })) })
    const input = document.activeElement as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(updateViewLayoutMock).not.toHaveBeenCalled()
    await graphKnown(h)
    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)
    expect(updateViewLayoutMock.mock.calls[0][2]).toBe('harness-branch')
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument()
  }, 30000)

  it('opens a draft first when none is open, and imports into it', async () => {
    ensureDraftOpenMock.mockImplementation(async () => {
      useBranchStore.getState().switchToDraft('br_opened', 'harness-view')
      return 'br_opened'
    })
    const h = await openCanvas(false)
    await graphKnown(h)
    expect(ensureDraftOpenMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-branch', 'br_opened')
  }, 30000)

  it('says why when no draft can be opened, and opens nothing', async () => {
    ensureDraftOpenMock.mockResolvedValue(null)
    const h = await openCanvas(false)
    await graphKnown(h)
    expect(screen.queryByTestId('import-dialog')).toBeNull()
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain(
      'Adding data opens a draft of this graph, and none could be opened: you may not be allowed to change it.')
    expect(window.location.search).toBe('?tab=x')
  }, 30000)
})
