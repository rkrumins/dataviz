/**
 * HeaderSearch / HeaderSearchResults — RTL tests for the header's quick
 * search field and its results/escalation slot: typing fires
 * onSearchChange, the escalation link seeds Advanced Search with the
 * trimmed query, and the no-match card renders (with a working CTA) only
 * when the query is non-empty and there are zero results.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeaderSearch, HeaderSearchResults } from '../header/HeaderSearch'
import type { HierarchyNode } from '../types'

function makeNode(id: string, name: string): HierarchyNode {
  // Only `id` and `name` are read by HeaderSearchResults; the rest of the
  // interface is irrelevant to this test.
  return { id, name } as unknown as HierarchyNode
}

describe('HeaderSearch', () => {
  it('fires onSearchChange when typing', () => {
    const onSearchChange = vi.fn()
    render(<HeaderSearch searchQuery="" onSearchChange={onSearchChange} />)

    fireEvent.change(screen.getByPlaceholderText('Search visible entities…'), {
      target: { value: 'orders' },
    })

    expect(onSearchChange).toHaveBeenCalledWith('orders')
  })

  it('seeds Advanced Search with the trimmed query via the escalation link', () => {
    const onOpenAdvancedSearch = vi.fn()
    render(
      <HeaderSearch
        searchQuery="  orders  "
        onSearchChange={vi.fn()}
        onOpenAdvancedSearch={onOpenAdvancedSearch}
      />,
    )

    fireEvent.click(screen.getByText(/search "orders" across entire graph/i))

    expect(onOpenAdvancedSearch).toHaveBeenCalledWith('orders')
  })
})

describe('HeaderSearchResults', () => {
  it('renders nothing when the query is empty', () => {
    const { container } = render(
      <HeaderSearchResults
        searchQuery=""
        searchResults={[]}
        onSearchResultClick={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the no-match escalation card when query is non-empty with zero results, and its CTA fires with the seed', () => {
    const onOpenAdvancedSearch = vi.fn()
    render(
      <HeaderSearchResults
        searchQuery="orders"
        searchResults={[]}
        onSearchResultClick={vi.fn()}
        onOpenAdvancedSearch={onOpenAdvancedSearch}
      />,
    )

    expect(screen.getByText('No match in visible entities')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /advanced search/i }))
    expect(onOpenAdvancedSearch).toHaveBeenCalledWith('orders')
  })

  it('renders result chips and fires onSearchResultClick', () => {
    const onSearchResultClick = vi.fn()
    const node = makeNode('n1', 'Orders Table')
    render(
      <HeaderSearchResults
        searchQuery="orders"
        searchResults={[node]}
        onSearchResultClick={onSearchResultClick}
      />,
    )

    fireEvent.click(screen.getByText('Orders Table'))
    expect(onSearchResultClick).toHaveBeenCalledWith(node)
  })
})
