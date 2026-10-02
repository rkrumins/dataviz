/**
 * `showEdgeDirection` — arrowheads on lineage lines. A preference like every
 * other Display switch, so it is remembered across opens. The whole state
 * persists with a shallow merge, so a state stored before the key existed
 * keeps the default without a migration.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

beforeEach(() => {
  usePreferencesStore.setState(usePreferencesStore.getInitialState(), true)
})

describe('preferences — showEdgeDirection', () => {
  it('is on by default', () => {
    expect(usePreferencesStore.getState().showEdgeDirection).toBe(true)
  })

  it('a toggle is stored', () => {
    usePreferencesStore.getState().toggleEdgeDirection()
    expect(usePreferencesStore.getState().showEdgeDirection).toBe(false)
    const stored = JSON.parse(localStorage.getItem('nexus-preferences') ?? '{}')
    expect(stored.state.showEdgeDirection).toBe(false)
  })

  it('a state stored before the key existed keeps the default', async () => {
    localStorage.setItem('nexus-preferences', JSON.stringify({ state: { canvasDensity: 'compact' }, version: 10 }))
    await usePreferencesStore.persist.rehydrate()
    expect(usePreferencesStore.getState().canvasDensity).toBe('compact')
    expect(usePreferencesStore.getState().showEdgeDirection).toBe(true)
  })
})
