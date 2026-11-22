/**
 * lineWeight — how wide the canvas draws a lineage line: a trace draws its lines at their usual
 * width (it picks its own out by colour, opacity and glow), a highlight still stands out and a
 * dimmed line still recedes, and the reader's Line weight scales every one of them. Regular is the
 * default, and is today's look.
 */
import { describe, expect, it } from 'vitest'
import { usePreferencesStore } from '@/store/preferences'
import { LINE_WEIGHT_SCALE, lineStrokeWidth } from '../lineWeight'

describe('lineStrokeWidth', () => {
  it('draws a line at its usual width, a highlighted one heavier, a dimmed or faint one lighter', () => {
    expect(lineStrokeWidth(1.8, 'idle')).toBeCloseTo(1.35)
    expect(lineStrokeWidth(1.8, 'highlighted')).toBeCloseTo(2.8)
    expect(lineStrokeWidth(1.8, 'dimmed')).toBe(1)
    expect(lineStrokeWidth(1.8, 'faint')).toBeCloseTo(1.26)
  })

  it('scales every width by the Line weight, thin to thick', () => {
    for (const state of ['idle', 'highlighted', 'dimmed', 'faint'] as const) {
      const regular = lineStrokeWidth(2.2, state, 'regular')
      expect(lineStrokeWidth(2.2, state, 'thin')).toBeCloseTo(regular * LINE_WEIGHT_SCALE.thin)
      expect(lineStrokeWidth(2.2, state, 'thick')).toBeCloseTo(regular * LINE_WEIGHT_SCALE.thick)
    }
    expect(LINE_WEIGHT_SCALE.thin).toBeLessThan(1)
    expect(LINE_WEIGHT_SCALE.thick).toBeGreaterThan(1)
  })

  it('is Regular until the reader chooses', () => {
    expect(usePreferencesStore.getInitialState().lineWeight).toBe('regular')
    usePreferencesStore.getState().setLineWeight('thin')
    expect(usePreferencesStore.getState().lineWeight).toBe('thin')
    usePreferencesStore.setState({ lineWeight: 'regular' })
  })
})
