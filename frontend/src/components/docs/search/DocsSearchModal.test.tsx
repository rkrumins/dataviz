/**
 * Search everything, against the real docs and guide: what a reader sees
 * after typing, where Enter takes them, and what the dialog offers before
 * they have typed anything.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { DEFAULT_BRANDING } from '@/store/branding'
import { useReadingStore } from '@/components/docs/reading/readingStore'

vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { recordEvent } from '@/services/telemetryService'
import { getIndex } from './useDocsSearchIndex'
import { DocsSearchModal } from './DocsSearchModal'

function Location() {
  const { pathname, hash } = useLocation()
  return <div data-testid="location">{`${pathname}${hash}`}</div>
}

function open(initialQuery = '', area: 'docs' | 'guide' = 'docs') {
  const onClose = vi.fn()
  render(
    <MemoryRouter initialEntries={[`/${area}`]}>
      <Location />
      <DocsSearchModal open onClose={onClose} area={area} initialQuery={initialQuery} />
    </MemoryRouter>,
  )
  return { onClose, input: screen.getByRole('combobox') as HTMLInputElement }
}

const options = () => screen.getAllByRole('option')

beforeAll(async () => {
  await getIndex(DEFAULT_BRANDING)
}, 60_000)

beforeEach(() => {
  useReadingStore.setState({ recentSearches: [] })
  vi.mocked(recordEvent).mockClear()
})

describe('Search everything', () => {
  it('starts from the text it was opened with, and lists the page with the section that answers', async () => {
    const { input } = open('load demo data')
    expect(input.value).toBe('load demo data')
    await waitFor(() => expect(options().length).toBeGreaterThan(0))
    const best = options()[0]
    expect(best).toHaveTextContent('Developer Setup')
    expect(best).toHaveTextContent('Load demo data')
    expect(best).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the highlighted result at its section, and remembers the search', async () => {
    const { input, onClose } = open('load demo data')
    await waitFor(() => expect(options().length).toBeGreaterThan(0))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('location')).toHaveTextContent('/docs/setup#load-demo-data')
    expect(onClose).toHaveBeenCalled()
    expect(useReadingStore.getState().recentSearches).toEqual(['load demo data'])
  })

  it('moves the highlight with the arrow keys and closes on Escape', async () => {
    const { input, onClose } = open('kubernetes')
    await waitFor(() => expect(options().length).toBeGreaterThan(2))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', options()[1].id)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('narrows to one reader with its tab', async () => {
    open('password')
    await waitFor(() => expect(options().length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('tab', { name: /^User Guide/ }))
    const groups = screen.getAllByRole('group')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) {
      expect(within(g).getAllByRole('option')[0]).toHaveTextContent(/User Guide ·/)
    }
  })

  it('offers recent searches and popular journeys before anything is typed', () => {
    useReadingStore.setState({ recentSearches: ['sso'] })
    const { input } = open('', 'guide')
    expect(screen.getByText('Recent searches')).toBeInTheDocument()
    expect(screen.getByText('Popular in the User Guide')).toBeInTheDocument()
    fireEvent.click(screen.getByText('sso'))
    expect(input.value).toBe('sso')
  })

  it('says when nothing matches, and records the gap once the query settles', async () => {
    open('zzqqxv')
    await waitFor(() => expect(screen.getByText(/No results for “zzqqxv”/)).toBeInTheDocument())
    await waitFor(() => expect(recordEvent).toHaveBeenCalledWith('docs.search_miss', { query: 'zzqqxv', source: 'docs-modal' }), { timeout: 3000 })
  })
})
