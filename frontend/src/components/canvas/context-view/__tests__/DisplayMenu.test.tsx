/**
 * DisplayMenu — RTL tests for the header's consolidated Canvas + Lineage
 * appearance popover: it opens on trigger click, both sections' controls
 * fire their callbacks, the Lineage-appearance section renders muted/inert
 * when Lineage is off, Reset fires onReset, and Line weight — in either
 * view — stores the weight lines are drawn at.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisplayMenu } from '../header/DisplayMenu'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'

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
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Canvas density' })).getByRole('radio', { name: /compact/i }))
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
    expect(await screen.findByText('Put the canvas settings back to their defaults')).toBeInTheDocument()
    expect(screen.getByText(
      'Zoom, density, header size, icons, IDs, badges, off-screen markers, tree lines, the memory gauge and empty layers',
    )).toBeInTheDocument()
    usePreferencesStore.setState({ showMemoryUsage: false })
  })

  it('Show entity IDs is on by default, says where the ID sits, and hides them', () => {
    usePreferencesStore.setState({ showCanvasEntityIds: true })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const ids = screen.getByRole('switch', { name: /Show entity IDs/ })
    expect(ids).toHaveAttribute('aria-checked', 'true')
    expect(ids).toHaveTextContent('Each entity’s ID under its name — beside it at the minimal density.')
    // On by default, so it is counted among the options that are on, and offers no Reset.
    expect(screen.getByRole('button', { name: /Display options/ })).toHaveTextContent('4 on')
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()

    fireEvent.click(ids)
    expect(usePreferencesStore.getState().showCanvasEntityIds).toBe(false)
    expect(ids).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: /Display options/ })).toHaveTextContent('3 on')
    // Hidden IDs are a change from the defaults: Reset offers itself.
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    usePreferencesStore.setState({ showCanvasEntityIds: true })
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

  it('has no Advanced section when the host does not wire the orphans panel', () => {
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /orphaned entities/i })).not.toBeInTheDocument()
  })

  it('Advanced → Orphaned entities… closes the menu and opens the panel', () => {
    const onOpenOrphans = vi.fn()
    render(<DisplayMenu {...baseProps()} onOpenOrphans={onOpenOrphans} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('Advanced')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Orphaned entities…' }))
    expect(onOpenOrphans).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Display' })).not.toBeInTheDocument()
  })
})

describe('DisplayMenu — Business view', () => {
  it('is the canvas and how many lines it draws, with nothing about how they look', () => {
    usePersonaStore.setState({ mode: 'business' })
    render(<DisplayMenu {...baseProps()} onOpenOrphans={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('Canvas')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /adaptive/i })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /arrow markers/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Marker sides' })).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Orphaned entities/ })).not.toBeInTheDocument()
  })

  it('has no entity IDs switch — the Business view shows no IDs — and offers no Reset for IDs hidden in Technical', () => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ showCanvasEntityIds: false })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.queryByRole('switch', { name: /Show entity IDs/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
    usePreferencesStore.setState({ showCanvasEntityIds: true })
  })

  it('offers lines that point back in either view, off until turned on, with an alert colour', () => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ highlightBackPointers: false, backPointerColor: '#ef4444' })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    const toggle = screen.getByRole('switch', { name: /highlight lines that point back/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(usePreferencesStore.getState().highlightBackPointers).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Amber' }))
    expect(usePreferencesStore.getState().backPointerColor).toBe('#f59e0b')
    usePreferencesStore.setState({ highlightBackPointers: false, backPointerColor: '#ef4444' })
  })
})

describe('DisplayMenu — Business view, in plain words', () => {
  it('says how many lines it draws, with no engine names and no budget', () => {
    usePersonaStore.setState({ mode: 'business' })
    render(<DisplayMenu {...baseProps()} lineageRenderMode="auto" />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('How many lines')).toBeInTheDocument()
    expect(screen.getByText(/How many lines the canvas draws at once\./)).toBeInTheDocument()
    expect(screen.getByText('A trace draws every line it walks, whatever this is set to.')).toBeInTheDocument()
    expect(screen.queryByText(/\((Stubs|Auto|Raw)\)/)).not.toBeInTheDocument()
    expect(screen.queryByText('Edge Budget')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /All lines/ })).toBeInTheDocument()
    // Screen readers hear the same plain name.
    expect(screen.getByRole('radiogroup', { name: 'How many lines' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Edge density' })).not.toBeInTheDocument()
  })

  it('on Adaptive, offers no budget, and no ribbons or memory switch while they are off', () => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ showFlowRibbons: false, showMemoryUsage: false })
    render(<DisplayMenu {...baseProps()} lineageRenderMode="auto" />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.queryByRole('slider', { name: 'Adaptive edge budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /flow ribbons/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /show memory usage/i })).not.toBeInTheDocument()
  })

  it('keeps a switch that is on, so it can be turned off', () => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ showFlowRibbons: true, showMemoryUsage: true })
    render(<DisplayMenu {...baseProps()} lineageRenderMode="auto" />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    fireEvent.click(screen.getByRole('switch', { name: /flow ribbons/i }))
    expect(usePreferencesStore.getState().showFlowRibbons).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: /show memory usage/i }))
    expect(usePreferencesStore.getState().showMemoryUsage).toBe(false)
  })

  it('keeps the lineage colours', () => {
    usePersonaStore.setState({ mode: 'business' })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByRole('radiogroup', { name: 'Lineage colours' })).toBeInTheDocument()
  })

  it('offers the missing-link alerts, on by default, and turns them off', () => {
    usePersonaStore.setState({ mode: 'business' })
    usePreferencesStore.setState({ showMissingConnectionIndicators: true })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const alerts = screen.getByRole('switch', { name: /missing-link alerts/i })
    expect(alerts).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(alerts)
    expect(usePreferencesStore.getState().showMissingConnectionIndicators).toBe(false)
    usePreferencesStore.setState({ showMissingConnectionIndicators: true })
  })

  it('says what turning Lineage on is for', () => {
    usePersonaStore.setState({ mode: 'business' })
    render(<DisplayMenu {...baseProps()} lineageEnabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('Turn on Lineage to change how lines are drawn')).toBeInTheDocument()
  })
})

describe('DisplayMenu — Minimal density', () => {
  it('offers Minimal first, the tightest, and choosing it stores the density', () => {
    const setCanvasDensity = usePreferencesStore.getState().setCanvasDensity
    render(<DisplayMenu {...baseProps()} onSetCanvasDensity={setCanvasDensity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const options = within(screen.getByRole('radiogroup', { name: 'Canvas density' })).getAllByRole('radio')
    expect(options.map((o) => o.textContent)).toEqual(['Minimal', 'Compact', 'Comfortable', 'Spacious'])

    fireEvent.click(screen.getByRole('radio', { name: 'Minimal' }))
    expect(usePreferencesStore.getState().canvasDensity).toBe('minimal')
    usePreferencesStore.setState({ canvasDensity: 'spacious' })
  })
  it('says the type badge is not shown on Minimal rows', () => {
    render(<DisplayMenu {...baseProps()} canvasDensity="minimal" />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    expect(screen.getByText('Not shown on Minimal rows')).toBeInTheDocument()
  })
})

describe('DisplayMenu — Line weight', () => {
  it.each(['technical', 'business'] as const)('offers Thin, Regular and Thick in the %s view, and stores the choice', (mode) => {
    usePersonaStore.setState({ mode })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const group = screen.getByRole('radiogroup', { name: 'Line weight' })
    expect(within(group).getAllByRole('radio').map((o) => o.textContent)).toEqual(['Thin', 'Regular', 'Thick'])
    expect(within(group).getByRole('radio', { name: 'Regular' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Thick' }))
    expect(usePreferencesStore.getState().lineWeight).toBe('thick')
    usePreferencesStore.setState({ lineWeight: 'regular' })
    usePersonaStore.setState({ mode: 'technical' })
  })
})

describe('DisplayMenu — layer headers, off-screen markers and empty layers', () => {
  afterEach(() => {
    usePreferencesStore.getState().resetCanvasDisplaySettings()
    usePersonaStore.setState({ mode: 'technical' })
  })

  it.each(['technical', 'business'] as const)('offers all three in the %s view, at today’s defaults, with no Reset', (mode) => {
    usePersonaStore.setState({ mode })
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const sizes = screen.getByRole('radiogroup', { name: 'Header size' })
    expect(within(sizes).getAllByRole('radio').map((o) => o.textContent)).toEqual(['Compact', 'Comfortable', 'Spacious'])
    expect(within(sizes).getByRole('radio', { name: 'Comfortable' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /Show off-screen markers/ })).toHaveAttribute('aria-checked', 'true')
    const empty = screen.getByRole('radiogroup', { name: 'Empty layers' })
    expect(within(empty).getAllByRole('radio').map((o) => o.querySelector('.leading-tight')?.textContent))
      .toEqual(['Always', 'Not while tracing', 'Never'])
    expect(within(empty).getByRole('radio', { name: /^Always/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('A column built around an entity that is gone always says why.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
  })

  it('stores a header size, and says it in the section’s summary', () => {
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Header size' })).getByRole('radio', { name: 'Compact' }))
    expect(usePreferencesStore.getState().canvasHeaderSize).toBe('compact')
    expect(screen.getByRole('button', { name: /Header size/ })).toHaveTextContent('Compact')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
  })

  it('turns the off-screen markers off, and counts them among the options that are on', () => {
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const markers = screen.getByRole('switch', { name: /Show off-screen markers/ })
    expect(screen.getByRole('button', { name: /Display options/ })).toHaveTextContent('4 on')
    fireEvent.click(markers)
    expect(usePreferencesStore.getState().showOffscreenLineMarkers).toBe(false)
    expect(markers).toHaveAttribute('aria-checked', 'false')
    expect(markers).toHaveTextContent('No count at a column’s top or bottom')
    expect(screen.getByRole('button', { name: /Display options/ })).toHaveTextContent('3 on')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
  })

  it('stores when an empty layer says so', () => {
    render(<DisplayMenu {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))

    const empty = screen.getByRole('radiogroup', { name: 'Empty layers' })
    fireEvent.click(within(empty).getByRole('radio', { name: /^Not while tracing/ }))
    expect(usePreferencesStore.getState().emptyLayerMessage).toBe('tracing-hidden')
    expect(screen.getByRole('button', { name: /Empty layers/ })).toHaveTextContent('Not while tracing')
    fireEvent.click(within(empty).getByRole('radio', { name: /^Never/ }))
    expect(usePreferencesStore.getState().emptyLayerMessage).toBe('never')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
  })
})
