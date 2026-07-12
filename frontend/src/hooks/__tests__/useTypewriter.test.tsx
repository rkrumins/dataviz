import { render, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

import { useTypewriter } from '../useTypewriter'

/**
 * Locks useTypewriter's performance contract as an executable invariant.
 *
 * This animation ticks every 22–70ms forever while the search field sits idle.
 * When it was driven by `useState` it re-rendered the entire ExplorerPage (and
 * every result card) ~30x/second — and React 19's DEV build emits a
 * `performance.measure()` per render into a timeline it never clears, so an
 * "idle" tab accumulated millions of retained PerformanceMeasure objects and
 * climbed to multiple GB of RAM.
 *
 * The fix is that the hook holds NO React state: it writes to the DOM via refs.
 * If someone reintroduces state here, this test fails loudly rather than the
 * leak quietly coming back.
 */
describe('useTypewriter — performance contract', () => {
  it('animates through the DOM and NEVER re-renders its consumer', async () => {
    let renderCount = 0

    function Consumer() {
      renderCount += 1
      const { textRef, caretRef } = useTypewriter({
        phrases: ['hello world'],
        enabled: true,
      })
      return (
        <>
          <span data-testid="tw-text" ref={textRef} />
          <span data-testid="tw-caret" ref={caretRef} />
        </>
      )
    }

    const { getByTestId } = render(<Consumer />)
    const rendersAfterMount = renderCount

    // Wait for it to actually type (proves the animation still works at all).
    await waitFor(
      () => expect(getByTestId('tw-text').textContent).not.toBe(''),
      { timeout: 2000 },
    )

    // Let it keep ticking for a good while — dozens of keystrokes.
    await new Promise((resolve) => setTimeout(resolve, 400))

    const typed = getByTestId('tw-text').textContent ?? ''
    expect(typed.length).toBeGreaterThan(0)
    expect('hello world').toContain(typed) // it's typing a prefix of the phrase

    // THE CONTRACT: dozens of ticks, zero additional renders.
    expect(renderCount).toBe(rendersAfterMount)
  })

  it('clears the text and stops when disabled', async () => {
    function Consumer({ enabled }: { enabled: boolean }) {
      const { textRef, caretRef } = useTypewriter({ phrases: ['abc'], enabled })
      return (
        <>
          <span data-testid="tw-text" ref={textRef} />
          <span data-testid="tw-caret" ref={caretRef} />
        </>
      )
    }

    const { getByTestId, rerender } = render(<Consumer enabled />)
    await waitFor(() => expect(getByTestId('tw-text').textContent).not.toBe(''))

    rerender(<Consumer enabled={false} />)
    await waitFor(() => expect(getByTestId('tw-text').textContent).toBe(''))
  })
})
