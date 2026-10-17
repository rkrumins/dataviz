/**
 * withReason — the reason rides in one header, safely encoded, on changes only.
 */
import { describe, expect, it } from 'vitest'

import { REASON_HEADER, withReason } from '../activityReason'

const header = (init: RequestInit) => new Headers(init.headers).get(REASON_HEADER)

describe('withReason', () => {
    it('percent-encodes the reason into its header, keeping the headers already set', () => {
        const init = withReason({ method: 'POST', headers: { 'X-Other': '1' } }, '  Q3 close — re-run ✓  ')
        expect(header(init)).toBe(encodeURIComponent('Q3 close — re-run ✓'))
        expect(new Headers(init.headers).get('X-Other')).toBe('1')
        expect(decodeURIComponent(header(init)!)).toBe('Q3 close — re-run ✓')
    })

    it('leaves the request untouched when there is no reason, or it is a read', () => {
        const post = { method: 'POST' }
        expect(withReason(post, undefined)).toBe(post)
        expect(withReason(post, '   ')).toBe(post)
        expect(header(withReason({}, 'why'))).toBeNull()                    // GET by default
        expect(header(withReason({ method: 'get' }, 'why'))).toBeNull()
        expect(header(withReason({ method: 'DELETE' }, 'why'))).toBe('why')
    })

    it('keeps at most 500 characters, counted as characters rather than UTF-16 halves', () => {
        const long = '😀'.repeat(600)
        const sent = decodeURIComponent(header(withReason({ method: 'POST' }, long))!)
        expect(Array.from(sent)).toHaveLength(500)
        expect(sent.endsWith('😀')).toBe(true)                              // never half an emoji
    })

    it('never fails the change over a broken character in its note', () => {
        const broken = 'half \uD83D emoji'
        expect(() => withReason({ method: 'POST' }, broken)).not.toThrow()
        expect(decodeURIComponent(header(withReason({ method: 'POST' }, broken))!)).toBe('half � emoji')
    })
})
