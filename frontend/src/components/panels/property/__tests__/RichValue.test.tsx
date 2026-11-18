/**
 * A property's value reads as what it is: numbers grouped, Yes/No, a calendar date on its own day
 * (not the day before west of Greenwich), an instant as a time, a link by its site, an id as a chip,
 * a status as a badge — and nothing as "Not set".
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RichValue } from '../RichValue'
import { linkLabel } from '../valueWidgets'

describe('RichValue', () => {
  it('groups numbers and says yes or no', () => {
    const { rerender } = render(<RichValue value={1250000} />)
    expect(screen.getByText((1250000).toLocaleString())).toBeInTheDocument()
    rerender(<RichValue value={true} />)
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    rerender(<RichValue value={false} />)
    expect(screen.getByText('No')).toBeInTheDocument()
  })

  it('reads a number in the unit its key names', () => {
    render(<RichValue value={2048} fieldKey="size_bytes" />)
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  it('shows a calendar date on its own day', () => {
    render(<RichValue value="2026-03-01" />)
    const label = new Date(2026, 2, 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows an instant as a time, not an ISO string', () => {
    render(<RichValue value="2024-01-15T09:30:00Z" />)
    expect(screen.queryByText('2024-01-15T09:30:00Z')).not.toBeInTheDocument()
  })

  it('names a link by its site and page', () => {
    expect(linkLabel('https://www.example.com/docs/guides/report?x=1')).toBe('example.com/…/report…')
    expect(linkLabel('https://example.com/')).toBe('example.com')
    render(<RichValue value="https://example.com/a/b/report" />)
    expect(screen.getByRole('link', { name: /example\.com\/…\/report/ })).toHaveAttribute('href', 'https://example.com/a/b/report')
  })

  it('shows an id as a chip that copies, and a status as a badge', () => {
    const { rerender } = render(<RichValue value="agg_3f9c0a1b2c3d" />)
    expect(screen.getByRole('button', { name: 'Copy agg_3f9c0a1b2c3d' })).toBeInTheDocument()
    rerender(<RichValue value="failed" />)
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('keeps words as written, and says Not set for nothing', () => {
    const { rerender } = render(<RichValue value="Finance team" />)
    expect(screen.getByText('Finance team')).toBeInTheDocument()
    for (const empty of [null, '', []]) {
      rerender(<RichValue value={empty} />)
      expect(screen.getByText('Not set')).toBeInTheDocument()
    }
  })

  it('shows the text as stored in the source view', () => {
    render(<RichValue value="**bold**" source />)
    expect(screen.getByText('**bold**')).toBeInTheDocument()
  })
})
