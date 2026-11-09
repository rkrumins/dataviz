/**
 * Deleted entities someone asked to see (Locate, "N deleted inside") are pinned, to be drawn past
 * the cap. The pins are bounded: at most PINNED_GHOSTS_MAX, the oldest ask dropped first, and a
 * pin asked for again is the newest, so the latest ask is never the one dropped. They belong to
 * the change set they were asked in: another one starts without them.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { PINNED_GHOSTS_MAX, useCanvasStore } from '../canvas'

const pins = () => useCanvasStore.getState().ghostPins

beforeEach(() => {
  useCanvasStore.setState({ ghostPins: [], ghostPinsOrigin: null, deletedHidden: new Map() })
})

describe('canvas store — ghost pins', () => {
  it('keeps each pin once, in the order asked', () => {
    useCanvasStore.getState().pinGhosts(['urn:a', 'urn:b', 'urn:a'])
    useCanvasStore.getState().pinGhosts(['urn:c'])
    expect(pins()).toEqual(['urn:a', 'urn:b', 'urn:c'])
  })

  it('makes a pin asked for again the newest, and leaves the list alone when nothing changes', () => {
    useCanvasStore.getState().pinGhosts(['urn:a', 'urn:b'])
    useCanvasStore.getState().pinGhosts(['urn:a'])
    expect(pins()).toEqual(['urn:b', 'urn:a'])

    const before = pins()
    useCanvasStore.getState().pinGhosts(['urn:a'])
    useCanvasStore.getState().pinGhosts([])
    expect(pins()).toBe(before)
  })

  it(`holds at most ${PINNED_GHOSTS_MAX}, dropping the oldest ask first`, () => {
    const many = Array.from({ length: PINNED_GHOSTS_MAX }, (_, i) => `urn:n${i}`)
    useCanvasStore.getState().pinGhosts(many)
    useCanvasStore.getState().pinGhosts(['urn:n0'])                   // asked again: kept
    useCanvasStore.getState().pinGhosts(['urn:new'])
    expect(pins()).toHaveLength(PINNED_GHOSTS_MAX)
    expect(pins()).not.toContain('urn:n1')
    expect(pins().slice(-2)).toEqual(['urn:n0', 'urn:new'])
  })

  it('keeps the pins for the change set they were asked in, and drops them for another', () => {
    const { pinGhosts, setGhostPinsOrigin } = useCanvasStore.getState()
    setGhostPinsOrigin('{"branchId":"d1"}')
    pinGhosts(['urn:a'])
    setGhostPinsOrigin('{"branchId":"d1"}')
    expect(pins()).toEqual(['urn:a'])
    setGhostPinsOrigin('{"fromSeq":3,"toSeq":9}')
    expect(pins()).toEqual([])
  })

  it('publishes the hidden counts only when they change', () => {
    const { setDeletedHidden } = useCanvasStore.getState()
    setDeletedHidden(new Map([['urn:db', 3]]))
    const first = useCanvasStore.getState().deletedHidden
    setDeletedHidden(new Map([['urn:db', 3]]))
    expect(useCanvasStore.getState().deletedHidden).toBe(first)
    setDeletedHidden(new Map([['urn:db', 2]]))
    expect(useCanvasStore.getState().deletedHidden.get('urn:db')).toBe(2)
  })
})
