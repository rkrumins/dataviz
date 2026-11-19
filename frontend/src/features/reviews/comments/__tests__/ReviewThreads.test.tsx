/**
 * A review's threads read as conversations: replies in order, the field a thread is on,
 * Outdated once its change was edited, mentions highlighted; Reply, Resolve, a resolved thread
 * folded; and the composer — @ to mention someone, ⌘↵ to post, shown at once and kept with Retry
 * when it fails.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({
  listReviewThreads: vi.fn(),
  postReviewComment: vi.fn(),
  setReviewThreadResolved: vi.fn(),
  listReviewCommentPeople: vi.fn(),
  editReviewComment: vi.fn(),
  deleteReviewComment: vi.fn(),
  getReviewCommentCounts: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me' } }),
}))

import { ReviewThreads, type DiscussionAccess } from '../ReviewThreads'

const access: DiscussionAccess = { canComment: true, canModerate: false }
const comment = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 'rc_1', threadId: 'rc_1', entityId: 'T1', path: null, body: 'Hello', mentions: [], author: 'u_bo',
  createdAt: new Date().toISOString(), editedAt: null, deleted: false, resolvedAt: null, resolvedBy: null,
  replies: [], outdated: false, ...over,
})
const page = (threads: ReviewThread[]) => ({
  threads, total: threads.length, offset: 0, limit: 20, hasMore: false, userNames: { u_bo: 'Bo Chen', u_cy: 'Cy Diaz', u_me: 'Me' },
})

function renderThreads(props: Partial<React.ComponentProps<typeof ReviewThreads>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReviewThreads wsId="ws1" prId="pr_1" filter={{ entityId: 'T1' }} access={access}
        compose={{ entityId: 'T1', placeholder: 'Comment on this change…' }} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
})

describe('ReviewThreads', () => {
  it('reads a thread as a conversation: the field, Outdated, replies, mentions', async () => {
    api.listReviewThreads.mockResolvedValue(page([comment({
      path: 'Technical/Owner', outdated: true, body: 'Is @Cy Diaz the owner?', mentions: ['u_cy'],
      replies: [{ ...comment({ id: 'rc_2', author: 'u_cy', body: 'Yes, since May.' }), threadId: 'rc_1' }],
    })]))
    renderThreads()
    const thread = await screen.findByRole('article', { name: 'Thread by Bo Chen' })
    expect(within(thread).getByText('on Technical › Owner')).toBeInTheDocument()
    expect(within(thread).getByText(/Outdated/)).toBeInTheDocument()
    expect(within(thread).getByText('@Cy Diaz')).toHaveClass('text-accent-lineage')
    expect(within(thread).getByText('Yes, since May.')).toBeInTheDocument()
    expect(api.listReviewThreads).toHaveBeenCalledWith('ws1', 'pr_1', { entityId: 'T1' }, 0, 20)
  })

  it('resolves a thread, and folds a resolved one to a line', async () => {
    api.listReviewThreads.mockResolvedValueOnce(page([comment({})]))
    api.setReviewThreadResolved.mockResolvedValue(comment({ resolvedAt: 'now' }))
    api.listReviewThreads.mockResolvedValue(page([comment({ resolvedAt: new Date().toISOString(), resolvedBy: 'u_me' })]))
    renderThreads()
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(api.setReviewThreadResolved).toHaveBeenCalledWith('ws1', 'pr_1', 'rc_1', true))
    expect(await screen.findByText('Resolved by Me')).toBeInTheDocument()
    expect(screen.queryByText('Hello')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('mentions someone with @ and posts with ⌘↵', async () => {
    api.listReviewThreads.mockResolvedValue(page([]))
    api.listReviewCommentPeople.mockResolvedValue([
      { userId: 'u_cy', displayName: 'Cy Diaz', email: 'cy@x.io' }, { userId: 'u_me', displayName: 'Me' },
    ])
    let done!: (v: unknown) => void
    api.postReviewComment.mockReturnValue(new Promise((r) => { done = r }))
    renderThreads()
    const box = await screen.findByRole('combobox', { name: 'Comment on this change…' })
    fireEvent.change(box, { target: { value: 'Ask @c', selectionStart: 6 } })
    const option = await screen.findByRole('option', { name: /Cy Diaz/ })
    expect(screen.queryByRole('option', { name: /^Me/ })).not.toBeInTheDocument()
    fireEvent.mouseDown(option)
    expect(box).toHaveValue('Ask @Cy Diaz ')
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    // Shown at once, while it is sent; the box is free again.
    expect(await screen.findByText('Sending…')).toBeInTheDocument()
    expect(box).toHaveValue('')
    expect(api.postReviewComment).toHaveBeenCalledWith('ws1', 'pr_1',
      { body: 'Ask @Cy Diaz', mentions: ['u_cy'], entityId: 'T1', path: null })
    done(comment({ body: 'Ask @Cy Diaz' }))
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument())
  })

  it('keeps a comment that failed to post, with Retry and Edit', async () => {
    api.listReviewThreads.mockResolvedValue(page([]))
    api.postReviewComment.mockRejectedValueOnce(new Error('The server is busy.'))
    renderThreads()
    const box = await screen.findByRole('combobox', { name: 'Comment on this change…' })
    fireEvent.change(box, { target: { value: 'Looks wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByText('The server is busy.')).toBeInTheDocument()
    api.postReviewComment.mockResolvedValueOnce(comment({ body: 'Looks wrong' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.postReviewComment).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('The server is busy.')).not.toBeInTheDocument())
  })

  it('says why not, where the reader may not comment', async () => {
    api.listReviewThreads.mockResolvedValue(page([comment({})]))
    renderThreads({ access: { canComment: false, canModerate: false, commentReason: 'A key can’t take part.' } })
    expect(await screen.findByText('A key can’t take part.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
