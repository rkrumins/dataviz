/**
 * Why a subset view lists nothing, said over the canvas — and, when its base is
 * gone, who can bring it back and where: never "restore that view" with no way to.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { SubsetIssueBanner } from '../SubsetIssueBanner'

describe('SubsetIssueBanner', () => {
  it('a base that is gone names who can restore it, and leads to where', () => {
    render(<MemoryRouter><SubsetIssueBanner issue="base_missing" /></MemoryRouter>)
    expect(screen.getByText('Its base view isn’t available')).toBeInTheDocument()
    expect(screen.getByText(/a workspace admin can restore one/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open deleted views/ })).toHaveAttribute('href', '/explorer?category=deleted')
  })

  it('a view made from a query, at a past revision, says it shows only what was placed by hand', () => {
    render(<MemoryRouter><SubsetIssueBanner issue="list_revision" /></MemoryRouter>)
    expect(screen.getByText('This revision shows only what was placed by hand')).toBeInTheDocument()
    expect(screen.getByText(/Go back to Published to see them/)).toBeInTheDocument()
  })

  it('says nothing when nothing is wrong', () => {
    const { container } = render(<MemoryRouter><SubsetIssueBanner issue={null} /></MemoryRouter>)
    expect(container).toBeEmptyDOMElement()
  })
})
