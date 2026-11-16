/**
 * DigestSheet — what changed since the reader last looked, in every state: loading, the versions
 * with who published them and what each recorded ("—" where a version recorded nothing, never 0),
 * the reviews waiting on them, the entities they watch that changed, the last 7 days for a reader
 * with no marker, the cap ("50 of 214", or "there are more"), nothing new, and an error with a
 * retry. Each way on: a version's changes in place (ChangeList), its comparison (RevisionCompare,
 * through `onCompare`), a watched entity's history (EntityHistory), a review's page. Opening it
 * marks nothing seen; "Mark as seen" marks the version shown, and the digest is read again.
 *
 * The API is mocked and the hooks are real; ChangeList and EntityHistory stand in for themselves.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/store/auth'

vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  getGraphDigest: vi.fn(),
  markDigestSeen: vi.fn(),
}))
vi.mock('../ChangeList', () => ({
  ChangeList: (p: { origin: { fromSeq: number; toSeq: number } }) => <p>Changes of {p.origin.fromSeq}→{p.origin.toSeq}</p>,
}))
vi.mock('../EntityHistory', () => ({
  EntityHistory: (p: { entityId: string; mainBranchId: string | null }) => <p>History of {p.entityId} on {p.mainBranchId}</p>,
}))

import { getGraphDigest, markDigestSeen } from '@/services/versioningApiService'
import { DigestSheet } from '../DigestSheet'
import { ME, NOTHING_NEW, digest, truncated } from '../__fixtures__/digest'

const mockDigest = vi.mocked(getGraphDigest)
const mockSeen = vi.mocked(markDigestSeen)

function renderSheet() {
  const onCompare = vi.fn()
  const onOpenChange = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DigestSheet wsId="ws1" graphId="g1" mainBranchId="br_main" open onOpenChange={onOpenChange} onCompare={onCompare} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onCompare, onOpenChange }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ user: { id: ME } } as never)
})

describe('DigestSheet', () => {
  it('shows its loading state while the digest is on its way', async () => {
    mockDigest.mockReturnValue(new Promise(() => {}))
    renderSheet()
    expect(await screen.findByRole('status')).toHaveTextContent('Loading what changed')
  })

  it('lists the versions since the last visit, newest first, with who and what each recorded', async () => {
    mockDigest.mockResolvedValue(digest())
    renderSheet()
    const dialog = await screen.findByRole('dialog', { name: 'Since your last visit' })
    expect(dialog).toHaveTextContent('You marked it seen at version #212')
    const versions = within(screen.getByRole('region', { name: /Versions/ })).getAllByRole('listitem')
    expect(versions.map((v) => within(v).getByText(/^#\d+$/).textContent)).toEqual(['#215', '#214', '#213'])
    expect(versions[0]).toHaveTextContent('Published')
    expect(versions[0]).toHaveTextContent('Owners for the Q4 finance tables')
    expect(versions[0]).toHaveTextContent('Alice Smith')
    expect(within(versions[0]).getByText('12 added, 3 modified, 1 removed')).toBeInTheDocument()
    // A version that recorded no counts says so: never a made-up 0.
    expect(versions[1]).toHaveTextContent('Synced')
    expect(versions[1]).toHaveTextContent('The platform')
    expect(within(versions[1]).getByText('Changes not recorded').parentElement).toHaveTextContent('—')
    expect(within(versions[2]).getByText('You')).toBeInTheDocument()
    expect(within(versions[2]).getByText('2 modified, 40 removed')).toBeInTheDocument()
    // The figures at the top.
    expect(dialog).toHaveTextContent('New versions3')
    expect(dialog).toHaveTextContent('Authors3')
    expect(dialog).toHaveTextContent('Reviews waiting1')
    expect(dialog).toHaveTextContent('You watch2')
    const people = within(screen.getByRole('region', { name: /Who published/ }))
    expect(people.getByText('The platform')).toBeInTheDocument()
    expect(people.getAllByText('1 version')).toHaveLength(3)
  })

  it('opens a version’s changes in place, and its comparison in History', async () => {
    mockDigest.mockResolvedValue(digest())
    const { onCompare } = renderSheet()
    const user = userEvent.setup()
    const region = within(await screen.findByRole('region', { name: /Versions/ }))
    const first = region.getAllByRole('listitem')[0]
    const changes = within(first).getByRole('button', { name: 'Changes' })
    expect(changes).toHaveAttribute('aria-expanded', 'false')
    await user.click(changes)
    expect(changes).toHaveAttribute('aria-expanded', 'true')
    expect(within(first).getByText('Changes of 214→215')).toBeInTheDocument()
    await user.click(within(first).getByRole('button', { name: /Compare/ }))
    expect(onCompare).toHaveBeenLastCalledWith(214, 215)
    await user.click(screen.getByRole('button', { name: 'Compare all' }))
    expect(onCompare).toHaveBeenLastCalledWith(212, null)          // everything since the marker
  })

  it('lists the reviews waiting on the reader, each a link to its review', async () => {
    mockDigest.mockResolvedValue(digest())
    const { onOpenChange } = renderSheet()
    const link = await screen.findByRole('link', { name: /Rename the revenue measures/ })
    expect(link).toHaveAttribute('href', '/workspaces/ws1/reviews?pr=pr_7')
    expect(link).toHaveTextContent('Carol Diaz asked')
    await userEvent.setup().click(link)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('lists the entities the reader watches that changed, each with its history', async () => {
    mockDigest.mockResolvedValue(digest())
    renderSheet()
    const watched = within(await screen.findByRole('region', { name: /Things you watch/ }))
    const rows = watched.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Orders')
    expect(rows[0]).toHaveTextContent('Modified')
    expect(rows[0]).toHaveTextContent('in #215')
    expect(rows[1]).toHaveTextContent('Legacy ledger')
    expect(rows[1]).toHaveTextContent('Removed')
    await userEvent.setup().click(within(rows[1]).getByRole('button', { name: 'History' }))
    expect(within(rows[1]).getByText('History of urn:uuid:ledger on br_main')).toBeInTheDocument()
  })

  it('opening it marks nothing seen; “Mark as seen” marks the version shown and reads it again', async () => {
    mockDigest.mockResolvedValueOnce(digest()).mockResolvedValue(NOTHING_NEW)
    mockSeen.mockResolvedValue({ seq: 215, at: '2026-11-16T15:02:00+00:00' })
    renderSheet()
    await screen.findByRole('dialog', { name: 'Since your last visit' })
    expect(mockSeen).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mark as seen' }))
    expect(mockSeen).toHaveBeenCalledWith('ws1', 'g1', 215)
    expect(await screen.findByText('Nothing new since you last looked')).toBeInTheDocument()
    expect(screen.getByText('You’re up to date with version #215.')).toBeInTheDocument()
    expect(mockDigest).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Mark as seen' })).not.toBeInTheDocument()
  })

  it('with no marker, shows the last 7 days and says why', async () => {
    mockDigest.mockResolvedValue(digest({ since: null, window: 'last_7_days' }))
    const { onCompare } = renderSheet()
    const dialog = await screen.findByRole('dialog', { name: 'The last 7 days' })
    expect(dialog).toHaveTextContent('You haven’t marked this graph seen yet, so here is everything published in the last 7 days.')
    expect(dialog).toHaveTextContent('Versions3')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compare all' }))
    expect(onCompare).toHaveBeenLastCalledWith(212, null)          // from before the oldest listed
    expect(screen.getByRole('button', { name: 'Mark as seen' })).toBeInTheDocument()
  })

  it('says how many it leaves out past the cap, or that there are more', async () => {
    mockDigest.mockResolvedValue(truncated(214))
    const { unmount } = renderOnce()
    expect(await screen.findByText('Showing the latest 50 of 214 versions')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('New versions214')
    unmount()
    mockDigest.mockResolvedValue(truncated(null))
    renderOnce()
    expect(await screen.findByText('Showing the latest 50 versions — there are more')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('Versions50+')
    // What "Compare all" reaches, said exactly: from the oldest listed, not the whole 7 days.
    expect(screen.getByText('Compare all reaches every change from version #351 to now.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Who published/ })).toHaveTextContent('2 in the latest 50')
  })

  it('with nothing new and no marker to move, offers nothing to mark', async () => {
    mockDigest.mockResolvedValue(NOTHING_NEW)
    renderSheet()
    expect(await screen.findByText('Nothing new since you last looked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as seen' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Compare all' })).not.toBeInTheDocument()
  })

  it('says what failed, and tries again', async () => {
    // Asked twice (one retry) before it gives up.
    mockDigest.mockRejectedValueOnce(new Error('Service unavailable'))
      .mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValue(digest())
    renderSheet()
    expect(await screen.findByText('Couldn’t load what changed', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Service unavailable')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Since your last visit' })).toBeInTheDocument())
  })
})

function renderOnce() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DigestSheet wsId="ws1" graphId="g1" mainBranchId="br_main" open onOpenChange={() => {}} onCompare={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
