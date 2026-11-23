/**
 * `lineageRenderMode` — the canvas's edge density. A stored value is trusted
 * only when this build draws it: one written by a newer build (or a mode since
 * retired) falls back to the default instead of leaving the canvas with a
 * density it has no branch for. Everything else stored still comes back.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

beforeEach(() => {
  usePreferencesStore.setState(usePreferencesStore.getInitialState(), true)
})

const stored = (state: Record<string, unknown>) =>
  localStorage.setItem('nexus-preferences', JSON.stringify({ state, version: 11 }))

describe('preferences — lineageRenderMode', () => {
  it('keeps On Click, as it keeps every density it draws', async () => {
    stored({ lineageRenderMode: 'click' })
    await usePreferencesStore.persist.rehydrate()
    expect(usePreferencesStore.getState().lineageRenderMode).toBe('click')
  })

  it('a density this build does not know falls back to On Hover, and nothing else is lost', async () => {
    stored({ lineageRenderMode: 'telepathic', canvasDensity: 'compact' })
    await usePreferencesStore.persist.rehydrate()
    expect(usePreferencesStore.getState().lineageRenderMode).toBe('stubs')
    expect(usePreferencesStore.getState().canvasDensity).toBe('compact')
  })
})
