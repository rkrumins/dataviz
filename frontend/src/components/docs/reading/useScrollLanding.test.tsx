/**
 * Where a page opens in the reader: at the section its link names, at the
 * top otherwise, and — when the next article is still loading — at the
 * section once it arrives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { useState } from 'react'
import { ScrollContainerContext } from './ScrollContainerContext'
import { useScrollLanding } from './useScrollLanding'

function Page({ content }: { content: string }) {
  useScrollLanding(true, content)
  return (
    <div>
      <h2 id="intro">Intro</h2>
      {content === 'with-target' && <h2 id="target">Target</h2>}
    </div>
  )
}

let setContent: (c: string) => void = () => {}

function Frame() {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [content, set] = useState('plain')
  setContent = set
  return (
    <ScrollContainerContext.Provider value={container}>
      <div ref={setContainer} data-testid="main">
        {container && <Page content={content} />}
      </div>
    </ScrollContainerContext.Provider>
  )
}

function setup(initial = '/a') {
  const router = createMemoryRouter([{ path: '*', element: <Frame /> }], { initialEntries: [initial] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => vi.restoreAllMocks())

describe('useScrollLanding', () => {
  it('opens a new page at the top', async () => {
    const router = setup()
    const main = screen.getByTestId('main')
    main.scrollTop = 800
    await act(() => router.navigate('/b'))
    expect(main.scrollTop).toBe(0)
  })

  it('opens at the section the link names, and marks it', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const router = setup()
    await act(() => router.navigate('/b#intro'))
    const intro = document.getElementById('intro')!
    expect(scroll.mock.contexts).toContain(intro)
    expect(intro).toHaveClass('reader-landed')
  })

  it('lands once the new article arrives, when the old one was still on screen', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const router = setup()
    await act(() => router.navigate('/next#target'))
    expect(document.getElementById('target')).toBeNull()
    act(() => setContent('with-target'))
    const target = document.getElementById('target')!
    expect(scroll.mock.contexts).toContain(target)
    expect(target).toHaveClass('reader-landed')
  })
})
