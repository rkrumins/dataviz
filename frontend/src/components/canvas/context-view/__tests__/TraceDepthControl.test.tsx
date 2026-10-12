/**
 * ONE DEPTH RULE (F2). The walk fetches to 25 hops per direction and no
 * further — `TraceClosureRequest` caps it there and `FULL_WALK_INITIAL_DEPTH`
 * asks for exactly that — and the closure engine then follows its frontiers
 * to exhaustion. So 25 is not "the default depth", it is EVERY HOP THERE IS,
 * and the control's old 'Deep' (50) and 'Max' (100) presets promised a deeper
 * fetch that no code has made since the native engine landed: they set a
 * bigger number, the picture did not change, and the reader was left to
 * conclude their lineage stopped there.
 *
 * The control is capped at 25 and says what depth actually does now: narrow
 * the view over a flow already in hand, instantly, with no refetch.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TraceDepthControl } from '../TraceDepthControl'
import { usePreferencesStore } from '@/store/preferences'

function open(upstream = 25, downstream = 25) {
  const onChange = vi.fn()
  render(<TraceDepthControl upstreamDepth={upstream} downstreamDepth={downstream} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: /^depth/i }))
  return onChange
}

describe('TraceDepthControl — the one depth rule', () => {
  it('offers no depth above 25, on any preset or any slider', () => {
    open()
    const presets = screen.getAllByRole('button', { name: /\d+\s*\/\s*\d+/ })
    expect(presets.length).toBeGreaterThan(0)
    for (const preset of presets) {
      const [up, down] = (preset.textContent?.match(/(\d+)\/(\d+)/) ?? []).slice(1).map(Number)
      expect(up).toBeLessThanOrEqual(25)
      expect(down).toBeLessThanOrEqual(25)
    }
    for (const slider of screen.getAllByRole('slider')) {
      expect(Number(slider.getAttribute('max'))).toBe(25)
    }
  })

  it('says what depth does now: narrows the view, no refetch', () => {
    open()
    expect(screen.getByText(/all 25 walked hops/i)).toBeInTheDocument()
    expect(screen.getByText(/no refetch/i)).toBeInTheDocument()
  })

  it('the top preset is every walked hop, and it applies both sides', () => {
    const onChange = open(1, 1)
    fireEvent.click(screen.getByRole('button', { name: /all hops/i }))
    expect(onChange).toHaveBeenCalledWith('upstream', 25)
    expect(onChange).toHaveBeenCalledWith('downstream', 25)
  })

  it('wears the lineage direction pair: upstream is in, downstream is out', () => {
    render(<TraceDepthControl upstreamDepth={3} downstreamDepth={7} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /^depth/i })
    expect(within(trigger).getByText('3').getAttribute('class')).toMatch(/\btext-lineage-in\b/)
    expect(within(trigger).getByText('7').getAttribute('class')).toMatch(/\btext-lineage-out\b/)
    expect(trigger.querySelector('.lucide-arrow-up')!.getAttribute('class')).toMatch(/\btext-lineage-in\b/)
    expect(trigger.querySelector('.lucide-arrow-down')!.getAttribute('class')).toMatch(/\btext-lineage-out\b/)

    fireEvent.click(trigger)
    expect(screen.getByText('Upstream').getAttribute('class')).toMatch(/\btext-lineage-in\b/)
    expect(screen.getByText('Downstream').getAttribute('class')).toMatch(/\btext-lineage-out\b/)
    expect(screen.getByLabelText('Upstream depth slider').getAttribute('class')).toMatch(/\bbg-lineage-in\/15\b/)
    expect(screen.getByLabelText('Downstream depth slider').getAttribute('class')).toMatch(/\bbg-lineage-out\/15\b/)
  })

  it('clamps a typed value to the walked ceiling', () => {
    const onChange = open()
    fireEvent.change(screen.getByLabelText('Upstream depth'), { target: { value: '80' } })
    expect(onChange).toHaveBeenCalledWith('upstream', 25)
  })
})

describe('TraceDepthControl — the trace settings live here', () => {
  it('carries the Display switch: "Lineage counts on cards", ON by default, persisted', () => {
    usePreferencesStore.setState({ showLineageCounts: true })
    open()
    expect(screen.getByRole('dialog', { name: 'Trace settings' })).toBeInTheDocument()
    const sw = screen.getByRole('switch', { name: 'Lineage counts on cards' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(usePreferencesStore.getState().showLineageCounts).toBe(false)
    expect(screen.getByRole('switch', { name: 'Lineage counts on cards' }).getAttribute('aria-checked')).toBe('false')
    usePreferencesStore.setState({ showLineageCounts: true })
  })
})
