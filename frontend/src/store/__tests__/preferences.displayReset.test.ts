/**
 * Display › Canvas › Reset puts the whole Canvas section back — the memory
 * gauge, the entity IDs, the header size, the off-screen markers and empty
 * layers sit in that section, so they are part of what Reset covers.
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

  it('shows hidden entity IDs again', () => {
    usePreferencesStore.setState({ showCanvasEntityIds: false })
    usePreferencesStore.getState().resetCanvasDisplaySettings()
    expect(usePreferencesStore.getState().showCanvasEntityIds).toBe(true)
  })

  it('puts the header size, the off-screen markers and empty layers back as they have always been', () => {
    const initial = usePreferencesStore.getInitialState()
    expect(initial.canvasHeaderSize).toBe('comfortable')
    expect(initial.showOffscreenLineMarkers).toBe(true)
    expect(initial.emptyLayerMessage).toBe('always')

    usePreferencesStore.setState({ canvasHeaderSize: 'compact', showOffscreenLineMarkers: false, emptyLayerMessage: 'never' })
    usePreferencesStore.getState().resetCanvasDisplaySettings()
    const after = usePreferencesStore.getState()
    expect(after.canvasHeaderSize).toBe('comfortable')
    expect(after.showOffscreenLineMarkers).toBe(true)
    expect(after.emptyLayerMessage).toBe('always')
  })

  it('stores each choice', () => {
    const store = usePreferencesStore.getState()
    store.setCanvasHeaderSize('spacious')
    store.toggleOffscreenLineMarkers()
    store.setEmptyLayerMessage('tracing-hidden')
    const after = usePreferencesStore.getState()
    expect(after.canvasHeaderSize).toBe('spacious')
    expect(after.showOffscreenLineMarkers).toBe(false)
    expect(after.emptyLayerMessage).toBe('tracing-hidden')
    after.resetCanvasDisplaySettings()
  })
})
