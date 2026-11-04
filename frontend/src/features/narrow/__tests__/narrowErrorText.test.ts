/**
 * A refusal reads in the server's own words wherever it gave some: a stale edit,
 * a switch that is off, a view that can't do what was asked. Only a failure that
 * says nothing falls back to words of our own.
 */
import { describe, expect, it } from 'vitest'
import { narrowErrorText } from '../useNarrowResolve'

/** As `authFetch` throws: the friendly text as the message, the body's `detail` kept. */
const refused = (status: number, detail: unknown) =>
  Object.assign(new Error(typeof detail === 'string' ? detail : 'x'), { status, detail })

describe('narrowErrorText', () => {
  it("says what the server said: someone else's edit, a refusal, a switch that is off", () => {
    expect(narrowErrorText(refused(409, {
      reason: 'changed', message: "Someone changed this view's search. Review it and try again.",
    }))).toBe("Someone changed this view's search. Review it and try again.")
    expect(narrowErrorText(refused(422, 'Only a subset of a view can follow that view’s layers.')))
      .toBe('Only a subset of a view can follow that view’s layers.')
    expect(narrowErrorText(refused(403, {
      type: 'feature_disabled', feature: 'searchViewsEnabled', message: 'Subset views are turned off.',
    }))).toBe('Subset views are turned off.')
  })

  it("reads the graph provider's errors too, which carry the body in the message", () => {
    const err = Object.assign(new Error('API Error 409: {"detail":{"reason":"base_missing","message":"Its base view is gone."}}'),
      { status: 409 })
    expect(narrowErrorText(err)).toBe('Its base view is gone.')
  })

  it('falls back to its own words only when the server gave none', () => {
    expect(narrowErrorText(refused(429, { code: 'PROVIDER_BUSY', reason: 'every slot is scanning' })))
      .toBe('The graph is busy right now. Try again in a moment.')
    expect(narrowErrorText(new Error('boom'))).toBe('Couldn’t work out what to show. Try again.')
  })
})
