/**
 * "Filter pages" in a reader's sidebar, against the real docs: it finds a
 * page by what the page says — not only its title — links straight to the
 * sections that matched, and works from the keyboard.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DEFAULT_BRANDING } from '@/store/branding'
import { getIndex } from '@/components/docs/search/useDocsSearchIndex'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { GuideSidebar } from '@/components/guide/GuideSidebar'
import { ReaderContext } from './ReaderContext'

function Location() {
  const { pathname, hash } = useLocation()
  return <div data-testid="location">{`${pathname}${hash}`}</div>
}

function renderSidebar(area: 'docs' | 'guide', openSearch = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[`/${area}/${area === 'docs' ? 'setup' : 'welcome'}`]}>
      <ReaderContext.Provider value={{ area, openSearch }}>
        <Routes>
          <Route
            path={`/${area}/:slug`}
            element={<>{area === 'docs' ? <DocsSidebar /> : <GuideSidebar />}<Location /></>}
          />
        </Routes>
      </ReaderContext.Provider>
    </MemoryRouter>,
  )
  return { input: screen.getByPlaceholderText('Filter pages') as HTMLInputElement, openSearch }
}

const results = () => within(screen.getByRole('listbox', { name: 'Matching pages' })).getAllByRole('option')

beforeAll(async () => {
  await getIndex(DEFAULT_BRANDING)
}, 60_000)

describe('Filter pages', () => {
  it('finds pages by what they say, with links to the sections that matched', async () => {
    const { input } = renderSidebar('docs')
    fireEvent.change(input, { target: { value: 'kubectl' } })
    await waitFor(() => expect(results().length).toBeGreaterThan(1))
    const hrefs = results().map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/docs/kubernetes')
    expect(hrefs.some((h) => h?.startsWith('/docs/kubernetes#'))).toBe(true)
    expect(screen.getByText(/pages? match/)).toBeInTheDocument()
  })

  it('stays inside its own reader', async () => {
    const { input } = renderSidebar('guide')
    fireEvent.change(input, { target: { value: 'favourite' } })
    await waitFor(() => expect(results().length).toBeGreaterThan(0))
    expect(results().every((a) => a.getAttribute('href')?.startsWith('/guide'))).toBe(true)
  })

  it('opens the highlighted result with Enter, then gets out of the way', async () => {
    const { input } = renderSidebar('docs')
    fireEvent.change(input, { target: { value: 'kubectl' } })
    await waitFor(() => expect(results().length).toBeGreaterThan(1))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const target = results()[1].getAttribute('href')
    expect(results()[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('location')).toHaveTextContent(target!)
    expect(input.value).toBe('')
  })

  it('clears on Escape, and hands the query to Search everything on Shift+Enter', async () => {
    const { input, openSearch } = renderSidebar('docs')
    fireEvent.change(input, { target: { value: 'sso' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(openSearch).toHaveBeenCalledWith('sso')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
  })

  it('says so when nothing matches, and offers Search everything', async () => {
    const { input, openSearch } = renderSidebar('docs')
    fireEvent.change(input, { target: { value: 'zzqqxv' } })
    await waitFor(() => expect(screen.getByText('No pages match “zzqqxv”')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search everything for “zzqqxv”'))
    expect(openSearch).toHaveBeenCalledWith('zzqqxv')
  })
})
