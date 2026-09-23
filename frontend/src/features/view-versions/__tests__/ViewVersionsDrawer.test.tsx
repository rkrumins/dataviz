/**
 * ViewVersionsDrawer pins:
 *   - unsaved changes are named as changes since the latest version, and can be saved with a note;
 *   - each version says where it came from (an import names its environment and version);
 *   - comparing shows what changed;
 *   - restoring explains itself (a NEW version, unsaved work kept first, graph data untouched)
 *     and asks the server for exactly that version;
 *   - a reader sees the history but no way to save or restore;
 *   - Escape closes the drawer, or only the restore question when that is open.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewVersionPage, ViewVersionSummary } from '@/services/viewVersionsApiService'

const listMock = vi.fn()
const statusMock = vi.fn()
const compareMock = vi.fn()
const restoreMock = vi.fn()
const saveMock = vi.fn()

vi.mock('@/services/viewVersionsApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewVersionsApiService')>()
  return {
    ...actual,
    listViewVersions: (...a: unknown[]) => listMock(...a),
    getViewVersionStatus: (...a: unknown[]) => statusMock(...a),
    compareViewVersions: (...a: unknown[]) => compareMock(...a),
    restoreViewVersion: (...a: unknown[]) => restoreMock(...a),
    saveViewVersion: (...a: unknown[]) => saveMock(...a),
  }
})
vi.mock('@/services/viewApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/viewApiService')>()
  return { ...actual, viewToViewConfig: (v: unknown) => v }
})
vi.mock('@/store/schema', () => ({
  useSchemaStore: Object.assign(() => undefined, { getState: () => ({ addOrUpdateView: vi.fn() }) }),
}))

import { ViewVersionsDrawer } from '../ViewVersionsDrawer'

function version(n: number, extra: Partial<ViewVersionSummary> = {}): ViewVersionSummary {
  return {
    version: n, contentHash: `sha256:${n}abcdef0123`, name: 'Finance', tags: [], source: 'wizard',
    stats: { layers: 2, assignments: 10 * n }, createdAt: new Date().toISOString(), createdByName: 'Dana', ...extra,
  }
}

const EMPTY_DIFF = {
  metadata: [], layers: { added: [], removed: [], changed: [], reordered: false },
  assignments: { added: 0, removed: 0, moved: 0, modified: 0, samples: { added: [], removed: [], moved: [], modified: [] }, truncated: false },
  settings: [], identical: false,
}

function page(): ViewVersionPage {
  return {
    items: [
      version(3, { source: 'import', provenance: { origin: { environment: 'dev', version: 12 } } }),
      version(2, { message: 'Tidy layers' }),
      version(1, { source: 'create' }),
    ],
    hasMore: false, nextBefore: null, portableId: 'pv_1',
    workingCopy: {
      headVersion: 3, headHash: 'sha256:3', workingHash: 'sha256:x', designChanged: true, labelChanged: false, dirty: true,
      summary: { ...EMPTY_DIFF, assignments: { ...EMPTY_DIFF.assignments, added: 4 } },
    },
  }
}

function renderDrawer(canEdit = true, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ViewVersionsDrawer viewId="view_1" viewName="Finance" isOpen onClose={onClose} canEdit={canEdit} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listMock.mockResolvedValue(page())
  statusMock.mockResolvedValue({ headVersion: 3, headHash: 'h', workingHash: 'x', designChanged: true, labelChanged: false, dirty: true, origin: null })
})

describe('ViewVersionsDrawer', () => {
  it('names unsaved changes and saves them as a version with a note', async () => {
    saveMock.mockResolvedValue({ version: version(4), created: true })
    renderDrawer()
    expect(await screen.findByText('Changes since v3')).toBeInTheDocument()
    expect(screen.getByText('4 placed')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Note for this version'), { target: { value: 'Before UAT' } })
    fireEvent.click(screen.getByRole('button', { name: /Save version/ }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('view_1', 'Before UAT'))
  })

  it('says where each version came from', async () => {
    renderDrawer()
    expect(await screen.findByText('from dev v12')).toBeInTheDocument()
    expect(screen.getByText('Imported')).toBeInTheDocument()
    expect(screen.getByText(/Tidy layers/)).toBeInTheDocument()
  })

  it('compares a version with the one before it', async () => {
    compareMock.mockResolvedValue({ from: 1, to: 2, diff: { ...EMPTY_DIFF, layers: { ...EMPTY_DIFF.layers, added: [{ id: 'l3', name: 'Marts' }] } } })
    renderDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'with v1' }))
    expect(await screen.findByText('Marts')).toBeInTheDocument()
    expect(compareMock).toHaveBeenCalledWith('view_1', 1, 2)
  })

  it('restores as a new version, and says the graph data is untouched', async () => {
    restoreMock.mockResolvedValue({ view: { id: 'view_1' }, version: version(5, { source: 'restore' }), snapshot: version(4, { source: 'snapshot' }) })
    renderDrawer()
    const restoreButtons = await screen.findAllByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButtons[0])                    // v2 (the head, v3, has none)
    expect(screen.getByText('Restore v2?')).toBeInTheDocument()
    expect(screen.getByText(/graph data isn’t affected/)).toBeInTheDocument()
    expect(screen.getByText(/saved first, as v4/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore v2' }))
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('view_1', 2))
  })

  it('closes on Escape, or closes only the restore question when that is open', async () => {
    const onClose = vi.fn()
    renderDrawer(true, onClose)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Restore' }))[0])
    expect(screen.getByText('Restore v2?')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Restore v2?')).not.toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets a reader read, and only read', async () => {
    renderDrawer(false)
    expect(await screen.findByText('Changes since v3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save version/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
  })
})
