/**
 * `traceLineMode` — how many of a trace's lines the Context View draws
 * follows the view until the reader chooses: On hover in the Business view,
 * every line in the Technical one. A choice, once made, holds in both.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { usePersonaStore } from '../persona'
import { usePreferencesStore } from '../preferences'
import { useTraceLineMode } from '../traceLineMode'

const resolved = () => renderHook(() => useTraceLineMode()).result.current

describe('useTraceLineMode', () => {
  afterEach(() => usePreferencesStore.setState({ traceLineMode: null }))

  it('is unset by default, so it follows the view', () => {
    expect(usePreferencesStore.getState().traceLineMode).toBeNull()
    usePersonaStore.setState({ mode: 'business' })
    expect(resolved()).toBe('stubs')
    usePersonaStore.setState({ mode: 'technical' })
    expect(resolved()).toBe('raw')
  })

  it('a choice wins in both views', () => {
    usePreferencesStore.getState().setTraceLineMode('auto')
    usePersonaStore.setState({ mode: 'business' })
    expect(resolved()).toBe('auto')
    usePersonaStore.setState({ mode: 'technical' })
    expect(resolved()).toBe('auto')
  })
})
