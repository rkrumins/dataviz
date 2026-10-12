/**
 * A calendar day is not always 24 hours: across a daylight-saving change it is 23
 * or 25. Day arithmetic done in milliseconds lands on the wrong date there, and a
 * "past 7 days" that silently starts an hour early or a day late is the kind of
 * error nobody notices. This file pins a zone with DST and checks the bounds
 * across the European autumn change (25 October 2026).
 */
process.env.TZ = 'Europe/London'

import { describe, expect, it } from 'vitest'
import { ruleBounds, ruleDays } from '../dateFilter'

// Vitest isolates each file, but whether a zone set at runtime takes effect
// depends on the runtime; skip rather than assert something untrue.
const zoned = new Date(2026, 6, 1).getTimezoneOffset() !== new Date(2026, 11, 1).getTimezoneOffset()

describe.skipIf(!zoned)('date rules across a DST change', () => {
  it('keeps whole calendar days on both sides of the change', () => {
    expect(ruleDays('7d', '2026-10-28')).toEqual({ from: '2026-10-22', to: '2026-10-28' })
  })

  it('starts at local midnight in summer time and ends at local midnight in winter time', () => {
    const b = ruleBounds('7d', '2026-10-28')!
    // 22 Oct 00:00 BST = 21 Oct 23:00 UTC; 29 Oct 00:00 GMT = 29 Oct 00:00 UTC.
    expect(b.after).toBe('2026-10-21T23:00:00.000Z')
    expect(b.before).toBe('2026-10-29T00:00:00.000Z')
  })
})
