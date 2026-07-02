/**
 * DisplayMenu — RTL tests for the header's consolidated Canvas + Lineage
 * appearance popover: it opens on trigger click, both sections' controls
 * fire their callbacks, the Lineage-appearance section renders muted/inert
 * when Lineage is off, and Reset fires onReset.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DisplayMenu } from '../header/DisplayMenu'

function baseProps() {
  return {
    canvasZoom: 1,
    onSetCanvasZoom: vi.fn(),
    canvasDensity: 'spacious' as const,
    onSetCanvasDensity: vi.fn(),
    showTypeBadge: true,
    onToggleTypeBadge: vi.fn(),
    subtleTreeLines: false,
    onToggleSubtleTreeLines: vi.fn(),
    onReset: vi.fn(),
    lineageRenderMode: 'stubs' as const,
    onSetLineageRenderMode: vi.fn(),
    showEdgeDirection: false,
    onToggleEdgeDirection: vi.fn(),
    lineageEnabled: true,
  }
}

describe('DisplayMenu', () => {
  it('opens on trigger click', () => {
    render(<DisplayMenu {...baseProps()} />)
    expect(screen.queryByRole('dialog', { name: 'Display' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByRole('dialog', { name: 'Display' })).toBeInTheDocument()
    expect(screen.getByText('Canvas')).toBeInTheDocument()
    expect(screen.getByText('Lineage appearance')).toBeInTheDocument()
  })

  it('fires callbacks from both sections', () => {
    const props = baseProps()
    render(<DisplayMenu {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    // Canvas section — set density to compact.
    fireEvent.click(screen.getByRole('radio', { name: /compact/i }))
    expect(props.onSetCanvasDensity).toHaveBeenCalledWith('compact')

    // Lineage appearance section — toggle direction arrows.
    fireEvent.click(screen.getByRole('switch', { name: /arrow markers/i }))
    expect(props.onToggleEdgeDirection).toHaveBeenCalled()
  })

  it('renders the Lineage appearance section muted and inert when lineageEnabled is false', () => {
    const props = { ...baseProps(), lineageEnabled: false }
    render(<DisplayMenu {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText(/turn on lineage to adjust edge appearance/i)).toBeInTheDocument()

    const directionSwitch = screen.getByRole('switch', { name: /arrow markers/i })
    expect(directionSwitch).toBeDisabled()
    fireEvent.click(directionSwitch)
    expect(props.onToggleEdgeDirection).not.toHaveBeenCalled()

    const edgeDensityRadio = screen.getByRole('radio', { name: /adaptive/i })
    expect(edgeDensityRadio).toBeDisabled()
    fireEvent.click(edgeDensityRadio)
    expect(props.onSetLineageRenderMode).not.toHaveBeenCalled()
  })

  it('fires onReset when display settings are non-default', () => {
    const props = { ...baseProps(), canvasZoom: 1.25 }
    render(<DisplayMenu {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(props.onReset).toHaveBeenCalled()
  })
})
