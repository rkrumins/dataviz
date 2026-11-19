/**
 * Saved narrowings on the REAL Context View canvas. A short link (`?narrowSaved=`) opens the
 * view narrowed as it was saved — asked again against the data as it is now — and the
 * Narrowed bar says what is new and gone since; the header lists the view's saved
 * narrowings. Saving one from the bar keeps its spec and what it held.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MembershipRequest, MembershipResult } from '@/types/membership'
import type { SavedNarrowing, SavedNarrowingInput } from '@/services/viewNarrowingsApi'

const api = vi.hoisted(() => ({
  listNarrowings: vi.fn(),
  getNarrowing: vi.fn(),
  readHeld: vi.fn(),
  saveNarrowing: vi.fn(),
}))
vi.mock('@/services/viewNarrowingsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewNarrowingsApi')>()),
  listNarrowings: (...a: unknown[]) => api.listNarrowings(...a),
  getNarrowing: (...a: unknown[]) => api.getNarrowing(...a),
  readHeld: (...a: unknown[]) => api.readHeld(...a),
  saveNarrowing: (...a: unknown[]) => api.saveNarrowing(...a),
}))

import { useNarrowStore } from '@/features/narrow/narrowStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useAuthStore } from '@/store/auth'
import { useFeaturesStore } from '@/store/features'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'

const ONE_LEVEL_IN: MembershipResult = {
  specHash: 'h1',
  members: [{ urn: 'INTERMEDIATE_T2', via: 'seed' }, { urn: 'orders', via: 'inside' }],
  wholeSubtree: [],
  chains: { INTERMEDIATE_T2: ['snowflake'], orders: ['INTERMEDIATE_T2', 'snowflake'] },
  counts: { seeds: 1, inside: 1, upstream: 0, downstream: 0, partnerInside: 0, total: 2 },
  missingSeeds: 0, truncated: [], dataVersion: '1', elapsedMs: 3,
}

const SAVED: SavedNarrowing = {
  id: 'n1aaaaaaaaaa', viewId: 'harness-view', name: 'Warehouse, one level in',
  spec: { v: 1, seeds: { urns: ['INTERMEDIATE_T2'] }, within: 'view', expand: { children: 1, upstream: 0, downstream: 0, partnerChildren: 0 } },
  seedsLabel: 'INTERMEDIATE_T2', seedNames: { INTERMEDIATE_T2: 'INTERMEDIATE_T2' },
  held: { count: 2, complete: true, kept: true }, createdAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:00:00Z', canChange: true,
}

function setPreview(on: boolean) {
  useFeaturesStore.setState({
    values: { ...useFeaturesStore.getState().values, viewMembershipEnabled: on, traceEnabled: true },
  } as never)
}

const card = (id: string) => {
  const el = document.getElementById(`layer-node-${id}`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}

describe('Saved narrowings on the canvas', () => {
  afterEach(() => {
    useNarrowStore.getState().clear()
    setPreview(false)
    Object.values(api).forEach((f) => f.mockReset())
    window.history.replaceState(null, '', '/')
  })

  it('opens from its short link and says what is new and gone since it was saved', async () => {
    setPreview(true)
    api.listNarrowings.mockResolvedValue({ items: [SAVED], canEdit: true, limits: { perView: 200, perUser: 50 } })
    api.getNarrowing.mockResolvedValue(SAVED)
    api.readHeld.mockResolvedValue(['INTERMEDIATE_T2', 'gone_since'])
    const asked: MembershipRequest[] = []
    await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      deferTrace: true,
      search: '?narrowSaved=n1aaaaaaaaaa&tab=2',
      wrapProvider: (p) => ({ ...p, resolveMembers: async (_v: string, r: MembershipRequest) => { asked.push(r); return ONE_LEVEL_IN } }) as GraphDataProvider,
    })
    const chip = await screen.findByRole('status', { name: 'The canvas is narrowed' }, { timeout: 8000 })
    await waitFor(() => expect(chip).toHaveTextContent(/“Warehouse, one level in” · \+1 new · −1 gone since/))
    expect(asked[0]?.spec).toEqual(SAVED.spec)
    expect(api.getNarrowing).toHaveBeenCalledWith('harness-view', 'n1aaaaaaaaaa')
    expect(window.location.search).toBe('?tab=2')
    // The header lists the view's saved narrowings.
    expect(await screen.findByRole('button', { name: 'Saved narrowings (1)' })).toBeInTheDocument()
  }, 40000)

  it('saves the narrowing on screen with what it held', async () => {
    setPreview(true)
    useAuthStore.setState({ user: { ...(useAuthStore.getState().user ?? {}), id: 'u1' } } as never)
    api.listNarrowings.mockResolvedValue({ items: [], canEdit: true, limits: { perView: 200, perUser: 50 } })
    api.saveNarrowing.mockImplementation(async (_v: string, id: string, body: SavedNarrowingInput) => ({ ...SAVED, id, name: body.name }))
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      deferTrace: true,
      wrapProvider: (p) => ({ ...p, resolveMembers: async () => ONE_LEVEL_IN }) as GraphDataProvider,
    })
    await act(async () => { fireEvent.contextMenu(card('INTERMEDIATE_T2')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Narrow to this…')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('One level in')) })
    await waitFor(() => expect(screen.getByRole('status', { name: 'The canvas is narrowed' })).toBeInTheDocument(), { timeout: 8000 })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Save$/ })) })
    const form = within(screen.getByRole('dialog', { name: 'Save this narrowing' }))
    fireEvent.change(form.getByLabelText('Save with this view'), { target: { value: 'Mine' } })
    await act(async () => { fireEvent.click(form.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(api.saveNarrowing).toHaveBeenCalledOnce())
    const [viewId, id, body] = api.saveNarrowing.mock.calls[0] as [string, string, SavedNarrowingInput]
    expect(viewId).toBe('harness-view')
    expect(id).toMatch(/^[A-Za-z0-9]{12}$/)
    expect(body).toMatchObject({ name: 'Mine', spec: { seeds: { urns: ['INTERMEDIATE_T2'] }, expand: { children: 1 } }, held: { count: 2, complete: true } })
    await waitFor(() => expect(screen.getByRole('status', { name: 'The canvas is narrowed' })).toHaveTextContent('Saved as “Mine”'))
  }, 40000)
})
