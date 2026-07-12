import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'

vi.mock('./DataSourceProfile', () => ({ DataSourceProfile: () => <div data-testid="profile" /> }))

import { DataSourceProfileDrawer } from './DataSourceProfileDrawer'

describe('DataSourceProfileDrawer', () => {
  it('renders the profile when open and closes on the close button', async () => {
    const onClose = vi.fn()
    render(<DataSourceProfileDrawer catalogId="cat-1" isOpen onClose={onClose} />)
    expect(screen.getByTestId('profile')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<DataSourceProfileDrawer catalogId={null} isOpen={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
