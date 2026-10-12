/**
 * The memory gauge: quiet until the tab is heavy (or the reader pins it),
 * and "Free memory" gives back what can be refetched.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreferencesStore } from '@/store/preferences'
import { RELEASE_MEMORY_EVENT } from '@/lib/memoryEvents'
import { MemoryGauge } from '../MemoryGauge'

const MB = 1024 ** 2
function setHeap(usedMB: number) {
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    value: { usedJSHeapSize: usedMB * MB, totalJSHeapSize: usedMB * MB, jsHeapSizeLimit: 4096 * MB },
  })
}

beforeEach(() => usePreferencesStore.setState({ showMemoryUsage: false }))
afterEach(() => {
  delete (performance as unknown as { memory?: unknown }).memory
  vi.useRealTimers()
})

describe('MemoryGauge', () => {
  it('stays out of the way while the heap is comfortable', () => {
    setHeap(300)
    render(<MemoryGauge />)
    expect(screen.queryByText('Memory')).toBeNull()
  })

  it('shows itself once the heap is heavy', () => {
    setHeap(1400)
    render(<MemoryGauge />)
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('1.4 GB')).toBeInTheDocument()
  })

  it('is always there when the reader pins it', () => {
    setHeap(300)
    usePreferencesStore.setState({ showMemoryUsage: true })
    render(<MemoryGauge />)
    expect(screen.getByText('300 MB')).toBeInTheDocument()
  })

  it('shows nothing where the browser does not report memory', () => {
    usePreferencesStore.setState({ showMemoryUsage: true })
    render(<MemoryGauge />)
    expect(screen.queryByText('Memory')).toBeNull()
  })

  it('"Free memory" tells every rebuildable cache to let go', () => {
    setHeap(2300)
    const heard = vi.fn()
    window.addEventListener(RELEASE_MEMORY_EVENT, heard)
    render(<MemoryGauge />)
    fireEvent.click(screen.getByText('Memory'))
    act(() => { fireEvent.click(screen.getByText('Free memory')) })
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(RELEASE_MEMORY_EVENT, heard)
  })
})
