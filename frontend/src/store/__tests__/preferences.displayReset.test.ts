/**
 * Display › Canvas › Reset puts the whole Canvas section back — the memory
 * gauge sits in that section, so it is part of what Reset covers.
 */
import { describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

describe('preferences — resetCanvasDisplaySettings', () => {
  it('turns a pinned memory gauge off', () => {
    usePreferencesStore.setState({ showMemoryUsage: true, canvasZoom: 1.5 })
    usePreferencesStore.getState().resetCanvasDisplaySettings()
    expect(usePreferencesStore.getState().showMemoryUsage).toBe(false)
    expect(usePreferencesStore.getState().canvasZoom).toBe(1)
  })
})
