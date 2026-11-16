/**
 * DigestChip — the quiet note in the canvas versioning bar: nothing while the digest loads or when
 * nothing is new; how many versions were published since the reader's last visit (or, with no
 * marker, in the last 7 days, "50+" when that window is cut short); the reviews waiting on them
 * when nothing was published; a quiet "couldn't check" when the digest can't be read. Read once:
 * the API is mocked, the hooks are real.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  getGraphDigest: vi.fn(),
}))

import { getGraphDigest } from '@/services/versioningApiService'
import { DigestChip } from '../DigestChip'
import { digest, version } from '../__fixtures__/digest'

const mockDigest = vi.mocked(getGraphDigest)

function renderChip(onOpen = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (
    <QueryClientProvider client={qc}>
      <DigestChip workspaceId="ws1" graphId="g1" onOpen={onOpen} />
    </QueryClientProvider>
  )
  return { ...render(ui), onOpen, qc }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DigestChip', () => {
  it('says nothing while the digest loads', () => {
    mockDigest.mockReturnValue(new Promise(() => {}))
    const { container } = renderChip()
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing when nothing is new and no review waits', async () => {
    mockDigest.mockResolvedValue(digest({ versions: [], total: 0, authors: [] }))
    const { container } = renderChip()
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the versions since the last visit, and opens the sheet', async () => {
    mockDigest.mockResolvedValue(digest())
    const { onOpen } = renderChip()
    const chip = await screen.findByRole('button', { name: '3 new versions since your last visit. Open what changed' })
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    expect(chip).toHaveTextContent('3 new versions since your last visit')
    await userEvent.setup().click(chip)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('says one version in the singular', async () => {
    mockDigest.mockResolvedValue(digest({ versions: [version(215)], total: 1 }))
    renderChip()
    expect(await screen.findByRole('button', { name: /^1 new version since your last visit/ })).toBeInTheDocument()
  })

  it('with no marker, counts the last 7 days, and says "+" when the window is cut short', async () => {
    mockDigest.mockResolvedValue(digest({ since: null, window: 'last_7_days', total: 12 }))
    const { unmount } = renderChip()
    expect(await screen.findByRole('button', { name: /^12 versions in the last 7 days/ })).toBeInTheDocument()
    unmount()
    mockDigest.mockResolvedValue(digest({ since: null, window: 'last_7_days', total: null, truncated: true,
      versions: Array.from({ length: 50 }, (_, i) => version(300 - i)) }))
    renderChip()
    expect(await screen.findByRole('button', { name: /^50\+ versions in the last 7 days/ })).toBeInTheDocument()
  })

  it('says a review waits on the reader when nothing was published', async () => {
    mockDigest.mockResolvedValue(digest({
      versions: [], total: 0, authors: [],
      reviewsWaiting: [{ id: 'pr_1', title: 'Q4 owners', url: '/workspaces/ws1/reviews?pr=pr_1',
        author: { id: 'usr_carol', name: 'Carol Smith' }, at: '2026-11-16T09:00:00+00:00' }],
    }))
    renderChip()
    expect(await screen.findByRole('button', { name: /^1 review waiting on you/ })).toBeInTheDocument()
  })

  it('says quietly that it could not check, and still opens the sheet to try again', async () => {
    mockDigest.mockRejectedValue(new Error('Service unavailable'))
    const { onOpen } = renderChip()
    // Asked twice (one retry) before it gives up.
    const chip = await screen.findByRole('button', { name: 'Couldn’t check what changed' }, { timeout: 4000 })
    await userEvent.setup().click(chip)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(mockDigest).toHaveBeenCalledTimes(2)
  })

  it('reads the digest once: no refetch when the window regains focus', async () => {
    mockDigest.mockResolvedValue(digest())
    renderChip()
    await screen.findByRole('button', { name: /new versions/ })
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('visibilitychange')) })
    expect(mockDigest).toHaveBeenCalledOnce()
    expect(mockDigest).toHaveBeenCalledWith('ws1', 'g1')
  })
})
