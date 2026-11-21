/**
 * The bridge the AI assistant reaches the mounted Context View canvas through: one canvas at a
 * time, by view; leaving unregisters only what it registered; a request for a view not open
 * waits for that view's canvas, and runs once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canvasActions, canvasActionsFor, registerCanvasActions, subscribeCanvasActions, whenCanvasShows,
  type CanvasActions,
} from '@/store/canvasActionsBridge'

const unregister: Array<() => void> = []
afterEach(() => { while (unregister.length) unregister.pop()!() })

function actionsFor(viewId: string): CanvasActions {
  return {
    viewId,
    reveal: vi.fn(), locateMany: vi.fn(), startTrace: vi.fn(), runSearch: vi.fn(), openCypher: vi.fn(),
    getContext: () => ({ viewId, selectedUrns: [] }),
  }
}

describe('canvasActionsBridge', () => {
  it('holds the mounted canvas, by its view, until it leaves', () => {
    const a = actionsFor('v1')
    const leave = registerCanvasActions(a)
    expect(canvasActions()).toBe(a)
    expect(canvasActionsFor('v1')).toBe(a)
    expect(canvasActionsFor('v2')).toBeNull()
    expect(canvasActionsFor(null)).toBeNull()
    leave()
    expect(canvasActions()).toBeNull()
  })

  it('a canvas leaving after another arrived does not take the newcomer with it', () => {
    const leaveOld = registerCanvasActions(actionsFor('v1'))
    const b = actionsFor('v2')
    unregister.push(registerCanvasActions(b))
    leaveOld()
    expect(canvasActions()).toBe(b)
  })

  it('tells subscribers when a canvas arrives and leaves', () => {
    const heard = vi.fn()
    const stop = subscribeCanvasActions(heard)
    const leave = registerCanvasActions(actionsFor('v1'))
    leave()
    stop()
    registerCanvasActions(actionsFor('v1'))()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('runs on the canvas at once when it shows the view', () => {
    const a = actionsFor('v1')
    unregister.push(registerCanvasActions(a))
    expect(whenCanvasShows('v1', (c) => c.openCypher('MATCH (n) RETURN n'))).toBe(true)
    expect(a.openCypher).toHaveBeenCalledWith('MATCH (n) RETURN n')
  })

  it('otherwise waits for that view’s canvas, and runs once it is there', async () => {
    vi.useFakeTimers()
    try {
      expect(whenCanvasShows('v9', (c) => c.openCypher('MATCH (n) RETURN n'))).toBe(false)
      const other = actionsFor('v1')
      unregister.push(registerCanvasActions(other))
      const target = actionsFor('v9')
      unregister.push(registerCanvasActions(target))
      await vi.runAllTimersAsync()
      expect(other.openCypher).not.toHaveBeenCalled()
      expect(target.openCypher).toHaveBeenCalledTimes(1)
      // Spent: the next canvas of that view does not run it again.
      const again = actionsFor('v9')
      unregister.push(registerCanvasActions(again))
      await vi.runAllTimersAsync()
      expect(again.openCypher).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
