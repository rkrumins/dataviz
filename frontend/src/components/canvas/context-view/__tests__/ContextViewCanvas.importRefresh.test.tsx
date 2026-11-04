/**
 * After an import the canvas really refreshes. The import wrote entities into the draft AND their
 * placements into the draft's layout overlay, server-side; what the canvas held was read before
 * either. So, once the import dialog closes, in this order:
 *   1. the draft's view is read again — its overlay now places the imported entities — and applied;
 *   2. the providers' cached reads are dropped (they answer for the draft before the import);
 *   3. `draftEpoch` bumps, which re-keys every draft read and remounts the canvas.
 * Bumping first (as it used to, on `mainEpoch`) re-read the draft against the OLD layout: in a
 * curated view the imported entities had no placement and never showed.
 *
 * And opening the dialog first saves a pending layout edit: the import writes into the same
 * overlay, and a debounced save landing after it would put the old layout back over it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const updateViewLayoutMock = vi.fn()
const getViewMock = vi.fn()
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewApiService')>()),
  updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
  getView: (...args: unknown[]) => getViewMock(...args),
}))
const releaseProviderCachesMock = vi.fn(() => 0)
vi.mock('@/providers/providerPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/providerPool')>()),
  releaseProviderCaches: () => releaseProviderCachesMock(),
}))
// The dialog itself is tested on its own; here it only has to say an import happened, and close.
vi.mock('@/features/import-export/ImportDialog', () => ({
  ImportDialog: (p: { onClose: () => void; onImported?: () => void }) => (
    <div data-testid="import-dialog">
      <button type="button" onClick={() => p.onImported?.()}>Imported (stub)</button>
      <button type="button" onClick={p.onClose}>Close (stub)</button>
    </div>
  ),
}))

import { act, fireEvent, screen } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useFeaturesStore } from '@/store/features'
import { useSchemaStore } from '@/store/schema'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const IMPORTED = 'urn:imported:table'

async function openCanvas() {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  const estate = cfoEstate()
  const base = { layers: estate.layers, assignments: estate.assignments }
  getViewMock.mockImplementation(async () => ({
    id: 'harness-view',
    config: { layout: { type: 'reference', referenceLayout: base }, content: { entityScope: 'curated' } },
  }))
  const h = await renderCanvasWithTrace(estate, { focus: 'cfo', draft: true })
  act(() => {
    useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, versioningEnabled: true } } as never)
    useBranchStore.setState({ graphId: 'harness-graph' } as never)
  })
  await h.settle()
  return { h, base, layerId: estate.layers[0].id }
}

async function openImport(h: { settle: () => Promise<void> }) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import / Export' })) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /^Import…/ })) })
  await h.settle()
}

const assignments = () => useSchemaStore.getState().getActiveView()?.layout?.referenceLayout?.assignments ?? {}

describe('refreshing the canvas after an import', () => {
  beforeEach(() => {
    updateViewLayoutMock.mockReset()
    updateViewLayoutMock.mockResolvedValue({})
    getViewMock.mockReset()
    releaseProviderCachesMock.mockClear()
  })

  it('reads the draft’s view again, then drops cached reads, then bumps the draft epoch', async () => {
    const { h, base, layerId } = await openCanvas()
    await openImport(h)
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument()

    // The import placed its entity in the draft's overlay; the next read of the view says so.
    const reread = deferred<unknown>()
    getViewMock.mockImplementation(() => reread.promise)
    const reads = getViewMock.mock.calls.length
    const epoch = useBranchStore.getState().draftEpoch
    expect(typeof epoch).toBe('number')
    let epochAtRelease: number | undefined
    releaseProviderCachesMock.mockImplementation(() => { epochAtRelease = useBranchStore.getState().draftEpoch; return 0 })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Imported (stub)' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close (stub)' })) })
    await h.settle()

    // Nothing is re-keyed until the view is back: a read keyed now would use the old layout.
    expect(getViewMock.mock.calls.length).toBe(reads + 1)
    expect(getViewMock.mock.calls.at(-1)).toEqual(['harness-view', 'harness-branch'])
    expect(useBranchStore.getState().draftEpoch).toBe(epoch)
    expect(releaseProviderCachesMock).not.toHaveBeenCalled()

    await act(async () => {
      reread.resolve({
        id: 'harness-view',
        config: {
          layout: { type: 'reference', referenceLayout: { ...base, assignments: { ...base.assignments, [IMPORTED]: { layerId } } } },
          content: { entityScope: 'curated' },
        },
      })
    })
    await h.settle()

    expect(assignments()[IMPORTED]).toMatchObject({ layerId })
    expect(releaseProviderCachesMock).toHaveBeenCalledTimes(1)
    expect(epochAtRelease).toBe(epoch)                         // released before the bump
    expect(useBranchStore.getState().draftEpoch).toBe(epoch + 1)
  }, 30000)

  it('does nothing when the dialog closes without an import', async () => {
    const { h } = await openCanvas()
    await openImport(h)
    const reads = getViewMock.mock.calls.length
    const epoch = useBranchStore.getState().draftEpoch

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close (stub)' })) })
    await h.settle()

    expect(getViewMock.mock.calls.length).toBe(reads)
    expect(useBranchStore.getState().draftEpoch).toBe(epoch)
    expect(releaseProviderCachesMock).not.toHaveBeenCalled()
  }, 30000)

  it('saves a pending layout edit before the dialog opens', async () => {
    const { h } = await openCanvas()
    // Rename a column: the canvas arms its debounced (1.5s) layout save.
    act(() => { fireEvent.click(screen.getAllByTitle('Rename layer')[0]) })
    const input = document.activeElement as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(updateViewLayoutMock).not.toHaveBeenCalled()

    await openImport(h)

    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)
    expect(updateViewLayoutMock.mock.calls[0][2]).toBe('harness-branch')
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument()
  }, 30000)
})
