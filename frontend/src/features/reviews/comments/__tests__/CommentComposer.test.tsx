/**
 * The composer takes its people from whatever source it is given — a review's people, those who
 * can read a view — asking it as the name is typed, and shows each with their face and why they
 * are worth mentioning. A comment that failed to post keeps its key: Retry sends the same one, so
 * a post that did arrive is not written twice.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u_me', displayName: 'Me' } }),
}))

import { CommentComposer, type MentionSource } from '../CommentComposer'
import type { MentionCandidate } from '../mentions'

const PEOPLE: MentionCandidate[] = [
  { id: 'u_ana', name: 'Ana Silva', email: 'ana@x.io', hint: 'View owner', avatarId: null, hasImage: false },
  { id: 'u_me', name: 'Me' },
]

function renderComposer(props: Partial<React.ComponentProps<typeof CommentComposer>> = {}) {
  const load = vi.fn(async (q: string) => PEOPLE.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())))
  const source: MentionSource = { queryKey: ['test', 'people'], load }
  const onSubmit = props.onSubmit ?? vi.fn().mockResolvedValue(undefined)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CommentComposer mentionSource={source} placeholder="Reply…" submitLabel="Reply" {...props} onSubmit={onSubmit} />
    </QueryClientProvider>,
  )
  return { load, onSubmit, box: screen.getByRole('combobox', { name: 'Reply…' }) }
}

describe('CommentComposer', () => {
  it('asks the source it is given for the people a mention matches, with their role', async () => {
    const { load, box } = renderComposer()
    fireEvent.change(box, { target: { value: 'Hi @an', selectionStart: 6 } })
    const option = await screen.findByRole('option', { name: /Ana Silva/ })
    expect(load).toHaveBeenCalledWith('an')
    expect(within(option).getByText('View owner')).toBeInTheDocument()
    expect(within(option).getByText('ana@x.io')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box).toHaveValue('Hi @Ana Silva ')
  })

  it('never offers the writer themself', async () => {
    const { box } = renderComposer()
    fireEvent.change(box, { target: { value: '@', selectionStart: 1 } })
    expect(await screen.findByRole('option', { name: /Ana Silva/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Me/ })).not.toBeInTheDocument()
  })

  it('sends the mentions and a key; Retry sends the same key again', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Network down.')).mockResolvedValueOnce(undefined)
    const { box } = renderComposer({ onSubmit })
    fireEvent.change(box, { target: { value: 'Ask @a', selectionStart: 6 } })
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Ana Silva/ }))
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(await screen.findByText('Network down.')).toBeInTheDocument()
    const [body, mentions, key] = onSubmit.mock.calls[0]
    expect(body).toBe('Ask @Ana Silva')
    expect(mentions).toEqual(['u_ana'])
    expect(key).toEqual(expect.any(String))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1]).toEqual(['Ask @Ana Silva', ['u_ana'], key])
    await waitFor(() => expect(screen.queryByText('Network down.')).not.toBeInTheDocument())
  })

  it('gives each new comment a key of its own', async () => {
    const { box, onSubmit } = renderComposer()
    fireEvent.change(box, { target: { value: 'One' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument())
    fireEvent.change(box, { target: { value: 'Two' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    const calls = (onSubmit as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][2]).not.toBe(calls[1][2])
  })
})
