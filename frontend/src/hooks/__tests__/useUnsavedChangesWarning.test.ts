/**
 * useUnsavedChangesWarning — guards against losing unsaved work when the
 * user closes the tab, refreshes, or navigates the browser away from the
 * page. The native `beforeunload` prompt is only armed while there are
 * genuinely unsaved changes, and is torn down as soon as there aren't (or
 * on unmount) so a saved session never nags the user.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useUnsavedChangesWarning } from '../useUnsavedChangesWarning'

let addSpy: ReturnType<typeof vi.spyOn>
let removeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  addSpy = vi.spyOn(window, 'addEventListener')
  removeSpy = vi.spyOn(window, 'removeEventListener')
})

afterEach(() => {
  addSpy.mockRestore()
  removeSpy.mockRestore()
})

const beforeUnloadCalls = (spy: typeof addSpy) =>
  spy.mock.calls.filter(([event]) => event === 'beforeunload')

describe('useUnsavedChangesWarning', () => {
  it('does not arm the prompt when there are no unsaved changes', () => {
    renderHook(() => useUnsavedChangesWarning(false))
    expect(beforeUnloadCalls(addSpy)).toHaveLength(0)
  })

  it('arms the beforeunload prompt while there are unsaved changes', () => {
    renderHook(() => useUnsavedChangesWarning(true))
    expect(beforeUnloadCalls(addSpy)).toHaveLength(1)
  })

  it('cancels the unload event so the browser shows its confirm dialog', () => {
    renderHook(() => useUnsavedChangesWarning(true))
    const handler = beforeUnloadCalls(addSpy)[0][1] as EventListener
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    const prevented = !window.dispatchEvent(event)
    expect(prevented).toBe(true)
  })

  it('disarms the prompt once changes are saved', () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedChangesWarning(dirty), {
      initialProps: { dirty: true },
    })
    expect(beforeUnloadCalls(addSpy)).toHaveLength(1)

    rerender({ dirty: false })
    expect(beforeUnloadCalls(removeSpy)).toHaveLength(1)
  })

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useUnsavedChangesWarning(true))
    unmount()
    expect(beforeUnloadCalls(removeSpy)).toHaveLength(1)
  })
})
