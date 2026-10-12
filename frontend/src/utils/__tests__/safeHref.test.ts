import { describe, it, expect } from 'vitest'
import { safeHref } from '../safeHref'

/**
 * The announcement CTA is admin-written and rendered to every signed-in
 * user, so a `javascript:` URL there is stored XSS against the platform.
 * The server refuses these on write; this covers rows already in the table
 * from before that validator existed.
 *
 * These cases mirror the server-side `_validated_cta_url` table in
 * `backend/common/models/management.py` — the two rules must not drift.
 */
describe('safeHref', () => {
  it.each([
    'https://docs.example.com/release-notes',
    'http://intranet.corp/notice',
    'HTTPS://SHOUTY.EXAMPLE/x',
    '/settings/announcements',
    '/',
  ])('allows %s', (url) => {
    expect(safeHref(url)).toBe(url.trim())
  })

  it.each([
    ['javascript: URL', 'javascript:alert(document.cookie)'],
    ['mixed-case scheme', 'JaVaScRiPt:alert(1)'],
    ['whitespace-padded scheme', '  javascript:alert(1)  '],
    ['data URL', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript URL', 'vbscript:msgbox(1)'],
    ['protocol-relative', '//evil.example/phish'],
    ['backslash relative', '/\\evil.example'],
    ['backslash protocol-relative', '/\\/evil.example'],
    ['bare word', 'evil.example'],
    ['mailto', 'mailto:someone@example.com'],
  ])('refuses a %s', (_label, url) => {
    expect(safeHref(url)).toBeNull()
  })

  it.each([null, undefined, '', '   '])('treats %s as absent', (url) => {
    expect(safeHref(url)).toBeNull()
  })

  it('trims a URL it accepts', () => {
    expect(safeHref('  https://example.com/x  ')).toBe('https://example.com/x')
  })
})
