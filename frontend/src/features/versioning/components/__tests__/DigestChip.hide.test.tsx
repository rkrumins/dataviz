/**
 * Hiding the "what's new" chip — "3 new versions since your last visit" / "12 versions in the last
 * 7 days". Its × hides it until something new is published (it marks the graph seen at the version
 * it showed, as the sheet's "Mark as seen" does); Display › "Show what's new on this graph" off
 * hides the news on every graph, for good. A review waiting on the reader is a task, not news: it
 * still shows.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  getGraphDigest: vi.fn(),
  markDigestSeen: vi.fn(),
}))

import { getGraphDigest, markDigestSeen } from '@/services/versioningApiService'
import { usePreferencesStore } from '@/store/preferences'
import { DigestChip } from '../DigestChip'
import { digest } from '../__fixtures__/digest'

const mockDigest = vi.mocked(getGraphDigest)
const mockSeen = vi.mocked(markDigestSeen)

function renderChip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DigestChip workspaceId="ws1" graphId="g1" onOpen={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  usePreferencesStore.setState({ showGraphDigest: true })
})
afterEach(() => usePreferencesStore.setState({ showGraphDigest: true }))

describe('hiding the what’s-new chip', () => {
  it('× hides it until something new: the graph is marked seen at the version it showed', async () => {
    mockDigest.mockResolvedValueOnce(digest({ window: 'last_7_days', since: null, reviewsWaiting: [] }))
    mockSeen.mockResolvedValue({ seq: 215, at: '2026-11-16T15:00:00+00:00' })
    // Read again once seen: nothing new since.
    mockDigest.mockResolvedValue(digest({ versions: [], total: 0, authors: [], reviewsWaiting: [], since: { seq: 215, at: '2026-11-16T15:00:00+00:00' } }))
    const { container } = renderChip()
    await screen.findByRole('button', { name: /3 versions in the last 7 days\. Open what changed/ })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide until something new is published' }))
    expect(mockSeen).toHaveBeenCalledWith('ws1', 'g1', 215)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('Display › "Show what’s new" off: no news of versions on any graph', async () => {
    usePreferencesStore.setState({ showGraphDigest: false })
    mockDigest.mockResolvedValue(digest({ reviewsWaiting: [] }))
    const { container } = renderChip()
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('…but a review waiting on the reader still shows, with no ×', async () => {
    usePreferencesStore.setState({ showGraphDigest: false })
    mockDigest.mockResolvedValue(digest())
    renderChip()
    expect(await screen.findByRole('button', { name: '1 review waiting on you. Open what changed' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide until something new is published' })).toBeNull()
  })
})
