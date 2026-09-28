/**
 * DisplayMenu — RTL tests for the header's consolidated Canvas + Lineage
 * appearance popover: it opens on trigger click, both sections' controls
 * fire their callbacks, the Lineage-appearance section renders muted/inert
 * when Lineage is off, and Reset fires onReset.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DisplayMenu } from '../header/DisplayMenu'
import { usePreferencesStore } from '@/store/preferences'

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

  it('Reset is offered when only the memory gauge is pinned, and says what it puts back', async () => {
    usePreferencesStore.setState({ showMemoryUsage: true })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const reset = screen.getByRole('button', { name: 'Reset' })
    fireEvent.focus(reset)
    expect(await screen.findByText(
      'Put zoom, density, icons, badges, tree lines and the memory gauge back to their defaults',
    )).toBeInTheDocument()
    usePreferencesStore.setState({ showMemoryUsage: false })
  })

  it('On Hover shows the per-entity cap, and the slider sets it', () => {
    usePreferencesStore.setState({ autoStubThreshold: 500 })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const slider = screen.getByRole('slider', { name: 'Lines per entity' })
    expect(screen.getByText(/The most lines a hovered or selected entity draws at once/)).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '300' } })
    expect(usePreferencesStore.getState().autoStubThreshold).toBe(300)
  })

  it('Adaptive keeps its edge budget, and says it caps a focused entity too', () => {
    render(<DisplayMenu {...baseProps()} lineageRenderMode="auto" />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByRole('slider', { name: 'Adaptive edge budget' })).toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Lines per entity' })).not.toBeInTheDocument()
    expect(screen.getByText(/the most a hovered or selected entity draws/)).toBeInTheDocument()
  })

  it('the Edge Density section says a trace draws every line', () => {
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('A trace draws every line it walks, whatever this is set to.')).toBeInTheDocument()
  })

  it('Marker sides: incoming left, outgoing right by default; a choice is stored', () => {
    usePreferencesStore.setState({ lineagePortSides: 'direction' })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const sides = screen.getByRole('radiogroup', { name: 'Marker sides' })
    const byDirection = within(sides).getByRole('radio', { name: /Incoming left, outgoing right/ })
    const byLines = within(sides).getByRole('radio', { name: /Where lines attach/ })
    expect(byDirection).toHaveAttribute('aria-checked', 'true')
    // A line within one column moves only its outgoing end: its incoming
    // end still plugs into the left edge, where its marker is.
    expect(byDirection).toHaveTextContent('Each side shows one direction; a line running right to left, or out to a card in the same column, plugs into the other edge.')
    expect(byLines).toHaveTextContent('A marker sits where its lines plug in; lines within a column meet on the left.')

    fireEvent.click(byLines)
    expect(usePreferencesStore.getState().lineagePortSides).toBe('lines')
    expect(byLines).toHaveAttribute('aria-checked', 'true')
    expect(byDirection).toHaveAttribute('aria-checked', 'false')
    // A Lineage setting, like the rest of that section: the Canvas section's
    // Reset neither offers itself for it nor puts it back.
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
    usePreferencesStore.setState({ lineagePortSides: 'direction' })
  })

  it('Marker sides are inert while Lineage is off', () => {
    usePreferencesStore.setState({ lineagePortSides: 'direction' })
    render(<DisplayMenu {...baseProps()} lineageEnabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const byLines = within(screen.getByRole('radiogroup', { name: 'Marker sides' })).getByRole('radio', { name: /Where lines attach/ })
    expect(byLines).toBeDisabled()
    fireEvent.click(byLines)
    expect(usePreferencesStore.getState().lineagePortSides).toBe('direction')
  })
})
