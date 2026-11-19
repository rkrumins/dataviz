/**
 * changeListRetry — a change list the server is still preparing (503 busy, 504 past the request's
 * time, or the connection dropped) is asked for again for minutes, with a growing wait; any other
 * failure once, as every query is.
 */
import { describe, expect, it } from 'vitest'
import { changeListRetry, changeListRetryDelay } from '../useVersioning'

const withStatus = (status: number) => Object.assign(new Error('x'), { status })

describe('changeListRetry', () => {
  it('keeps asking while the server prepares the list', () => {
    for (const e of [withStatus(503), withStatus(504), new TypeError('Failed to fetch')]) {
      expect(changeListRetry(0, e)).toBe(true)
      expect(changeListRetry(23, e)).toBe(true)
      expect(changeListRetry(24, e)).toBe(false)
    }
  })

  it('asks once more for anything else', () => {
    for (const e of [withStatus(404), withStatus(409), new Error('boom')]) {
      expect(changeListRetry(0, e)).toBe(true)
      expect(changeListRetry(1, e)).toBe(false)
    }
  })

  it('waits longer each time, never more than eight seconds', () => {
    expect([0, 1, 2, 3, 10].map(changeListRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000])
  })
})
