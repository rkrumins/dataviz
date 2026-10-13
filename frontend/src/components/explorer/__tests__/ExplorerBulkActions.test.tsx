/**
 * The bar is centred on the column it is rendered in, not on the window, whose left
 * the sidebar takes. It used to sit right of centre: its slide-in animation replaced
 * the transform that centred it, leaving its left edge at the window's middle.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExplorerBulkActions } from '../ExplorerBulkActions'

describe('ExplorerBulkActions', () => {
  it('centres the bar on its column, with the centring off the animated element', () => {
    const column = document.createElement('div')
    column.getBoundingClientRect = () => ({ left: 260, width: 1180, top: 0, bottom: 900, right: 1440, height: 900, x: 260, y: 0, toJSON: () => ({}) })
    document.body.appendChild(column)

    render(<ExplorerBulkActions selectedCount={3} onChangeVisibility={() => {}} onClearSelection={() => {}} />, { container: column })

    const placed = screen.getByText('3 views selected').closest('.fixed') as HTMLElement
    expect(placed.style.left).toBe('850px')
    expect(placed.querySelector('[class*="translate"]')).toBeNull()
    column.remove()
  })
})
