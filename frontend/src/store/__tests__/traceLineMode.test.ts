/**
 * `traceLineMode` — how many of a trace's lines the Context View draws, a
 * choice per view: On hover in the Business view, every line in the Technical
 * one, until the reader chooses. A choice is the view's own. What an earlier
 * build stored (one choice for both views, or none) is carried over, and a
 * value nothing wrote reads as the view's default.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { usePersonaStore } from '../persona'
import { DEFAULT_TRACE_LINE_MODE, usePreferencesStore } from '../preferences'
import { chooseTraceLineMode, useTraceLineMode } from '../traceLineMode'

const resolved = () => renderHook(() => useTraceLineMode()).result.current
const migrate = (persisted: unknown, version: number) =>
  usePreferencesStore.persist.getOptions().migrate!(persisted, version) as Record<string, unknown>

describe('useTraceLineMode', () => {
  afterEach(() => usePreferencesStore.getState().resetTraceLines())

  it('each view starts on its own: On hover for Business, every line for Technical', () => {
    expect(usePreferencesStore.getState().traceLineMode).toEqual({ business: 'stubs', technical: 'raw' })
    usePersonaStore.setState({ mode: 'business' })
    expect(resolved()).toBe('stubs')
    usePersonaStore.setState({ mode: 'technical' })
    expect(resolved()).toBe('raw')
  })

  it('a Business choice leaves the Technical one alone', () => {
    usePreferencesStore.getState().setTraceLineMode('business', 'auto')
    expect(usePreferencesStore.getState().traceLineMode).toEqual({ business: 'auto', technical: 'raw' })
    usePersonaStore.setState({ mode: 'business' })
    expect(resolved()).toBe('auto')
    usePersonaStore.setState({ mode: 'technical' })
    expect(resolved()).toBe('raw')
  })

  it('chooses for the view you are in', () => {
    usePersonaStore.setState({ mode: 'technical' })
    chooseTraceLineMode('auto')
    expect(usePreferencesStore.getState().traceLineMode).toEqual({ business: 'stubs', technical: 'auto' })
    usePersonaStore.setState({ mode: 'business' })
    chooseTraceLineMode('raw')
    expect(usePreferencesStore.getState().traceLineMode).toEqual({ business: 'raw', technical: 'auto' })
  })

  it('follows the view as it switches', () => {
    usePreferencesStore.getState().setTraceLineMode('technical', 'auto')
    usePersonaStore.setState({ mode: 'business' })
    const { result } = renderHook(() => useTraceLineMode())
    expect(result.current).toBe('stubs')
    act(() => usePersonaStore.setState({ mode: 'technical' }))
    expect(result.current).toBe('auto')
  })

  it('reads a value that is not a choice per view as each view’s default', () => {
    for (const stored of [null, 'auto', 7]) {
      usePreferencesStore.setState({ traceLineMode: stored as never })
      usePersonaStore.setState({ mode: 'business' })
      expect(resolved()).toBe('stubs')
      usePersonaStore.setState({ mode: 'technical' })
      expect(resolved()).toBe('raw')
    }
  })

  it('Reset puts both views and both budgets back, 500 lines each', () => {
    const prefs = usePreferencesStore.getState()
    expect(prefs.traceLinesKept).toBe(500)
    expect(prefs.traceLinesPerCard).toBe(500)
    prefs.setTraceLineMode('business', 'raw')
    prefs.setTraceLineMode('technical', 'stubs')
    prefs.setTraceLinesKept(40)
    prefs.setTraceLinesPerCard(5)
    expect(usePreferencesStore.getState()).toMatchObject({ traceLinesKept: 40, traceLinesPerCard: 5 })

    usePreferencesStore.getState().resetTraceLines()
    expect(usePreferencesStore.getState()).toMatchObject({
      traceLineMode: { business: 'stubs', technical: 'raw' }, traceLinesKept: 500, traceLinesPerCard: 500,
    })
  })
})

describe('preferences — a trace’s Lines choice, as an earlier build stored it', () => {
  it('one choice for both views becomes each view’s', () => {
    expect(migrate({ traceLineMode: 'auto' }, 11).traceLineMode).toEqual({ business: 'auto', technical: 'auto' })
    expect(migrate({ traceLineMode: 'raw' }, 11).traceLineMode).toEqual({ business: 'raw', technical: 'raw' })
  })

  it('none (null), or a value it does not know, becomes each view’s default', () => {
    expect(migrate({ traceLineMode: null }, 11).traceLineMode).toEqual(DEFAULT_TRACE_LINE_MODE)
    expect(migrate({ traceLineMode: 'every' }, 11).traceLineMode).toEqual(DEFAULT_TRACE_LINE_MODE)
    expect(migrate({}, 10).traceLineMode).toEqual(DEFAULT_TRACE_LINE_MODE)
  })

  it('nothing else moves, and a choice made since is kept', () => {
    expect(migrate({ traceLineMode: 'raw', canvasFoldLayers: true }, 11).canvasFoldLayers).toBe(true)
    const since = { business: 'raw', technical: 'stubs' }
    expect(migrate({ traceLineMode: since }, 12).traceLineMode).toEqual(since)
  })
})
