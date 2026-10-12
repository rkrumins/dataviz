/**
 * `lineagePortSides` — which side of a card marks its incoming and outgoing
 * lineage (lineagePorts.ts). Incoming left, outgoing right by default (the
 * user's choice, 2026-09-28); the old "where lines attach" rule stays one
 * click away. The whole state persists with a shallow merge, so a state
 * stored before the key existed takes the default without a migration.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferencesStore } from '../preferences'

beforeEach(() => {
  usePreferencesStore.setState(usePreferencesStore.getInitialState(), true)
})

describe('preferences — lineagePortSides', () => {
  it('is incoming left, outgoing right by default', () => {
    expect(usePreferencesStore.getState().lineagePortSides).toBe('direction')
  })

  it('a choice is stored', () => {
    usePreferencesStore.getState().setLineagePortSides('lines')
    expect(usePreferencesStore.getState().lineagePortSides).toBe('lines')
    const stored = JSON.parse(localStorage.getItem('nexus-preferences') ?? '{}')
    expect(stored.state.lineagePortSides).toBe('lines')
  })

  it('a state stored before the key existed takes the default', async () => {
    localStorage.setItem('nexus-preferences', JSON.stringify({ state: { canvasDensity: 'compact' }, version: 10 }))
    await usePreferencesStore.persist.rehydrate()
    expect(usePreferencesStore.getState().canvasDensity).toBe('compact')
    expect(usePreferencesStore.getState().lineagePortSides).toBe('direction')
  })
})
