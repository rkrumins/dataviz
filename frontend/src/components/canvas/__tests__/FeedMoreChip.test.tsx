/**
 * FeedMoreChip — the Hierarchy/Graph views' way past their first page of roots.
 * It shows what is loaded and continues the open feeds; says when a page is in
 * flight or failed; and disappears once every feed is exhausted.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedMoreChip } from '../FeedMoreChip'
import { useCanvasStore, type TypeFeedState } from '@/store/canvas'

const feed = (over: Partial<TypeFeedState>): TypeFeedState => ({
  entityTypes: ['domain'], afterName: 'x', afterUrn: 'u', offset: 200, hasMore: true, epoch: 1, ...over,
})

describe('FeedMoreChip', () => {
  beforeEach(() => { useCanvasStore.getState().setGraph([], []) })

  it('continues every open feed and says how much is loaded', () => {
    useCanvasStore.getState().setTypeFeed('__roots__', feed({ offset: 200 }))
    useCanvasStore.getState().setTypeFeed('__orphans__', feed({ offset: 150, hasMore: false }))
    const onLoadMore = vi.fn()
    render(<FeedMoreChip loadingNodes={new Set()} failedNodes={new Set()} onLoadMore={onLoadMore} />)
    expect(screen.getByRole('button')).toHaveTextContent('350 loaded · Load more')
    fireEvent.click(screen.getByRole('button'))
    expect(onLoadMore).toHaveBeenCalledWith(['__roots__'])
  })

  it('offers a retry when the last page failed', () => {
    useCanvasStore.getState().setTypeFeed('__roots__', feed({}))
    render(<FeedMoreChip loadingNodes={new Set()} failedNodes={new Set(['TYPE:__roots__'])} onLoadMore={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent("Couldn't load more · Retry")
  })

  it('is disabled while a page is in flight', () => {
    useCanvasStore.getState().setTypeFeed('__roots__', feed({}))
    render(<FeedMoreChip loadingNodes={new Set(['TYPE:__roots__'])} failedNodes={new Set()} onLoadMore={vi.fn()} />)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('renders nothing once every feed is exhausted', () => {
    useCanvasStore.getState().setTypeFeed('__roots__', feed({ hasMore: false }))
    const { container } = render(<FeedMoreChip loadingNodes={new Set()} failedNodes={new Set()} onLoadMore={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
