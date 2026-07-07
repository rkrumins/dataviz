/**
 * ViewTitleMenu — RTL tests.
 *
 * Calm-view rule: a user with no view-level capability sees a plain title —
 * no chevron, no menu, no rename. With rights the title gains a chevron that
 * opens a small menu (Edit details… / Share…, each independently gated) plus
 * a read-only visibility row, and double-click inline rename that commits on
 * Enter and cancels on Escape. The component also owns the subline's sync
 * spinner + retry affordance absorbed from the header.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewTitleMenu, type ViewTitleMenuProps } from '../header/ViewTitleMenu'

function baseProps(overrides: Partial<ViewTitleMenuProps> = {}): ViewTitleMenuProps {
  return {
    viewName: 'Data Landscape',
    subline: '4 types · Enterprise Blueprint',
    canEditView: false,
    canShareView: false,
    onRenameView: vi.fn(),
    onEditViewDetails: vi.fn(),
    onShareView: vi.fn(),
    syncStatus: 'idle',
    onRetrySync: vi.fn(),
    ...overrides,
  }
}

describe('ViewTitleMenu — calm view (no capabilities)', () => {
  it('renders a plain title: no chevron, no rename affordance', () => {
    const props = baseProps()
    render(<ViewTitleMenu {...props} />)

    expect(screen.getByText('Data Landscape')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View options' })).not.toBeInTheDocument()

    // Double-click must NOT swap the title to an input.
    fireEvent.dblClick(screen.getByText('Data Landscape'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(props.onRenameView).not.toHaveBeenCalled()
  })
})

describe('ViewTitleMenu — menu (independently gated items)', () => {
  it('gives an editor the chevron + Edit details…, and no Share…', () => {
    const props = baseProps({ canEditView: true })
    render(<ViewTitleMenu {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.queryByRole('menuitem', { name: /share/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /edit details/i }))
    expect(props.onEditViewDetails).toHaveBeenCalledTimes(1)
  })

  it('gives a sharer Share… and a read-only visibility row, and no Edit details…', () => {
    const props = baseProps({ canShareView: true, viewVisibility: 'workspace' })
    render(<ViewTitleMenu {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /edit details/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /share/i }))
    expect(props.onShareView).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    render(<ViewTitleMenu {...baseProps({ canEditView: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('closes on outside click', async () => {
    render(<ViewTitleMenu {...baseProps({ canEditView: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})

describe('ViewTitleMenu — inline rename', () => {
  it('pre-fills the input and commits a trimmed new name on Enter, then closes', () => {
    const props = baseProps({ canEditView: true })
    render(<ViewTitleMenu {...props} />)

    fireEvent.dblClick(screen.getByText('Data Landscape'))
    const input = screen.getByRole('textbox')
    expect(input).toHaveValue('Data Landscape')

    fireEvent.change(input, { target: { value: '  New name  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRenameView).toHaveBeenCalledTimes(1)
    expect(props.onRenameView).toHaveBeenCalledWith('New name')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('cancels on Escape, restoring the original title with no call', () => {
    const props = baseProps({ canEditView: true })
    render(<ViewTitleMenu {...props} />)

    fireEvent.dblClick(screen.getByText('Data Landscape'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(props.onRenameView).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Data Landscape')).toBeInTheDocument()
  })

  it('is a no-op for an unchanged or whitespace-only name', () => {
    const props = baseProps({ canEditView: true })
    render(<ViewTitleMenu {...props} />)

    // Unchanged.
    fireEvent.dblClick(screen.getByText('Data Landscape'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(props.onRenameView).not.toHaveBeenCalled()

    // Whitespace-only.
    fireEvent.dblClick(screen.getByText('Data Landscape'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onRenameView).not.toHaveBeenCalled()
  })
})

describe('ViewTitleMenu — sync subline (absorbed from the header)', () => {
  it('shows a spinner while saving', () => {
    render(<ViewTitleMenu {...baseProps({ syncStatus: 'saving' })} />)
    expect(screen.getByLabelText('Saving changes')).toBeInTheDocument()
  })

  it('offers a retry affordance on sync error', () => {
    const props = baseProps({ syncStatus: 'error' })
    render(<ViewTitleMenu {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /sync issue — retry/i }))
    expect(props.onRetrySync).toHaveBeenCalledTimes(1)
  })
})
