/**
 * The last screen before a Context View exists says, once and quietly, whether it is meant to
 * show everything in its source — and lets that be changed. A complete view is offered each new
 * top-level entity on the canvas as it arrives; a specialised one never is. The Layout step
 * infers which from the suggestion the layers were made with; here it is a switch, on for an
 * inferred complete view and free to turn on for any Context View.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../../ViewWizard'

vi.mock('@/hooks/usePublishGate', () => ({ usePublishGate: () => ({ canPublish: true }) }))

import { PreviewStep } from '../PreviewStep'

const SWITCH = 'Keep it complete — offer new top-level entities as they arrive'

function makeFormData(over: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'V', description: '', icon: 'Layout', visibility: 'private', tags: [],
    layoutType: 'reference', layers: [{ id: 'l1', name: 'Domains', entityTypes: ['domain'], order: 0 }], assignments: {},
    visibleEntityTypes: [], visibleRelationshipTypes: [], advancedFilters: [],
    isValid: true, ...over,
  }
}

describe('PreviewStep — whether the view is meant to show everything', () => {
  it('is on for a view inferred complete, and turning it off makes it specialised', () => {
    const updateFormData = vi.fn()
    render(<PreviewStep formData={makeFormData({ coverage: 'complete' })} updateFormData={updateFormData} />)
    const toggle = screen.getByRole('switch', { name: SWITCH })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Each new one is offered on the canvas, never added for you. Leave it off for a view of part of the source.'))
      .toBeInTheDocument()
    fireEvent.click(toggle)
    expect(updateFormData).toHaveBeenCalledWith({ coverage: 'specialised' })
  })

  it('is off for any other Context View, and can be turned on', () => {
    const updateFormData = vi.fn()
    const { unmount } = render(<PreviewStep formData={makeFormData({ coverage: 'specialised' })} updateFormData={updateFormData} />)
    expect(screen.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'false')
    unmount()

    // A view that never said, opened for an edit: off, and on at a click.
    render(<PreviewStep formData={makeFormData()} updateFormData={updateFormData} />)
    const toggle = screen.getByRole('switch', { name: SWITCH })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(updateFormData).toHaveBeenLastCalledWith({ coverage: 'complete' })
  })

  it('only a Context View carries it, and an import (which saves the file’s view) is not offered it', () => {
    const { unmount } = render(<PreviewStep formData={makeFormData({ layoutType: 'graph', layers: [] })} updateFormData={vi.fn()} />)
    expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull()
    unmount()
    render(<PreviewStep formData={makeFormData({ coverage: 'complete' })} />)
    expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull()
  })
})
