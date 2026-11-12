/**
 * The Context View's left rail holds search results or a review's list, one at a time: opening one
 * closes the other, and each keeps its own state. A review is the Context View's only while it is
 * mounted; leaving it ends the review.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useReviewStore } from '@/store/reviewStore'
import { useReviewRail } from '../useReviewRail'

const closeSearch = vi.fn()
const mount = (searchOpen = false) =>
  renderHook(({ open }) => useReviewRail(open, closeSearch), { initialProps: { open: searchOpen } })

beforeEach(() => {
  closeSearch.mockReset()
  // The list opens with a review here: this person keeps it open.
  useReviewStore.setState({ available: false, navigatorOpen: false, listOpen: false, listPreferred: true, scope: null, operation: null, filter: {} })
})

describe('useReviewRail', () => {
  it('makes a review available while the Context View is mounted, and ends it on leaving', () => {
    const { unmount } = mount()
    expect(useReviewStore.getState().available).toBe(true)
    act(() => useReviewStore.getState().startReview({ operation: 'removed' }))
    unmount()
    expect(useReviewStore.getState()).toMatchObject({ available: false, navigatorOpen: false, listOpen: false })
  })

  it('closes the search panel when the review opens', () => {
    const { result } = mount(true)
    expect(closeSearch).not.toHaveBeenCalled()
    act(() => useReviewStore.getState().startReview())
    expect(closeSearch).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(true)
  })

  it('closes the review when the search panel opens, keeping what it showed', () => {
    const { rerender, result } = mount(false)
    act(() => useReviewStore.getState().startReview({ operation: 'added' }))
    rerender({ open: true })
    expect(result.current).toBe(false)
    expect(useReviewStore.getState().operation).toBe('added')
    expect(closeSearch).toHaveBeenCalledTimes(1)                        // only when the review opened
  })
})
