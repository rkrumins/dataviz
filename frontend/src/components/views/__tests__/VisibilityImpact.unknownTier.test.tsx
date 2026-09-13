/**
 * VisibilityImpact — a tier this app does not know must not take the panel down.
 *
 * The database's domain is wider than the app's union. `ck_views_visibility`
 * permits 'public' alongside the three tiers the UI implements, and live rows
 * carry it. Indexing VISIBILITY_ACCENT by such a value yields `undefined`, and
 * reading `.chipBg` off it crashed the whole Details panel behind the route's
 * error boundary:
 *
 *   TypeError: Cannot read properties of undefined (reading 'chipBg')
 *     at VisibilityImpact (VisibilityImpact.tsx:143)
 *
 * The panel states what is known instead. It deliberately does NOT map the
 * value onto the nearest tier — 'public' may be MORE exposed than "anyone
 * signed in", and under-stating the audience is the one wrong answer on a
 * panel whose whole job is naming the audience.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VisibilityImpact } from '../VisibilityImpact'
import type { ViewVisibility } from '@/lib/viewVisibility'

// The cast is the point: this is a value the type system forbids and the
// database allows, which is exactly how it reached the component.
const UNKNOWN = 'public' as unknown as ViewVisibility

describe('VisibilityImpact with a tier the app does not implement', () => {
  it('renders instead of crashing', () => {
    expect(() =>
      render(<VisibilityImpact selected={UNKNOWN} counts={{ workspaceMemberCount: 12 }} />),
    ).not.toThrow()
    expect(screen.getByLabelText('Who will see this view')).toBeInTheDocument()
  })

  it('names the stored value rather than guessing a tier', () => {
    render(<VisibilityImpact selected={UNKNOWN} counts={{ workspaceMemberCount: 12 }} />)
    expect(screen.getByText(/isn’t one of the sharing options/)).toBeInTheDocument()
    expect(screen.getByText(/“public”/)).toBeInTheDocument()
  })

  it('claims no audience size, because it cannot know one', () => {
    render(<VisibilityImpact selected={UNKNOWN} counts={{ workspaceMemberCount: 12, platformUserCount: 400 }} />)
    expect(screen.queryByText(/About /)).not.toBeInTheDocument()
    expect(screen.queryByText(/12 people/)).not.toBeInTheDocument()
    expect(screen.queryByText(/400/)).not.toBeInTheDocument()
  })

  it('still renders every known tier as before', () => {
    for (const tier of ['private', 'workspace', 'enterprise'] as ViewVisibility[]) {
      const { unmount } = render(<VisibilityImpact selected={tier} counts={{ workspaceMemberCount: 12 }} />)
      expect(screen.getByLabelText('Who will see this view')).toBeInTheDocument()
      expect(screen.queryByText(/isn’t one of the sharing options/)).not.toBeInTheDocument()
      unmount()
    }
  })
})
